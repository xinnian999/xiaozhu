"""Order（充值/升级订单）的数据模型。

一条订单 = 用户发起一次「买某档套餐」。生命周期：
  pending（已下单、等支付）→ paid（支付宝确认到账，已升档）。

id 既是我们的主键，也直接当作给支付宝的「商户订单号 out_trade_no」——
它是支付宝侧的幂等键：同一个 out_trade_no 重复下单/重复回调，支付宝和我们都按同一笔处理。
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Order(Base):
    """数据库表 `orders` 的 ORM 映射。"""

    __tablename__ = "orders"

    # UUID 字符串主键，同时作为支付宝的 out_trade_no（商户订单号 / 幂等键）
    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))

    # 下单的用户。index：要按用户查他的订单。
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id"), nullable=False, index=True
    )

    # 买的是哪一档（pro / max）。free 不需要下单，所以这里只会是付费档。
    tier: Mapped[str] = mapped_column(String, nullable=False)

    # 金额：直接存「元」字符串（如 "9.90"），和我们传给支付宝的 total_amount 一模一样，
    # 既避免浮点误差，又方便回调时核对金额是否被篡改。
    amount: Mapped[str] = mapped_column(String, nullable=False)

    # 订单状态：pending（待支付）/ paid（已支付已升档）。默认 pending。
    status: Mapped[str] = mapped_column(String, nullable=False, server_default="pending")

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    # 支付到账时间。未支付为 None；确认到账时回填。
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
