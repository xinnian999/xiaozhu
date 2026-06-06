# syntax=docker/dockerfile:1
#
# Vibuild 生产镜像：一个容器里既跑后端 API，又托管前端静态页面（同源单进程）。
# 用「多阶段构建」：阶段1 用 bun 把前端编译成静态文件，阶段2 只把编译产物
# 拷进 python 运行镜像 —— 最终镜像里没有 bun、没有前端源码、没有 node_modules，
# 体积小、攻击面也小。

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
RUN bun install --frozen-lockfile

# 再拷前端源码并构建。根脚本 build = 进 web 跑 `tsc -b && vite build`。
COPY web/ ./web/
RUN bun run build
# 构建完成后顺手压缩快照文件：66MB → ~18MB，生产首次加载快 3 倍
# -k 保留原始 .bin（StaticFiles fallback 用），-9 最大压缩比
RUN [ -f /app/web/dist/deps-snapshot.bin ] && \
    gzip -k9 /app/web/dist/deps-snapshot.bin || true
# 产物落在 /app/web/dist，交给阶段 2 取用


# ─────────────────────────────────────────────────────────────
# 阶段 2：运行后端（python + uvicorn，并托管阶段1的前端产物）
# ─────────────────────────────────────────────────────────────
FROM crpi-a7p27yxlrmekg1a3.cn-beijing.personal.cr.aliyuncs.com/elin-common/python:3.12-slim AS runtime

# 直接从 uv 镜像拷 uv 二进制进来，比在容器里 pip install uv 更快更干净
COPY --from=crpi-a7p27yxlrmekg1a3.cn-beijing.personal.cr.aliyuncs.com/elin-common/uv:latest /uv /uvx /bin/

WORKDIR /app

# 先拷依赖清单装依赖（同样吃层缓存：uv.lock 没变就不重装）。
#   --frozen            ：严格按 uv.lock 安装，不重新求解版本
#   --no-dev            ：不装 ruff 等开发依赖
#   --no-install-project：只装第三方依赖，不把本项目当包安装（我们的代码直接跑，无需打包）
COPY server/pyproject.toml server/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# 拷后端运行时真正需要的东西：
#   app/         业务代码
#   templates/   新会话用的 vite-react 骨架（templates.py 运行时会读取）
#   alembic/ + alembic.ini  数据库迁移脚本与配置（启动时 upgrade 用）
COPY server/app ./app
COPY server/templates ./templates
COPY server/alembic ./alembic
COPY server/alembic.ini ./alembic.ini

# 把阶段1构建好的前端产物放到 /app/static
# main.py 用 Path(__file__).parent.parent / "static" 定位，正好命中这里。
COPY --from=web-builder /app/web/dist ./static

# 容器内监听 8000。OPENAI_API_KEY、DATABASE_URL 等敏感/环境相关配置
# 不写进镜像，运行时由 docker 用环境变量注入（见 docker-compose）。
EXPOSE 8000

# 启动命令分两步：先把数据库迁移到最新（alembic upgrade head），再起 uvicorn。
#   - upgrade head 是幂等的：已是最新就什么都不做；有新迁移才执行，且不丢数据。
#     这就取代了原来的 create_all，从根上解决「改了模型、线上老库没跟着改」的问题。
#   - 用 sh -c 串起两条命令；exec 让 uvicorn 接管 PID 1，信号（停容器）能正确传到它。
# --host 0.0.0.0 让容器外能访问（默认只听 127.0.0.1，在容器里等于谁都连不上）。
CMD ["sh", "-c", "/app/.venv/bin/alembic upgrade head && exec /app/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000"]
