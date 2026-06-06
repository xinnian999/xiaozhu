"""User（用户）的数据模型：ORM 表 + Pydantic Schema 双份。

这里最能体现「ORM 字段」和「API 字段」为什么要分开（见 session.py 顶部说明）：
  - 数据库里要存 password_hash（哈希后的密码）；
  - 但 API 响应 UserRead 里**绝对不能**出现 password_hash。
  靠两个不同的类自然隔开，杜绝"不小心把密码哈希返回给前端"。
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

# ── ORM Model ─────────────────────────────────────────────────────────────────


class User(Base):
    """数据库表 `users` 的 ORM 映射。"""

    __tablename__ = "users"

    # UUID 字符串主键，和 sessions 表保持一致的风格
    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))

    # 邮箱作为登录账号：
    #   unique=True  → 数据库层面保证不重复（即使代码漏判，DB 也会拦住）
    #   index=True   → 登录时要按 email 查用户，加索引让查询快
    email: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)

    # 只存哈希，永远不存明文密码（见 security.py 的原理说明）
    password_hash: Mapped[str] = mapped_column(String, nullable=False)

    # 昵称：注册时随机生成一个文艺昵称（见 mock_profile.py），用户可改。
    nickname: Mapped[str] = mapped_column(String, nullable=False)

    # 头像「种子」：注册时随机生成的字符串，前端用它确定性地渲染出头像
    # （渐变背景 + emoji）。不存图片本身，省存储且能离线渲染。
    avatar: Mapped[str] = mapped_column(String, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# ── Pydantic Schemas ───────────────────────────────────────────────────────────

from pydantic import BaseModel, EmailStr, Field  # noqa: E402


class UserCreate(BaseModel):
    """POST /api/users/register 的请求体。

    EmailStr：Pydantic 自动校验邮箱格式，格式不对会直接返回 422，根本进不到我们代码。
    password 用 Field 限制长度：
      min_length=6  → 太短的弱密码挡掉；
      max_length=72 → 对齐 bcrypt 的 72 字节上限，避免后面哈希时出错。
    """
    email: EmailStr
    password: str = Field(min_length=6, max_length=72)


class UserRead(BaseModel):
    """API 响应里返回的用户对象 —— 注意这里**没有** password / password_hash。"""
    model_config = {"from_attributes": True}  # 允许从 ORM 对象直接构建

    id: str
    email: str
    nickname: str
    avatar: str
    created_at: datetime


class UserUpdate(BaseModel):
    """PATCH /api/users/me 的请求体：改资料。

    字段都可选（partial update）：传了哪个就改哪个，没传的保持不变。
    nickname 限长，avatar 是前端重新「摇」出来的新种子。
    """
    nickname: str | None = Field(default=None, min_length=1, max_length=20)
    avatar: str | None = None


class UserLogin(BaseModel):
    """POST /api/users/login 的请求体。

    登录这里**不**做 min_length 之类的强校验：长度规则是「注册」时把关的，
    登录只管「这串密码能不能对上库里的哈希」，对不上就统一报错，不暴露细节。
    """
    email: EmailStr
    password: str


class Token(BaseModel):
    """登录成功后返回的 token。

    token_type 固定为 "bearer"：这是 HTTP 鉴权的一种标准方案，
    前端之后要在请求头里写成 `Authorization: Bearer <access_token>`（第 3 步会用到）。
    """
    access_token: str
    token_type: str = "bearer"
