"""Vibuild 后端入口。

startup 事件 + CORS + 路由注册三件事在这里完成。
其他所有业务逻辑都在各自的模块里，main.py 只做装配。
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import chat, files, logs, messages, sessions
from app.db import Base, engine
from app.models import file, message  # noqa: F401 —— 让 SQLAlchemy 注册 File / Message 表


# ── 应用生命周期 ────────────────────────────────────────────
# lifespan 是 FastAPI 推荐的新写法（替代旧的 @app.on_event）。
# yield 之前是 startup 逻辑，yield 之后是 shutdown 逻辑。
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时：自动创建所有在 Base 里注册的表（如果表不存在）
    # 这等价于 `CREATE TABLE IF NOT EXISTS ...`，不会删除已有数据。
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    # shutdown 时：关闭连接池（FastAPI 进程退出时自动触发）
    await engine.dispose()


app = FastAPI(title="Vibuild Backend", version="0.2.0", lifespan=lifespan)

# CORS 由 Vite 代理处理，后端不再需要设置

# ── 路由注册 ─────────────────────────────────────────────────
app.include_router(sessions.router)
app.include_router(files.router)
app.include_router(messages.router)
app.include_router(logs.router)
app.include_router(chat.router)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
