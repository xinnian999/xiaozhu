"""Billing API —— 额度查询 + 套餐购买（个人收款码 + 手动审核）。

接口：
  - GET  /api/billing/me              查当前用户的档位 / 每日额度 / 今日已用 / 今日剩余。
  - GET  /api/billing/plans           套餐列表（每日额度 + 价格）。
  - POST /api/billing/orders          为某档下单，返回收款码信息（微信/支付宝图片 + 联系方式）。
  - POST /api/billing/orders/{id}/claim  用户「我已支付」：订单转待审核 + 邮件通知运营。
  - GET  /api/billing/orders/{id}     查订单状态（前端慢轮询，纯读库）。

支付是**手动核对**模式：用户扫收款码付款 → 点「我已支付」→ 订单转 pending_review →
管理员在后台人工核对到账后放行（_fulfill_order）才升档。没有第三方渠道 / webhook，
用户点「我已支付」不会自动升档（防白嫖）。
"""

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import email
from app.billing import (
    TIER_DAILY,
    daily_allowance,
    effective_tier,
    grant_tier,
    price_of,
    tier_rank,
    used_today,
)
from app.db import get_db
from app.deps import get_current_user
from app.models.order import Order
from app.models.user import User
from app.runtime_config import cfg


async def _fulfill_order(db: AsyncSession, order: Order) -> None:
    """履约一笔订单：标记已付 + 升档 + 续期。**幂等** —— 已 paid 直接返回。

    只由管理员审核通过触发（admin/orders.py 的 approve）。续期规则：同档且还没过期 →
    在原到期日上叠加；换档 / 已过期 / 没买过 → 从现在起算。幂等保证重复点「通过」不会
    把到期时间一加再加。
    """
    if order.status == "paid":
        return
    now = datetime.now()
    order.status = "paid"
    order.paid_at = now
    order.reviewed_at = now

    user = await db.get(User, order.user_id)
    if user is not None:
        grant_tier(user, order.tier, now)

    await db.commit()


router = APIRouter(prefix="/api/billing", tags=["billing"])



class BillingStatus(BaseModel):
    """额度状态：给前端渲染「当前档位 + 今日还剩多少点」。"""
    tier: str           # 「生效」档位 free/pro/max（付费档过期会折算成 free）
    daily_allowance: int  # 该档每日额度
    used_today: int       # 今日已用点数（跨天已折算）
    remaining: int        # 今日剩余 = 额度 - 已用（不为负）
    expires_at: str | None  # 付费档到期时间（ISO 字符串）；free / 未付费为 None


def _status_of(user: User) -> BillingStatus:
    """从 User 算出额度状态。

    tier 取「生效档位」：付费档过了 tier_expires_at 会折算成 free —— 这样前端显示的档位 / 额度
    和真正生效的限流一致（不会显示 pro 却按 free 拦）。used_today 处理跨天。
    """
    now = datetime.now()
    eff = effective_tier(user, now)
    allowance = daily_allowance(eff)
    used = used_today(user, now.date())
    return BillingStatus(
        tier=eff,
        daily_allowance=allowance,
        used_today=used,
        remaining=max(0, allowance - used),
        expires_at=user.tier_expires_at.isoformat() if user.tier_expires_at else None,
    )


@router.get("/me", response_model=BillingStatus)
async def my_billing(current_user: User = Depends(get_current_user)) -> BillingStatus:
    """查当前用户的额度状态。只读，不写库。"""
    return _status_of(current_user)


class Plan(BaseModel):
    """一个套餐档位：给前端「升级」抽屉渲染。"""
    tier: str             # free/pro/max
    daily_allowance: int  # 每日点数额度
    price: str | None     # 价格（元字符串）；free 为 None（不可购买）


@router.get("/plans", response_model=list[Plan])
async def list_plans() -> list[Plan]:
    """套餐列表。每日额度 / 价格都由后端定义一份（TIER_DAILY / TIER_PRICE）派生，前端不硬编码，
    免得前后端数字对不上。顺序就是 TIER_DAILY 的定义顺序（free → pro → max）。
    """
    return [
        Plan(tier=tier, daily_allowance=allowance, price=price_of(tier))
        for tier, allowance in TIER_DAILY.items()
    ]


# ── 下单（返回收款码信息）───────────────────────────────────────────────────────
class CreateOrderRequest(BaseModel):
    tier: str  # 要购买的档位（pro / max；free 不可购买）


class CreateOrderResponse(BaseModel):
    order_id: str      # 我们的订单号，前端拿它去 claim / 轮询状态
    tier: str
    amount: str        # 金额（元）
    qr_wechat: str     # 微信收款码图片（data URI；未配置为空串）
    qr_alipay: str     # 支付宝收款码图片（data URI；未配置为空串）
    payee_name: str    # 收款人显示名（可选）
    contact: str       # 联系方式（展示在待审核页，供用户联系）


