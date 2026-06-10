"""Session（会话）的数据模型：ORM 表 + Pydantic Schema 双份。

为什么要写两份？
  - ORM Model（Session 类）：给 SQLAlchemy 用，映射数据库表，代表"数据存储结构"。
  - Pydantic Schema（SessionRead 等）：给 FastAPI 用，映射 HTTP 请求/响应的 JSON，
    代表"对外接口结构"。

这两者故意分开，因为数据库字段和 API 字段不一定一样：
  比如密码字段要存进 DB 但不能出现在 API 响应里；
  又比如 API 接受 camelCase 但数据库列用 snake_case。
  在这个项目里暂时差不多，但分开是好习惯。
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

# ── ORM Model ─────────────────────────────────────────────────────────────────


class Session(Base):
    """数据库表 `sessions` 的 ORM 映射。

    Mapped[str] 是 SQLAlchemy 2.0 的类型注解写法，相当于"这列的 Python 类型是 str"。
    mapped_column() 设置 SQL 层面的约束（primary_key、nullable、default 等）。
    """

    __tablename__ = "sessions"

    # UUID 存为字符串。SQLite 没有原生 UUID 类型，str(uuid.uuid4()) 生成唯一 ID。
    # default 是 Python 侧的默认值（ORM 插入时自动填充），不是 SQL DEFAULT。
    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))

    # 归属用户：外键指向 users.id。
    #   ForeignKey("users.id")：数据库层面声明「这一列的值必须是 users 表里某个真实 id」，
    #     防止出现「会话挂在一个不存在的用户名下」的脏数据。
    #   nullable=False：每个会话必须有主人（老数据已清空，不存在无主会话）。
    #   index=True：列表接口要按 user_id 过滤查询，加索引让「查某人的所有会话」更快。
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id"), nullable=False, index=True
    )

    # 会话标题，可为空 —— 第一条消息发出后再自动填充
    title: Mapped[str | None] = mapped_column(String, nullable=True)

    # 分享令牌（capability URL 的钥匙）：
    #   None  → 未分享（私有，别人访问会话一律 404）
    #   非空  → 已分享，任何人凭这个 token 走公开只读通道 /api/shared/{token} 即可查看
    #   unique=True：token 必须全局唯一，才能反查到唯一会话；
    #     可空 + unique 在 SQL 里是允许的（多个 NULL 不算重复）。
    #   index=True：公开访问要按 token 查会话，加索引让查询快。
    #   撤销分享 = 把它置回 None；重新生成 = 换一个新 token（旧链接立即失效）。
    share_token: Mapped[str | None] = mapped_column(
        String, unique=True, index=True, nullable=True
    )

    # server_default=func.now() 是 SQL 侧的默认值，让数据库自己写当前时间，
    # 比 Python 侧设置更准确（不受时区/服务器时间误差影响）。
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


# ── Pydantic Schemas ───────────────────────────────────────────────────────────
# from_attributes=True：允许 Pydantic 直接从 ORM 对象的属性读字段，
# 而不要求传入字典。这样可以直接 SessionRead.model_validate(orm_obj)。

# 放在文件下半部是为了阅读顺序清晰（先 ORM 再 Schema），E402 在此豁免
from pydantic import BaseModel  # noqa: E402


class SessionCreate(BaseModel):
    """POST /api/sessions 的请求体（目前不需要任何字段，title 后续自动生成）。"""
    title: str | None = None


class SessionUpdate(BaseModel):
    """PATCH /api/sessions/{id} 的请求体：更新会话信息（重命名）。

    目前只有 title 一个字段，留成可空是为了将来好扩展（再加别的可改字段时
    不破坏接口）。具体「title 不能为空」的业务校验放在路由里做，schema 只管结构。
    """
    title: str | None = None


class SessionRead(BaseModel):
    """API 响应里返回的会话对象。"""
    model_config = {"from_attributes": True}  # 允许从 ORM 对象直接构建

    id: str
    title: str | None
    created_at: datetime
    updated_at: datetime


class ShareInfo(BaseModel):
    """分享接口（生成/查询）返回：当前会话的分享 token。"""
    share_token: str
