"""Sessions API —— 会话的增查接口。

这里展示了 FastAPI + SQLAlchemy async 的标准写法：
  1. 用 APIRouter 把路由分组，在 main.py 里 include 进来（类似 Flask Blueprint）。
  2. 用 Depends(get_db) 注入数据库 session，无需手动 open/close。
  3. 所有数据库操作都要 await（因为我们用的是 async SQLAlchemy）。
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models.session import Session, SessionCreate, SessionRead

# prefix="/api/sessions" → 这个 router 里所有路由都以 /api/sessions 开头
router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.post("", response_model=SessionRead, status_code=201)
async def create_session(
    body: SessionCreate,
    db: AsyncSession = Depends(get_db),  # FastAPI 自动注入
) -> SessionRead:
    """创建一个新会话，返回完整的 session 对象（含自动生成的 id）。

    SQLAlchemy async 的操作流程：
      1. 创建 ORM 对象
      2. db.add() —— 加入当前 session 的"待写入队列"
      3. await db.commit() —— 真正执行 SQL INSERT 并提交事务
      4. await db.refresh(obj) —— 从数据库重新读一次，拿到 server_default 填充的字段
         （比如 created_at 是数据库写的，Python 对象里原本是 None）
    """
    session = Session(title=body.title)
    db.add(session)
    await db.commit()
    await db.refresh(session)  # 拿到数据库生成的 created_at / updated_at
    return SessionRead.model_validate(session)


@router.get("", response_model=list[SessionRead])
async def list_sessions(
    db: AsyncSession = Depends(get_db),
) -> list[SessionRead]:
    """返回所有会话，按创建时间倒序（最新的在前）。"""
    result = await db.execute(select(Session).order_by(Session.created_at.desc()))
    sessions = result.scalars().all()  # scalars() 把每行的第一列取出来，即 Session 对象
    return [SessionRead.model_validate(s) for s in sessions]


@router.get("/{session_id}", response_model=SessionRead)
async def get_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> SessionRead:
    """按 ID 查询会话，不存在则返回 404。"""
    # select(Session) 等价于 SQL: SELECT * FROM sessions WHERE id = :session_id
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()  # 取第一行，没有则返回 None

    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    return SessionRead.model_validate(session)
