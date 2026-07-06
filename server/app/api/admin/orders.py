"""管理后台 —— 订单查看（对齐 admin.py 的 OrderAdmin：只读，不允许增改删）。

订单是支付流水，只读展示，不允许在后台增改删，避免破坏对账。
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models.order import Order, OrderAdminRead

router = APIRouter(prefix="/orders", tags=["admin-orders"])


@router.get("", response_model=list[OrderAdminRead])
async def list_orders(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> list[Order]:
    stmt = select(Order).order_by(Order.created_at.desc()).offset(offset).limit(limit)
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.get("/count", response_model=int)
async def count_orders(db: AsyncSession = Depends(get_db)) -> int:
    result = await db.execute(select(func.count()).select_from(Order))
    return result.scalar_one()
