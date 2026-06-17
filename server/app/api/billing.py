"""Billing API —— 额度查询 + 套餐购买（支付宝）。

接口：
  - GET  /api/billing/me            查当前用户的档位 / 每日额度 / 今日已用 / 今日剩余。
  - GET  /api/billing/plans         套餐列表（每日额度 + 价格）。
  - POST /api/billing/orders        为某档下单，返回支付二维码。
  - GET  /api/billing/orders/{id}   查订单状态（前端轮询；后端主动问支付宝）。
  - POST /api/billing/notify/alipay 支付宝异步回调（生产用，验签）。

升档只能靠「支付成功」触发（_fulfill_order）。早期那个让用户免费改档的 dev/set-tier 已删除，
避免任何人白嫖高档。
"""

import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.alipay import build_alipay
from app.billing import TIER_DAILY, daily_allowance, effective_tier, price_of, used_today
from app.db import AsyncSessionLocal, get_db
from app.deps import get_current_user
from app.models.order import Order
from app.models.user import User

# 月卡时长（天）。一笔支付让用户的付费档延长这么久。
SUBSCRIPTION_DAYS = 30


async def _fulfill_order(db: AsyncSession, order: Order) -> None:
    """履约一笔订单：标记已付 + 升档 + 续期。**幂等** —— 已 paid 直接返回。

    查单（本地）和异步回调（生产）都调它，两条路都可能对同一笔订单触发，所以必须幂等，
    否则重复回调会把到期时间一加再加。续期规则：同档且还没过期 → 在原到期日上叠加；
    换档 / 已过期 / 没买过 → 从现在起算。
    """
    if order.status == "paid":
        return
    now = datetime.now()
    order.status = "paid"
    order.paid_at = now

    user = await db.get(User, order.user_id)
    if user is not None:
        if user.tier == order.tier and user.tier_expires_at and user.tier_expires_at > now:
            new_exp = user.tier_expires_at + timedelta(days=SUBSCRIPTION_DAYS)
        else:
            new_exp = now + timedelta(days=SUBSCRIPTION_DAYS)
        user.tier = order.tier
        user.tier_expires_at = new_exp

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


# ── 下单（当面付·扫码）─────────────────────────────────────────────────────────
class CreateOrderRequest(BaseModel):
    tier: str  # 要购买的档位（pro / max；free 不可购买）


class CreateOrderResponse(BaseModel):
    order_id: str  # 我们的订单号（= 支付宝 out_trade_no），前端拿它去轮询状态
    tier: str
    amount: str    # 金额（元）
    qr_code: str   # 支付宝返回的二维码内容，前端渲染成二维码让用户扫


@router.post("/orders", response_model=CreateOrderResponse)
async def create_order(
    body: CreateOrderRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CreateOrderResponse:
    """创建一笔升级订单并向支付宝下单，返回二维码。

    顺序很关键：**先调支付宝拿到二维码、成功了才把订单落库**。这样下单失败就不会在库里
    留一堆永远 pending 的脏订单。订单号用我们自己生成的 UUID，同时充当支付宝的 out_trade_no
    （幂等键）。
    """
    price = price_of(body.tier)
    if price is None:
        raise HTTPException(status_code=400, detail=f"不可购买的档位：{body.tier}")

    # 自己生成订单号（在调支付宝前就要有，作 out_trade_no）
    order_id = str(uuid.uuid4())

    # build_alipay 未配置会抛 HTTPException(500)，直接透传给前端
    alipay = build_alipay()
    # SDK 是同步阻塞（urllib），丢到线程池里跑，避免堵住 async 事件循环
    try:
        result = await run_in_threadpool(
            alipay.api_alipay_trade_precreate,
            out_trade_no=order_id,
            total_amount=price,
            subject=f"Vibuild 订阅升级 - {body.tier}",
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"调用支付宝失败：{e}") from e

    if result.get("code") != "10000":
        # 支付宝业务报错（如未签约当面付、参数不对），把 sub_msg 透出来好排查
        detail = result.get("sub_msg") or result.get("msg") or "未知错误"
        raise HTTPException(status_code=502, detail=f"支付宝下单失败：{detail}")

    # 拿到二维码了，落库订单（pending）
    order = Order(id=order_id, user_id=current_user.id, tier=body.tier, amount=price, status="pending")
    db.add(order)
    await db.commit()

    return CreateOrderResponse(
        order_id=order_id, tier=body.tier, amount=price, qr_code=result["qr_code"]
    )


# ── 查单（前端轮询：本地不用内网穿透，由后端主动问支付宝）────────────────────────
class OrderStatusResponse(BaseModel):
    order_id: str
    tier: str
    amount: str
    status: str  # pending / paid


@router.get("/orders/{order_id}", response_model=OrderStatusResponse)
async def get_order(
    order_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> OrderStatusResponse:
    """查一笔订单的状态，给前端轮询。

    若订单还 pending，就**主动调 alipay.trade.query** 问支付宝这笔到账没 —— 本地联调靠这招
    确认支付，不需要公网回调（内网穿透）。一旦支付宝说成功，就 _fulfill_order（升档+续期）。
    """
    order = await db.get(Order, order_id)
    # 不存在 / 不是本人的，统一 404（不泄露别人订单是否存在）
    if order is None or order.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="订单不存在")

    if order.status == "pending":
        alipay = build_alipay()
        try:
            result = await run_in_threadpool(alipay.api_alipay_trade_query, out_trade_no=order_id)
        except Exception:
            result = {}
        # 只有支付宝明确返回成功，才认定到账；WAIT_BUYER_PAY / 订单不存在都按未付处理
        trade_status = result.get("trade_status") if result.get("code") == "10000" else None
        if trade_status in ("TRADE_SUCCESS", "TRADE_FINISHED"):
            await _fulfill_order(db, order)

    return OrderStatusResponse(
        order_id=order.id, tier=order.tier, amount=order.amount, status=order.status
    )


# ── 异步回调（生产用：支付宝支付成功后 POST 通知到这里）────────────────────────────
@router.post("/notify/alipay")
async def alipay_notify(request: Request) -> PlainTextResponse:
    """支付宝异步通知。**无鉴权**（是支付宝服务器来调，不是用户），靠验签保证可信。

    本地联调一般用不到它（走查单即可），它是给生产兜底的：哪怕用户付完就关页面，
    支付宝也会异步通知到这里把订单履约。要它生效需 ALIPAY_NOTIFY_URL 配成公网可达地址。

    几个铁律都在这：**验签**（防伪造）、**核对金额**（防篡改）、**幂等**（_fulfill_order 已保证）、
    成功必须回纯文本 "success"（否则支付宝会反复重推）。
    """
    form = await request.form()
    data = {k: v for k, v in form.items()}
    signature = data.pop("sign", None)
    data.pop("sign_type", None)

    alipay = build_alipay()
    if not signature or not alipay.verify(data, signature):
        # 验签不过：可能是伪造请求，直接拒，不动任何订单
        return PlainTextResponse("failure")

    if data.get("trade_status") in ("TRADE_SUCCESS", "TRADE_FINISHED"):
        out_trade_no = data.get("out_trade_no")
        # 回调里 db 不走 Depends（这是支付宝调的，没有请求级依赖），自己开一个 session
        async with AsyncSessionLocal() as db:
            order = await db.get(Order, out_trade_no)
            # 核对金额：支付宝回传的 total_amount 必须和我们下单时存的一致，防篡改
            if order is not None and data.get("total_amount") == order.amount:
                await _fulfill_order(db, order)

    return PlainTextResponse("success")
