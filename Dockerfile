# syntax=docker/dockerfile:1
#
# 小筑生产镜像：一个部署容器内运行 FastAPI 与 Node 沙箱 Worker 两个进程。
# 前端、管理后台、Worker 和固定预览模板都在镜像构建期完成安装/编译；线上任务
# 只运行 Vite build，不会在 2G 服务器上临时安装依赖。

# ─────────────────────────────────────────────────────────────
# Node 22 + pnpm 公共构建基础
# ─────────────────────────────────────────────────────────────
FROM crpi-a7p27yxlrmekg1a3.cn-beijing.personal.cr.aliyuncs.com/elin-common/node:22 AS node-base

# Node 22 官方镜像自带 Corepack。固定 pnpm 版本，避免不同构建节点解析锁文件时漂移。
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
RUN corepack enable && corepack install --global pnpm@10.32.1


# ─────────────────────────────────────────────────────────────
# 阶段 1：构建前台与管理后台（Node 22 + pnpm + Vite）
# ─────────────────────────────────────────────────────────────
FROM node-base AS ui-builder
WORKDIR /app

# 先拷依赖清单以复用安装层缓存；pnpm 工作区需要看见所有成员的 package.json。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY web/package.json ./web/package.json
COPY web-admin/package.json ./web-admin/package.json
COPY sandbox-worker/package.json ./sandbox-worker/package.json
RUN pnpm install --frozen-lockfile \
  --filter xiaozhu-frontend... \
  --filter xiaozhu-web-admin...

COPY web/ ./web/
COPY web-admin/ ./web-admin/
RUN pnpm run build && pnpm run build:admin


# ─────────────────────────────────────────────────────────────
# 阶段 2：把 TypeScript Worker 编译成生产 JavaScript
# ─────────────────────────────────────────────────────────────
FROM node-base AS worker-builder
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY web/package.json ./web/package.json
COPY web-admin/package.json ./web-admin/package.json
COPY sandbox-worker/package.json ./sandbox-worker/package.json
RUN pnpm install --frozen-lockfile --filter xiaozhu-sandbox-worker...

COPY sandbox-worker/ ./sandbox-worker/
RUN pnpm run build:worker


# ─────────────────────────────────────────────────────────────
# 阶段 3：准备固定的沙箱模板依赖
# ─────────────────────────────────────────────────────────────
FROM node-base AS sandbox-builder
WORKDIR /opt/template

# 模板使用独立锁文件，整个 node_modules 连同 pnpm 虚拟存储一起复制到运行镜像，
# 不依赖工作区根目录，避免符号链接在多阶段 COPY 后断裂。
COPY server/templates/vite-react/package.json \
  server/templates/vite-react/pnpm-lock.yaml \
  server/templates/vite-react/.npmrc ./
RUN pnpm install --frozen-lockfile

# 可信骨架由镜像持有；用户提交同名配置时会被这些文件覆盖。
COPY server/templates/vite-react/ ./


# ─────────────────────────────────────────────────────────────
# 阶段 4：运行 FastAPI + Node Worker，并托管前后台静态产物
# ─────────────────────────────────────────────────────────────
FROM crpi-a7p27yxlrmekg1a3.cn-beijing.personal.cr.aliyuncs.com/elin-common/python:3.12-slim AS runtime

# uv 负责 Python 依赖；Node 只负责运行已编译 Worker 与固定 Vite 构建。
COPY --from=crpi-a7p27yxlrmekg1a3.cn-beijing.personal.cr.aliyuncs.com/elin-common/uv:latest /uv /uvx /bin/
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

COPY server/pyproject.toml server/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY server/app ./app
COPY --from=sandbox-builder /opt/template ./templates/vite-react
# 镜像构建期执行一次线上同款 Vite 入口，提前发现 Node 或模板依赖缺失。
RUN node ./templates/vite-react/node_modules/vite/bin/vite.js --version
COPY server/alembic ./alembic
COPY server/alembic.ini ./alembic.ini
COPY server/scripts ./scripts
# Worker 是 ESM 多文件产物；入口会继续 import 同目录模块，必须整体复制 dist。
COPY --from=worker-builder /app/sandbox-worker/dist/ ./sandbox-worker/
COPY scripts/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

COPY --from=ui-builder /app/web/dist ./static
COPY --from=ui-builder /app/web-admin/dist ./static-admin

# 公网只映射 8000。Worker 固定监听容器 loopback 的 8010，不对外发布。
EXPOSE 8000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
