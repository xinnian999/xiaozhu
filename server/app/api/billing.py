"""Billing API —— 额度查询 + 套餐购买（爱发电）。

接口：
  - GET  /api/billing/me            查当前用户的档位 / 每日额度 / 今日已用 / 今日剩余。
  - GET  /api/billing/plans         套餐列表（每日额度 + 价格）。
  - POST /api/billing/orders        为某档下单，返回爱发电下单页链接。
  - GET  /api/billing/orders/{id}   查订单状态（前端轮询；后端兜底查爱发电订单）。
  - POST /api/billing/notify/afdian 爱发电 webhook（用户付款后通知，主动核单后升档）。

唯一支付渠道是**爱发电**。升档只能靠「支付成功」触发（_fulfill_order）。早期那个让用户免费改档的
dev/set-tier 已删除，避免任何人白嫖高档。
"""

import uuid
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app import afdian
from app.billing import (
    TIER_DAILY,
    daily_allowance,
    effective_tier,
    price_of,
    tier_rank,
    used_today,
)
from app.db import AsyncSessionLocal, get_db
from app.deps import get_current_user
from app.models.order import Order
from app.models.user import User

# 月卡时长（天）。一笔支付让用户的付费档延长这么久。
SUBSCRIPTION_DAYS = 30


async def _fulfill_order(db: AsyncSession, order: Order) -> None:
    """履约一笔订单：标记已付 + 升档 + 续期。**幂等** —— 已 paid 直接返回。

    webhook（付款即推）和前端轮询的兜底查单都可能对同一笔订单触发，所以必须幂等，
    否则重复触发会把到期时间一加再加。续期规则：同档且还没过期 → 在原到期日上叠加；
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


def _amount_eq(a: str | None, b: str | None) -> bool:
    """按数值比较两个金额字符串（"9.90" == "9.9"），任一非法/为空都判不等。

    核单防篡改用：爱发电回传的金额必须和我们下单时存的一致。用 Decimal 比数值，
    免得被 "9.9"/"9.90" 这种等价但字面不同的写法误伤。
    """
    if not a or not b:
        return False
    try:
        return Decimal(a) == Decimal(b)
    except (InvalidOperation, ValueError):
        return False


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


# ── 下单（爱发电）─────────────────────────────────────────────────────────────
class CreateOrderRequest(BaseModel):
    tier: str  # 要购买的档位（pro / max；free 不可购买）


class CreateOrderResponse(BaseModel):
    order_id: str  # 我们的订单号（爱发电下单页的 custom_order_id），前端拿它去轮询状态
    tier: str
    amount: str    # 金额（元）
    pay_url: str   # 爱发电下单页链接，前端新开标签页让用户付款


@router.post("/orders", response_model=CreateOrderResponse)
async def create_order(
    body: CreateOrderRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CreateOrderResponse:
    """创建一笔升级订单，返回爱发电下单页链接。

    生成链接是**纯本地拼串、不联网**：把我们的 UUID 订单号塞进爱发电下单页的 custom_order_id，
    用户付款后爱发电会把它原样回传到 webhook，用来把这笔爱发电订单对回我们系统的用户。
    """
    price = price_of(body.tier)
    if price is None:
        raise HTTPException(status_code=400, detail=f"不可购买的档位：{body.tier}")

    # 只能升级：目标档位必须比「当前生效档位」高（过期会按 free 算）。
    # 前端已置灰，但后端是安全边界，挡住「直接打接口降级 / 买当前档」。
    if tier_rank(body.tier) <= tier_rank(effective_tier(current_user, datetime.now())):
        raise HTTPException(status_code=400, detail="只能升级到更高档位")

    # 自己生成订单号，作爱发电下单页的 custom_order_id 透传（幂等键）
    order_id = str(uuid.uuid4())
    # 拼带 custom_order_id 的爱发电下单页链接（未配置商品会抛 HTTPException(500)）
    pay_url = afdian.build_pay_url(body.tier, order_id)

    # 落库订单（pending）；等用户付款后由 webhook / 兜底查单转 paid。
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
        order_id=order_id, tier=body.tier, amount=price, pay_url=pay_url
    )


# ── 查单（前端轮询：webhook 的兜底，后端主动查爱发电订单）────────────────────────
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

    若订单还 pending，就按 custom_order_id 翻爱发电最近订单**兜底查单**。webhook 是主路（付款即推），
    这里是补漏 —— 万一 webhook 漏推，前端轮询也能把订单转 paid。
    """
    order = await db.get(Order, order_id)
    # 不存在 / 不是本人的，统一 404（不泄露别人订单是否存在）
    if order is None or order.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="订单不存在")

    if order.status == "pending":
        try:
            af = await afdian.find_order_by_custom_id(order.id)
        except Exception:
            af = None
        # status == 2 为成功；核对金额防篡改（兑换码/改价会对不上，按未付处理）
        if af and af.get("status") == 2 and _amount_eq(af.get("total_amount"), order.amount):
            await _fulfill_order(db, order)

    return OrderStatusResponse(
        order_id=order.id, tier=order.tier, amount=order.amount, status=order.status
    )


# ── 爱发电异步回调（webhook：用户付款后爱发电 POST 通知到这里）────────────────────
@router.post("/notify/afdian")
async def afdian_notify(request: Request) -> JSONResponse:
    """爱发电 webhook。**无鉴权**（爱发电服务器来调），靠「主动核单」保证可信。

    安全要点：**绝不轻信 webhook 报文里的金额/状态**。只从报文里取两个 id（custom_order_id =
    我们的订单号、out_trade_no = 爱发电订单号），再用我们的 token 签名去调 query-order
    **重新拉这笔订单**，金额、状态都以接口返回为准 —— 这样伪造的 webhook 无法白嫖升档。

    幂等：_fulfill_order 已保证重复推送无害。爱发电只看响应里的 ec 是否为 200，所以无论是否命中
    订单都回 {"ec":200}，避免它反复重推；偶发漏处理由前端轮询的兜底查单（get_order）补上。
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    order_data = (((body or {}).get("data") or {}).get("order")) or {}
    custom_order_id = order_data.get("custom_order_id")
    out_trade_no = order_data.get("out_trade_no")

    if custom_order_id and out_trade_no:
        # 主动核单：以接口返回为准，不信 webhook 报文
        try:
            af = await afdian.query_order(out_trade_no)
        except Exception:
            af = None
        # 三重校验：接口查得到 + 状态成功(2) + custom_order_id 对得上
        if af and af.get("status") == 2 and af.get("custom_order_id") == custom_order_id:
            async with AsyncSessionLocal() as db:
                order = await db.get(Order, custom_order_id)
                # 金额一致才升档（防篡改 / 防张冠李戴）
                if order is not None and _amount_eq(af.get("total_amount"), order.amount):
                    await _fulfill_order(db, order)

    return JSONResponse({"ec": 200, "em": ""})
