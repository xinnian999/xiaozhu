"""小筑 后端入口。

startup 事件 + CORS + 路由注册三件事在这里完成。
其他所有业务逻辑都在各自的模块里，main.py 只做装配。
"""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.api import (
    ask_result,
    billing,
    boot_failure,
    build_result,
    chat,
    files,
    messages,
    sessions,
    share,
    users,
    versions,
)
from app.api import admin as admin_api
from app import llm, runtime_config, setup
from app.checkpointer import set_checkpointer
from app.config import settings
from app.db import AsyncSessionLocal, engine
from app.setup import is_initialized, is_initialized_cached


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


# ── 初始化闸门中间件 ────────────────────────────────────────
# 系统还没初始化（库里没有任何管理员）时，前台/接口都不该能用 —— 否则全新库里
# 前台是一堆空数据和报错。这里在最外层拦一道：未初始化就把请求引导去 /setup。
#
# 为什么又是纯 ASGI 中间件：和跨域隔离中间件同理，@app.middleware 会缓冲 SSE、
# 破坏 /api/chat 流式。这里只在「未初始化」时才拦，且对放行的请求一个字节都不碰响应体。
#
# 放行清单（未初始化时仍可访问）：
#   /setup            —— 初始化向导本身（否则死循环）
#   /api/setup-status —— 前端首屏查初始化状态的接口，必须放行（否则前端拿不到状态、无法自跳）
#   /health           —— 健康检查，探活用
#   /deps-snapshot    —— 大文件，无所谓
# 其余一切（前台 SPA、管理后台 /admin、/api/*、静态资源）→ 302 跳 /setup。
# 管理后台无需在此放行：未初始化时库里根本没有管理员、登不进去，引导去 /setup 建首个管理员
# 才是正确路径；建成后 is_initialized 即为 True，/admin 与 /api/admin/* 全部照常放行。
#
# 性能：已初始化后 is_initialized_cached() 命中内存缓存、直接放行，不查库、零额外开销。
# 只有「还没初始化」这段短暂时期才会对每个请求查一次库（且很快就 mark 成 True）。
class SetupGateMiddleware:
    _ALLOW_PREFIXES = ("/setup", "/api/setup-status", "/health", "/deps-snapshot")

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # 快路径：已初始化（缓存命中）→ 直接放行，绝大多数请求走这里
        if is_initialized_cached():
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path.startswith(self._ALLOW_PREFIXES):
            await self.app(scope, receive, send)
            return

        # 缓存未命中：可能是「首次启动还没查过库」，也可能是「真没初始化」。查一次库确认。
        async with AsyncSessionLocal() as db:
            initialized = await is_initialized(db)
        if initialized:
            await self.app(scope, receive, send)
            return

        # 确认未初始化 → 引导去向导页
        response = RedirectResponse("/setup", status_code=302)
        await response(scope, receive, send)


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

    # 启动时把「动态配置」和「模型注册表」准备好：
    #   1. 首次部署：把 .env 现值灌进 app_settings、把种子模型灌进 llm_*（幂等，再启动不覆盖）。
    #   2. 把两者读进内存缓存 —— 之后业务代码读缓存，不每条请求打库。
    # 这一步依赖表已存在（迁移已 upgrade），所以放在 yield 前、迁移之后。
    async with AsyncSessionLocal() as session:
        await runtime_config.ensure_seeded(session)
        await llm.ensure_seeded(session)
        await runtime_config.load(session)
        await llm.reload_registry(session)

    # ask_user 的 interrupt()/resume 需要一个 checkpointer（见 app.checkpointer 顶部说明）。
    # 独立 sqlite 文件，和主库分开；setup() 建表是幂等的，每次启动跑一次没问题。
    async with AsyncSqliteSaver.from_conn_string(settings.checkpoint_db_path) as checkpointer:
        await checkpointer.setup()
        set_checkpointer(checkpointer)
        yield
    # shutdown 时：关闭连接池（FastAPI 进程退出时自动触发）
    await engine.dispose()


app = FastAPI(title="Xiaozhu Backend", version="0.2.0", lifespan=lifespan)

# 给所有响应加跨域隔离头（dev / 生产都加，无副作用，让两边环境更一致）
app.add_middleware(CrossOriginIsolationMiddleware)
# 初始化闸门：未初始化时把前台/接口都引导去 /setup。最后 add = 最外层先执行，
# 让它在其它中间件之前拦下未初始化的请求。
app.add_middleware(SetupGateMiddleware)

# CORS 由 Vite 代理处理，后端不再需要设置

# ── 静态产物目录（路由和挂载共用）─────────────────────────────
# dev 期 static/ 不存在；生产期有 dist 拷进来。
# 提前声明让下方路由函数可以引用，不依赖定义顺序。
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
# 管理后台（web-admin，vite+react+antd）的构建产物目录，同进程挂载在 /admin。
# 与主前端 STATIC_DIR 同理：dev 期不存在则跳过，生产期由 Dockerfile 拷进来。
ADMIN_STATIC_DIR = Path(__file__).resolve().parent.parent / "static-admin"

# ── 路由注册 ─────────────────────────────────────────────────
app.include_router(sessions.router)
app.include_router(users.router)
app.include_router(share.router)
app.include_router(files.router)
app.include_router(versions.router)
app.include_router(messages.router)
app.include_router(build_result.router)
app.include_router(boot_failure.router)
app.include_router(ask_result.router)
app.include_router(chat.router)
app.include_router(billing.router)
app.include_router(admin_api.router)

# ── 系统初始化向导（/setup）────────────────────────────────
# 首次部署（库里还没有管理员）时引导「建首个管理员 + 填运营配置」。
# 放在静态挂载之前注册，确保 /setup 能命中。
app.include_router(setup.router)

# ── 管理后台（web-admin，独立 vite+react+antd 前端）───────────
# 必须在下方主前端 catch-all 静态挂载之前：Starlette 按注册顺序匹配路由，
# 主前端静态挂载是吞掉一切剩余路径的 catch-all，挂在它后面 /admin 永远命中不了。
# dev 期该目录不存在，跳过（管理后台走独立的 vite:9100）；生产由 Dockerfile 的
# web-admin 构建阶段拷进来。鉴权走 /api/admin/* 的 get_current_admin（JWT），无需在此另设。
if ADMIN_STATIC_DIR.is_dir():
    app.mount("/admin", StaticFiles(directory=ADMIN_STATIC_DIR, html=True), name="static-admin")


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

