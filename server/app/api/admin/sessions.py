"""管理后台 —— 会话查看（对齐 admin.py 的 SessionAdmin：只读 + 可删，用于清理）。

会话内容由生成流程写，后台只看/删，不允许编辑内容。
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models.session import Session, SessionAdminRead

router = APIRouter(prefix="/sessions", tags=["admin-sessions"])


@router.get("", response_model=list[SessionAdminRead])
async def list_sessions(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> list[Session]:
    stmt = select(Session).order_by(Session.created_at.desc()).offset(offset).limit(limit)
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.get("/count", response_model=int)
async def count_sessions(db: AsyncSession = Depends(get_db)) -> int:
    result = await db.execute(select(func.count()).select_from(Session))
    return result.scalar_one()


@router.delete("/{session_id}", status_code=204)
async def delete_session(session_id: str, db: AsyncSession = Depends(get_db)) -> Response:
    session = await db.get(Session, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    await db.delete(session)
    await db.commit()
    return Response(status_code=204)
