"""Messages API —— session 下消息的查询接口。

只暴露 list 查询：消息的写入由 chat.py 在 SSE 流里完成，不走 REST。
"""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models.message import Message, MessageRead

router = APIRouter(prefix="/api/sessions/{session_id}/messages", tags=["messages"])


@router.get("", response_model=list[MessageRead])
async def list_messages(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> list[MessageRead]:
    """按创建时间升序返回所有消息。

    升序是为了对齐对话直觉 —— 越早的消息越靠上，符合 chat UI 渲染顺序。
    """
    result = await db.execute(
        select(Message)
        .where(Message.session_id == session_id)
        .order_by(Message.created_at.asc(), Message.id.asc())
    )
    return [MessageRead.model_validate(m) for m in result.scalars().all()]
