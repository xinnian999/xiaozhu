# syntax=docker/dockerfile:1
#
# 小筑生产镜像：一个部署容器内运行 FastAPI 与受限构建 Worker 两个进程。
# 前端、管理后台和固定预览模板都在镜像构建期完成依赖安装；线上每次任务只运行
# Vite build，不会在 2G 服务器上临时安装依赖。

# ─────────────────────────────────────────────────────────────
# 阶段 1：构建前端（bun + vite → 静态产物 dist）
# ─────────────────────────────────────────────────────────────
FROM crpi-a7p27yxlrmekg1a3.cn-beijing.personal.cr.aliyuncs.com/elin-common/bun:1 AS web-builder
WORKDIR /app

# 先只拷依赖清单，再装依赖 —— 利用 Docker 层缓存：
# 只要这几个清单文件没变，下面的 bun install 这一层就直接复用缓存，不重装。
# （这是 Dockerfile 提速的核心技巧：把"变得慢的"放前面，"变得快的"放后面）
COPY package.json bun.lock ./
COPY web/package.json ./web/package.json
# web-admin 也是根 workspace 成员，bun.lock 里有它的条目；--frozen-lockfile 会校验
# 所有 workspace 的 package.json 都在，缺了会报错。这里只拷它的清单（不拷源码），
# 让 frozen 校验通过，同时不触发 web-admin 依赖安装（它在阶段2独立装）。
COPY web-admin/package.json ./web-admin/package.json
RUN bun install --frozen-lockfile

# 再拷前端源码并构建。根脚本 build = 进 web 跑 `tsc -b && vite build`。
COPY web/ ./web/
RUN bun run build
# 产物落在 /app/web/dist，交给阶段 4 取用


# ─────────────────────────────────────────────────────────────
# 阶段 2：构建管理后台（web-admin，独立 vite+react+antd 项目）
# ─────────────────────────────────────────────────────────────
# 单独一个阶段（而不是塞进阶段1）：web-admin 是独立 package.json，
# 依赖装在自己的 node_modules，不与主前端混装，互不干扰、层缓存也独立生效。
FROM crpi-a7p27yxlrmekg1a3.cn-beijing.personal.cr.aliyuncs.com/elin-common/bun:1 AS admin-builder
WORKDIR /app/web-admin

COPY web-admin/package.json ./
RUN bun install

COPY web-admin/ ./
RUN bun run build
# 产物落在 /app/web-admin/dist，交给阶段 4 取用


# ─────────────────────────────────────────────────────────────
# 阶段 3：准备固定的沙箱模板依赖
# ─────────────────────────────────────────────────────────────
FROM crpi-a7p27yxlrmekg1a3.cn-beijing.personal.cr.aliyuncs.com/elin-common/bun:1 AS sandbox-builder
WORKDIR /opt/template

COPY server/templates/vite-react/package.json server/templates/vite-react/.npmrc ./
RUN bun install

# 可信骨架由镜像持有；用户提交同名配置时会被这些文件覆盖。
COPY server/templates/vite-react/ ./


# ─────────────────────────────────────────────────────────────
# 阶段 4：运行 FastAPI + Bun Worker，并托管阶段1/2 的前端产物
# ─────────────────────────────────────────────────────────────
FROM crpi-a7p27yxlrmekg1a3.cn-beijing.personal.cr.aliyuncs.com/elin-common/python:3.12-slim AS runtime

# 直接从 uv 镜像拷 uv 二进制进来，比在容器里 pip install uv 更快更干净
COPY --from=crpi-a7p27yxlrmekg1a3.cn-beijing.personal.cr.aliyuncs.com/elin-common/uv:latest /uv /uvx /bin/
# Worker 与主 API 放在同一个部署容器；只把 Bun 可执行文件带入最终镜像。
COPY --from=sandbox-builder /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# 先拷依赖清单装依赖（同样吃层缓存：uv.lock 没变就不重装）。
#   --frozen            ：严格按 uv.lock 安装，不重新求解版本
#   --no-dev            ：不装 ruff 等开发依赖
#   --no-install-project：只装第三方依赖，不把本项目当包安装（我们的代码直接跑，无需打包）
COPY server/pyproject.toml server/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# 拷后端运行时真正需要的东西：
#   app/         业务代码
#   templates/   新会话与 Worker 共用的可信 vite-react 骨架
#   alembic/ + alembic.ini  数据库迁移脚本与配置（启动时 upgrade 用）
COPY server/app ./app
COPY --from=sandbox-builder /opt/template ./templates/vite-react
COPY server/alembic ./alembic
COPY server/alembic.ini ./alembic.ini
# scripts/ 里有 make_admin.py：生产里把自己设为管理员要用
#   docker compose exec xiaozhu /app/.venv/bin/python -m scripts.make_admin you@example.com
COPY server/scripts ./scripts
COPY sandbox-worker/index.ts ./sandbox-worker/index.ts
COPY scripts/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# 把阶段1构建好的前端产物放到 /app/static
# main.py 用 Path(__file__).parent.parent / "static" 定位，正好命中这里。
COPY --from=web-builder /app/web/dist ./static
# 把阶段2构建好的管理后台产物放到 /app/static-admin，main.py 挂载在 /admin-app。
COPY --from=admin-builder /app/web-admin/dist ./static-admin

# 公网只映射 8000。Worker 固定监听容器 loopback 的 8010，不对外发布。
EXPOSE 8000

# 入口脚本先迁移数据库，再启动 loopback Worker 与 Uvicorn，并统一转发退出信号。
ENTRYPOINT ["/app/docker-entrypoint.sh"]
