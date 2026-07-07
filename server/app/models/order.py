"""Order（充值/升级订单）的数据模型。

一条订单 = 用户发起一次「买某档套餐」。手动收款模式的生命周期：
  pending（已下单、等用户扫码支付）
    → pending_review（用户点了「我已支付」、等管理员人工核对到账）
    → paid（管理员核对通过、已升档）
  或 pending_review → rejected（管理员核对对不上，驳回）。

没有第三方支付渠道 / webhook：升档只由管理员在后台审核触发（_fulfill_order），
用户点「我已支付」只是把订单转到待审核，不会自动升档（防白嫖）。
id 是我们的 UUID 主键，也是幂等键。
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Order(Base):
    """数据库表 `orders` 的 ORM 映射。"""

    __tablename__ = "orders"

    # UUID 字符串主键（幂等键）
    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))

    # 下单的用户。index：要按用户查他的订单。
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id"), nullable=False, index=True
    )

    # 买的是哪一档（pro / max）。free 不需要下单，所以这里只会是付费档。
    tier: Mapped[str] = mapped_column(String, nullable=False)

    # 金额：直接存「元」字符串（如 "9.90"），避免浮点误差，也方便对账核对。
    amount: Mapped[str] = mapped_column(String, nullable=False)

    # 订单状态：pending（待支付）/ pending_review（已声明支付、待审核）/
    # paid（审核通过已升档）/ rejected（驳回）。默认 pending。
    status: Mapped[str] = mapped_column(String, nullable=False, server_default="pending")

    # 用户在「我已支付」时选的支付方式：wechat / alipay。下单时为空。
    payment_method: Mapped[str | None] = mapped_column(String, nullable=True)

    # 用户填的付款备注（如微信支付尾号），方便管理员对账。可空。
    pay_note: Mapped[str | None] = mapped_column(String, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    # 支付到账时间（审核通过时回填）。未通过为 None。
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 审核时间（通过 / 驳回都回填）。
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 驳回理由（仅 rejected 时有值）。
    reject_reason: Mapped[str | None] = mapped_column(String, nullable=True)


# ── Pydantic Schemas ───────────────────────────────────────────────────────────

from pydantic import BaseModel  # noqa: E402


class OrderAdminRead(BaseModel):
    """管理后台订单列表响应，只读展示，字段与表结构一一对应。"""
    model_config = {"from_attributes": True}

    id: str
    user_id: str
    # 列表接口 join users 表填充，审核接口可不填。
    user_nickname: str | None = None
    tier: str
    amount: str
    status: str
    payment_method: str | None
    pay_note: str | None
    created_at: datetime
    paid_at: datetime | None
    reviewed_at: datetime | None
    reject_reason: str | None
