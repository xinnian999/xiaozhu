"""Message 数据模型：ORM 表 + Pydantic Schema。

messages 表是 sessions 的子表，记录用户和 assistant 的对话历史。
为什么需要持久化？刷新页面后还能看到之前的对话，体验上接近 ChatGPT。

注意：这里只保存"最终"消息（用户输入 + assistant 最终回复），
不保存中间的 tool_call 事件 —— 那些是流式过程中的进度提示，
持久化没有意义（用户关心的是对话本身和最终代码）。
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel
from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


# ── ORM Model ──────────────────────────────────────────────────────────────────

class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)

    # 外键关联 sessions.id
    session_id: Mapped[str] = mapped_column(String, ForeignKey("sessions.id"), nullable=False)

    # 角色：'user' 或 'assistant'
    # 用 str 而不是 Enum，因为 SQLite 对 Enum 支持一般，str 更简单
    role: Mapped[str] = mapped_column(String, nullable=False)

    # 消息正文
    text: Mapped[str] = mapped_column(Text, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# ── Pydantic Schema ────────────────────────────────────────────────────────────

class MessageRead(BaseModel):
    """API 响应里返回的消息对象。"""
    model_config = {"from_attributes": True}

    id: int
    session_id: str
    # Literal 在 Python 类型层面收窄取值范围，
    # FastAPI/Pydantic 会校验返回值确实是 user/assistant 之一
    role: Literal["user", "assistant"]
    text: str
    created_at: datetime
