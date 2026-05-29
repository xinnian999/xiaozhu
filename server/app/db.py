"""数据库引擎 + 异步 Session 工厂。

SQLAlchemy 2.0 的 async 模式需要三个核心对象：
  1. engine        —— 管理底层数据库连接（连接池），全应用唯一
  2. AsyncSession  —— 每次请求/事务创建一个，用完销毁
  3. Base          —— 所有 ORM Model 继承它，才能被 SQLAlchemy 识别

「依赖注入」是 FastAPI 的核心模式：
  - get_db() 是一个「async generator function」，yield 之前做"打开"，
    yield 之后做"关闭"（类似 Python 的 context manager with 语句）。
  - FastAPI 的 Depends(get_db) 会自动调用它：进请求 → 给你一个 session，
    出请求（无论成功还是报错）→ 自动关闭，不需要你手动 close。
"""

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

# engine：底层连接池。echo=True 会把所有 SQL 打印到控制台，
# 开发时非常有用（能看到 ORM 生成的 SQL 是否正确），上线前关掉。
engine = create_async_engine(settings.database_url, echo=True)

# Session 工厂：每次调用它就拿到一个新的 AsyncSession 实例。
# expire_on_commit=False：commit 之后对象不自动"过期"，
# 这样 async 场景里不用再次 await session.refresh(obj) 才能访问字段。
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


# 所有 ORM Model 的基类，必须在 models/ 里 import 并继承
class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI 依赖：提供一个请求级别的数据库 session。

    用法：
        @router.post("/xxx")
        async def handler(db: AsyncSession = Depends(get_db)):
            ...
    """
    async with AsyncSessionLocal() as session:
        yield session
