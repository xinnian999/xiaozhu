"""File 数据模型：ORM 表 + Pydantic Schema。

files 表是 sessions 的子表，一个 session 下有多个文件。
同一 session 内 path 唯一（UniqueConstraint），write_file 时做 upsert。
"""

from datetime import datetime

from pydantic import BaseModel
from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


# ── ORM Model ──────────────────────────────────────────────────────────────────

class File(Base):
    __tablename__ = "files"

    # 自增整数主键，SQLite 原生支持，比 UUID 更省空间
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)

    # 外键关联 sessions.id，session 删除时文件也应级联删除（ondelete 在迁移时再加）
    session_id: Mapped[str] = mapped_column(String, ForeignKey("sessions.id"), nullable=False)

    # 文件路径，如 "src/App.tsx"
    path: Mapped[str] = mapped_column(String, nullable=False)

    # 文件内容，Text 类型（SQLite 里 TEXT 不限长度）
    content: Mapped[str] = mapped_column(Text, nullable=False)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    # 同一 session 下 path 唯一，保证不会出现两个 src/App.tsx
    __table_args__ = (UniqueConstraint("session_id", "path", name="uq_session_path"),)


# ── Pydantic Schemas ───────────────────────────────────────────────────────────

class FileWrite(BaseModel):
    """PUT /api/sessions/{id}/files/{path} 的请求体。"""
    content: str


class FileRead(BaseModel):
    """API 响应里返回的文件对象。"""
    model_config = {"from_attributes": True}

    id: int
    session_id: str
    path: str
    content: str
    updated_at: datetime
