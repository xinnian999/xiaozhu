"""管理后台 —— 订单查看 + 手动审核。

订单是支付流水：列表只读，但因为收款是「手动核对」模式，这里额外提供两个审核动作：
  - approve：核对到账后放行，复用 billing._fulfill_order 标记 paid + 升档 + 续期。
  - reject：核对对不上，驳回并记录理由。
不提供增 / 删 / 改金额等操作，避免破坏对账。
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.billing import _fulfill_order
from app.db import get_db
from app.models.order import Order, OrderAdminRead
from app.models.user import User

router = APIRouter(prefix="/orders", tags=["admin-orders"])


def _order_admin_read(
    order: Order, user_nickname: str | None = None, user_email: str | None = None
) -> OrderAdminRead:
    """ORM 订单 → 管理后台响应（可选附带用户昵称 / 邮箱）。"""
    return OrderAdminRead(
        id=order.id,
        user_id=order.user_id,
        user_nickname=user_nickname,
        user_email=user_email,
        tier=order.tier,
        amount=order.amount,
        status=order.status,
        payment_method=order.payment_method,
        pay_note=order.pay_note,
        created_at=order.created_at,
        paid_at=order.paid_at,
        reviewed_at=order.reviewed_at,
        reject_reason=order.reject_reason,
    )


@router.get("", response_model=list[OrderAdminRead])
async def list_orders(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=200),
    status: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[OrderAdminRead]:
    stmt = select(Order, User.nickname, User.email).join(User, Order.user_id == User.id)
    # 可选按状态过滤，方便后台只看「待审核」。
    if status:
        stmt = stmt.where(Order.status == status)
    stmt = stmt.order_by(Order.created_at.desc()).offset(offset).limit(limit)
    result = await db.execute(stmt)
    return [_order_admin_read(order, nickname, email) for order, nickname, email in result.all()]


@router.get("/count", response_model=int)
async def count_orders(
    status: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> int:
    stmt = select(func.count()).select_from(Order)
    if status:
        stmt = stmt.where(Order.status == status)
    result = await db.execute(stmt)
    return result.scalar_one()


async def _get_order_or_404(order_id: str, db: AsyncSession) -> Order:
    order = await db.get(Order, order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="订单不存在")
    return order


@router.post("/{order_id}/approve", response_model=OrderAdminRead)
async def approve_order(order_id: str, db: AsyncSession = Depends(get_db)) -> OrderAdminRead:
    """审核通过：核对到账后放行升档。仅 pending_review 可通过（幂等：已 paid 直接返回）。"""
    order = await _get_order_or_404(order_id, db)
    if order.status == "paid":
        return _order_admin_read(order)
    if order.status != "pending_review":
        raise HTTPException(status_code=400, detail=f"该订单状态（{order.status}）不可审核通过")
    # _fulfill_order 标记 paid + 升档 + 续期 + 回填 reviewed_at，内部已 commit。
    await _fulfill_order(db, order)
    await db.refresh(order)
    return _order_admin_read(order)


class RejectOrderRequest(BaseModel):
    reason: str | None = None  # 驳回理由（可选）


@router.post("/{order_id}/reject", response_model=OrderAdminRead)
async def reject_order(
    order_id: str,
    body: RejectOrderRequest,
    db: AsyncSession = Depends(get_db),
) -> OrderAdminRead:
    """驳回：核对对不上时拒绝。仅 pending_review 可驳回。"""
    order = await _get_order_or_404(order_id, db)
    if order.status != "pending_review":
        raise HTTPException(status_code=400, detail=f"该订单状态（{order.status}）不可驳回")
    order.status = "rejected"
    order.reviewed_at = datetime.now()
    order.reject_reason = (body.reason or "").strip() or None
    await db.commit()
    await db.refresh(order)
    return _order_admin_read(order)