@router.post("/orders", response_model=CreateOrderResponse)
async def create_order(
    body: CreateOrderRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CreateOrderResponse:
    """创建一笔升级订单（pending），返回收款码信息让前端展示给用户扫码。

    此时**还没产生待审核订单/邮件通知** —— 只有用户扫码付款后点「我已支付」（claim）
    才把订单转 pending_review 并通知运营。
    """
    price = price_of(body.tier)
    if price is None:
        raise HTTPException(status_code=400, detail=f"不可购买的档位：{body.tier}")

    # 只能升级：目标档位必须比「当前生效档位」高（过期会按 free 算）。
    # 前端已置灰，但后端是安全边界，挡住「直接打接口降级 / 买当前档」。
    if tier_rank(body.tier) <= tier_rank(effective_tier(current_user, datetime.now())):
        raise HTTPException(status_code=400, detail="只能升级到更高档位")

    order_id = str(uuid.uuid4())
    order = Order(
        id=order_id,
        user_id=current_user.id,
        tier=body.tier,
        amount=price,
        status="pending",
    )
    db.add(order)
    await db.commit()

    return CreateOrderResponse(
        order_id=order_id,
        tier=body.tier,
        amount=price,
        qr_wechat=cfg.pay_qr_wechat,
        qr_alipay=cfg.pay_qr_alipay,
        payee_name=cfg.pay_payee_name,
        contact=cfg.pay_contact,
    )


# ── 我已支付（用户声明支付 → 转待审核 + 邮件通知运营）──────────────────────────────
class ClaimOrderRequest(BaseModel):
    payment_method: str        # 用户选的支付方式：wechat / alipay
    pay_note: str | None = None  # 付款备注（如尾号），可选


# 查单/claim 共用的响应体：订单状态。
class OrderStatusResponse(BaseModel):
    order_id: str
    tier: str
    amount: str
    status: str  # pending / pending_review / paid / rejected


@router.post("/orders/{order_id}/claim", response_model=OrderStatusResponse)
async def claim_order(
    order_id: str,
    body: ClaimOrderRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> OrderStatusResponse:
    """用户点「我已支付」：把订单转 pending_review，并给运营发邮件通知。

    只有 pending 的订单能 claim（幂等：已是 pending_review 直接返回当前状态，不重复发邮件）。
    邮件发送失败**不阻断**：订单已入库转待审核，运营在后台仍看得到。
    """
    order = await db.get(Order, order_id)
    if order is None or order.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="订单不存在")

    if order.status == "pending":
        if body.payment_method not in ("wechat", "alipay"):
            raise HTTPException(status_code=400, detail="支付方式不合法")
        order.status = "pending_review"
        order.payment_method = body.payment_method
        order.pay_note = (body.pay_note or "").strip() or None
        await db.commit()
        await db.refresh(order)

        # 发邮件通知运营；失败不影响订单已入库（后台仍可审）。
        try:
            await email.send_order_notify(
                cfg.order_notify_email,
                order_id=order.id,
                user_email=current_user.email,
                tier=order.tier,
                amount=order.amount,
                payment_method=order.payment_method,
                pay_note=order.pay_note,
                created_at=order.created_at,
            )
        except Exception:
            # 邮件是「锦上添花」，订单已在后台可见，吞掉异常不打断用户流程。
            pass

    return OrderStatusResponse(
        order_id=order.id,
        tier=order.tier,
        amount=order.amount,
        status=order.status,
    )


# ── 我的未结订单（抽屉打开时查：有未审核订单就直接进待审核态）──────────────────────
class MyPendingOrderResponse(BaseModel):
    order_id: str
    tier: str
    amount: str
    status: str   # pending / pending_review
    contact: str  # 联系方式（待审核态展示）


@router.get("/my-order", response_model=MyPendingOrderResponse | None)
async def my_pending_order(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> MyPendingOrderResponse | None:
    """查当前用户「最新一笔未结订单」（pending / pending_review）。

    给前端抽屉打开时用：有 pending_review 订单就直接展示「待审核」态、并把对应档位的
    升级按钮置为待审核，避免关掉抽屉再打开又看到「升级」按钮、重复下单。
    没有未结订单返回 null。
    """
    stmt = (
        select(Order)
        .where(
            Order.user_id == current_user.id,
            Order.status.in_(("pending", "pending_review")),
        )
        .order_by(Order.created_at.desc())
        .limit(1)
    )
    order = (await db.execute(stmt)).scalar_one_or_none()
    if order is None:
        return None
    return MyPendingOrderResponse(
        order_id=order.id,
        tier=order.tier,
        amount=order.amount,
        status=order.status,
        contact=cfg.pay_contact,
    )


# ── 查单（前端慢轮询：纯读库，无第三方核单）──────────────────────────────────────
@router.get("/orders/{order_id}", response_model=OrderStatusResponse)
async def get_order(
    order_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> OrderStatusResponse:
    """查一笔订单的状态，给前端轮询。纯读库 —— 升档由管理员后台审核触发。"""
    order = await db.get(Order, order_id)
    # 不存在 / 不是本人的，统一 404（不泄露别人订单是否存在）
    if order is None or order.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="订单不存在")

    return OrderStatusResponse(
        order_id=order.id, tier=order.tier, amount=order.amount, status=order.status
    )

