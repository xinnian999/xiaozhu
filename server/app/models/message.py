"""Message 数据模型：ORM 表 + Pydantic Schema。

messages 表是 sessions 的子表，记录一次会话里**按发生顺序**的所有消息。
为什么需要持久化？刷新页面后还能完整回显之前的对话，体验上接近 ChatGPT。

这里不止存"最终"消息，还把**工具调用**也存了下来 —— 因为工具调用本身就是
对话流的一部分（"读取 App.tsx"、"写入 index.css" 这些进度，用户是看得见的）。
靠 kind 字段区分一行是普通文本还是工具卡：
  - kind='text'：用户输入 / assistant 说的话（包括调工具前的过场叙述、最终回复）
  - kind='tool'：一次工具调用，额外带 tool_name / tool_args

kind 还有第二个用途：加载历史喂给 LLM 当上下文时，只取 kind='text' 的，
把工具行过滤掉 —— 工具的效果已经落在 files 表的现状里，重放反而会误导模型。
"""

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, field_serializer
from sqlalchemy import JSON, DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


# ── ORM Model ──────────────────────────────────────────────────────────────────

class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)

    # 外键关联 sessions.id
    session_id: Mapped[str] = mapped_column(String, ForeignKey("sessions.id"), nullable=False)

    # 角色：'user' 或 'assistant'（工具调用也归在 assistant 名下）
    # 用 str 而不是 Enum，因为 SQLite 对 Enum 支持一般，str 更简单
    role: Mapped[str] = mapped_column(String, nullable=False)

    # 消息正文。工具行没有正文，存空字符串
    text: Mapped[str] = mapped_column(Text, nullable=False)

    # 消息种类：'text'（普通对话）、'tool'（工具调用卡）或 'version'（版本卡）。
    # server_default='text' 让旧数据 / 迁移时自动补成普通文本，向后兼容
    kind: Mapped[str] = mapped_column(String, nullable=False, server_default="text")

    # 仅 kind='tool' 时有值：工具名（write_file / read_file / ...）
    tool_name: Mapped[str | None] = mapped_column(String, nullable=True)

    # kind='tool' 时存工具参数；kind='version' 时存版本卡负载 {version_id, seq}。
    # 用 SQLAlchemy 的 JSON 类型 —— 写入时自动把 dict 序列化成 JSON 字符串存进 SQLite，读出时自动反序列化回 dict
    tool_args: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    # 用户随消息附带的图片（多模态识图输入）。存 data URL 列表
    # （形如 "data:image/png;base64,xxxx"）。None / 空表示纯文本消息。
    # 为什么和图片本体一起塞 messages 表？这是单用户练手项目、图片数量很少，
    # 用一个 JSON 列最简单；将来真要做大可拆出独立的 message_images 表。
    # 持久化的目的：刷新后历史里仍能看到自己发过的图，且能把图回放给 LLM。
    images: Mapped[list | None] = mapped_column(JSON, nullable=True)

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
    # 下面三个带默认值：旧数据 / 普通文本消息不带工具信息时也能正常序列化。
    # kind='version' 是「版本卡」：tool_args 里存 {version_id, seq}，前端渲染成带回滚按钮的卡片
    kind: Literal["text", "tool", "version"] = "text"
    tool_name: str | None = None
    tool_args: dict | None = None
    # 随消息附带的图片 data URL 列表；纯文本消息为 None
    images: list[str] | None = None
    created_at: datetime

    @field_serializer("created_at")
    def serialize_created_at(self, dt: datetime) -> str:
        """把 created_at 序列化成带 UTC 时区的 ISO 字符串。

        DB 里存的是 naive（无时区）的 UTC 时间（SQLite 的 func.now() 返回 UTC）。
        直接序列化会得到 "2026-06-05T15:18:00"，没有时区后缀，
        前端 new Date() 会误当成本地时间，导致差了一个时区的小时数。
        这里补上 UTC 时区 → "2026-06-05T15:18:00+00:00"，前端就能正确换算到本地。
        """
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat()

