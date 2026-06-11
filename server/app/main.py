"""Vibuild 后端入口。

startup 事件 + CORS + 路由注册三件事在这里完成。
其他所有业务逻辑都在各自的模块里，main.py 只做装配。
"""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.api import (
    build_result,
    chat,
    files,
    logs,
    messages,
    sessions,
    share,
    users,
    versions,
)
from app.config import settings
from app.db import engine


# ── 跨域隔离中间件（WebContainer 硬性前提）──────────────────
# WebContainer 依赖 SharedArrayBuffer，浏览器只在「跨域隔离」状态下才放行它。
# 开启跨域隔离要求顶层文档带这两个响应头：
#   Cross-Origin-Opener-Policy: same-origin
#   Cross-Origin-Embedder-Policy: require-corp
# dev 期是 Vite(vite.config.ts) 帮我们加的；生产期没有 Vite 了，必须后端自己加。
#
# 为什么手写「纯 ASGI 中间件」而不用更简单的 @app.middleware("http")？
# 后者基于 BaseHTTPMiddleware，历史上会把流式响应整个缓冲起来再一次性发出，
# 这会直接破坏我们 /api/chat 的 SSE「边生成边推送」效果。纯 ASGI 中间件只在
# 响应的「头」阶段插一手、完全不碰响应体，对流式透明，是最稳的写法。
class CrossOriginIsolationMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # 只处理 HTTP 流量；WebSocket / lifespan 等原样放行
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(msg: Message) -> None:
            # ASGI 把一个响应拆成多条 message：http.response.start 这条带状态码和
            # 响应头，随后才是一条条 http.response.body。我们只在 start 这条往
            # headers 里塞两个头，body 一个字节都不碰 —— 所以流式完全不受影响。
            if msg["type"] == "http.response.start":
                headers = MutableHeaders(scope=msg)
                headers["Cross-Origin-Opener-Policy"] = "same-origin"
                headers["Cross-Origin-Embedder-Policy"] = "require-corp"
            await send(msg)

        await self.app(scope, receive, send_with_headers)


# ── 应用生命周期 ────────────────────────────────────────────
# lifespan 是 FastAPI 推荐的新写法（替代旧的 @app.on_event）。
# yield 之前是 startup 逻辑，yield 之后是 shutdown 逻辑。
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动自检：JWT_SECRET 必须配置，否则签发 token 会在运行时报
    # "HMAC key must not be empty"。在这里直接拦下，让「配置漏了」在启动时就暴露，
    # 而不是等用户登录时才 500。
    if not settings.jwt_secret:
        raise RuntimeError(
            "JWT_SECRET 未配置！请在 .env 里设置一个随机密钥，例如：\n"
            "  python -c \"import secrets; print(secrets.token_urlsafe(48))\""
        )

    # 表结构不再用 create_all 自动建，改由 Alembic 迁移统一管理（见 alembic/）。
    #   - Docker：容器启动命令里先跑 `alembic upgrade head` 再起 uvicorn。
    #   - 本地 dev：`bun run dev` 会在起后端前自动跑 `db:migrate`（alembic upgrade head）。
    # 这样「改模型 → 生成迁移 → upgrade」是唯一的建表/改表入口，
    # 彻底告别 create_all「只建新表、不改老表」导致的线上 schema 漂移。
    yield
    # shutdown 时：关闭连接池（FastAPI 进程退出时自动触发）
    await engine.dispose()


app = FastAPI(title="Vibuild Backend", version="0.2.0", lifespan=lifespan)

# 给所有响应加跨域隔离头（dev / 生产都加，无副作用，让两边环境更一致）
app.add_middleware(CrossOriginIsolationMiddleware)

# CORS 由 Vite 代理处理，后端不再需要设置

# ── 静态产物目录（路由和挂载共用）─────────────────────────────
# dev 期 static/ 不存在；生产期有 dist 拷进来。
# 提前声明让下方路由函数可以引用，不依赖定义顺序。
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# ── 路由注册 ─────────────────────────────────────────────────
app.include_router(sessions.router)
app.include_router(users.router)
app.include_router(share.router)
app.include_router(files.router)
app.include_router(versions.router)
app.include_router(messages.router)
app.include_router(logs.router)
app.include_router(build_result.router)
app.include_router(chat.router)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


# ── deps-snapshot.bin：用 gzip 压缩版本响应 ────────────────────
# 66MB 的原始快照直接通过 StaticFiles 吐出来太慢。
# Dockerfile 构建时已经生成 .bin.gz（约 18MB），这里拦截这个路径，
# 优先返回压缩版本 + Content-Encoding: gzip，浏览器透明解压。
# 前端 fetch 拿到的 arrayBuffer 是解压后的原始字节，wc.mount() 照常工作。
# Cache-Control 设 1 天：manifest depsKey 校验会在下载前先拦截版本不匹配的情况。
@app.get("/deps-snapshot.bin")
async def serve_snapshot(request: Request) -> FileResponse:
    gz_path = STATIC_DIR / "deps-snapshot.bin.gz"
    if gz_path.exists():
        return FileResponse(
            gz_path,
            media_type="application/octet-stream",
            headers={
                "Content-Encoding": "gzip",
                "Cache-Control": "public, max-age=86400",
            },
        )
    # 没有压缩版本时回退到原始文件（开发环境 / 首次部署前）
    return FileResponse(
        STATIC_DIR / "deps-snapshot.bin",
        media_type="application/octet-stream",
    )


# ── 生产模式：托管前端构建产物 ──────────────────────────────
# 约定：把前端 `bun run build` 出的 dist 拷到 server/static/ 即可，无需任何环境变量。
# 用 __file__ 定位目录，不受 uvicorn 启动时工作目录影响。
#   - dev 期：没拷 dist，static/ 不存在 → 跳过托管，前端走 Vite(5173)。
#   - 生产期：static/ 里有文件 → 挂载，前后端成「同源单进程」。
# 必须放在所有 API 路由「之后」：Starlette 按注册顺序匹配，前面的 /api/* 和
# /health 先命中，剩下的一切路径才落到这个静态挂载上。
#   html=True：访问 "/" 自动返回 index.html（单页应用入口）。
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

