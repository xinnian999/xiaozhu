"""User（用户）的数据模型：ORM 表 + Pydantic Schema 双份。

这里最能体现「ORM 字段」和「API 字段」为什么要分开（见 session.py 顶部说明）：
  - 数据库里要存 password_hash（哈希后的密码）；
  - 但 API 响应 UserRead 里**绝对不能**出现 password_hash。
  靠两个不同的类自然隔开，杜绝"不小心把密码哈希返回给前端"。
"""

import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Integer, String, func
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

    # 是否管理员。管理后台（/admin）只放行 is_admin=True 的账号登录。
    # server_default="0" 让迁移给已有用户回填成「非管理员」，不会留空；
    # 把自己设为管理员用 scripts/make_admin.py（不开放界面自助升管理员，避免越权）。
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="0")

    # ── 付费/额度（第 1 步：只建字段，扣费逻辑在第 2 步）──────────────────────────
    # 套餐档位：free / pro / max。每档每天有不同的点数额度（见 app/billing.py 的 TIER_DAILY）。
    # server_default="free" 保证迁移给「已有用户」自动回填成免费档，不会留空。
    tier: Mapped[str] = mapped_column(String, nullable=False, server_default="free")

    # 今日已用点数。每轮对话按模型倍率累加；跨天会在扣费时先重置为 0（配合 daily_date）。
    # server_default="0" 让老用户迁移后从 0 起算。
    daily_used: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    # daily_used 对应的「自然日」。扣费时若它 != 今天，说明跨天了 → 先把 daily_used 清零、
    # 再把这里更新成今天。可空：新用户/老用户初始没有值，第一次扣费时才写。
    daily_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    # 付费档位的到期时间（月卡式）。支付成功时设为「现在 + 30 天」；
    # 过了这个时间，effective_tier 就把用户当 free 算（自动降级）。
    # free 用户 / 从没付过费的用户为 None。
    tier_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


# ── Pydantic Schemas ───────────────────────────────────────────────────────────

from pydantic import BaseModel, EmailStr, Field  # noqa: E402


class SendCodeRequest(BaseModel):
    """POST /api/users/send-code 的请求体：只要邮箱。

    EmailStr 顺手校验格式，格式不对直接 422，连验证码都不会发。
    """
    email: EmailStr


class UserCreate(BaseModel):
    """POST /api/users/register 的请求体。

    EmailStr：Pydantic 自动校验邮箱格式，格式不对会直接返回 422，根本进不到我们代码。
    password 用 Field 限制长度：
      min_length=6  → 太短的弱密码挡掉；
      max_length=72 → 对齐 bcrypt 的 72 字节上限，避免后面哈希时出错。
    code：邮箱验证码（先调 send-code 拿）。注册时后端校验它，确保邮箱真实可达，
      从而「一个真实邮箱只能注册一个号」，挡住乱填邮箱多开小号。
    """
    email: EmailStr
    password: str = Field(min_length=6, max_length=72)
    code: str = Field(min_length=4, max_length=8)


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
