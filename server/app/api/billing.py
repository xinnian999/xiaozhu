"""Billing API —— 额度查询 + 改档。

两个接口：
  - GET  /api/billing/me        查当前用户的档位 / 每日额度 / 今日已用 / 今日剩余（前端展示用）。
  - POST /api/billing/dev/set-tier  把当前用户切到 free/pro/max。

⚠️ set-tier 是「真实订阅支付」上线前的临时替身（付费第 3 步）：它让用户**给自己免费改档**，
   纯粹为了开发期能在浏览器里把额度调大调小、端到端验证扣费链路。
   第 5 步接入真实支付后，这个 dev 接口必须删掉或改成「只有支付成功的 webhook 能改档」——
   否则等于谁都能白嫖 max。
"""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.billing import TIER_DAILY, daily_allowance, used_today
from app.db import get_db
from app.deps import get_current_user
from app.models.user import User

router = APIRouter(prefix="/api/billing", tags=["billing"])


class BillingStatus(BaseModel):
    """额度状态：给前端渲染「当前档位 + 今日还剩多少点」。"""
    tier: str           # 当前档位 free/pro/max
    daily_allowance: int  # 该档每日额度
    used_today: int       # 今日已用点数（跨天已折算）
    remaining: int        # 今日剩余 = 额度 - 已用（不为负）


def _status_of(user: User) -> BillingStatus:
    """从 User 算出额度状态。used_today 处理跨天（daily_date 不是今天就当 0）。"""
    used = used_today(user, date.today())
    allowance = daily_allowance(user.tier)
    return BillingStatus(
        tier=user.tier,
        daily_allowance=allowance,
        used_today=used,
        remaining=max(0, allowance - used),
    )


@router.get("/me", response_model=BillingStatus)
async def my_billing(current_user: User = Depends(get_current_user)) -> BillingStatus:
    """查当前用户的额度状态。只读，不写库。"""
    return _status_of(current_user)


class Plan(BaseModel):
    """一个套餐档位：给前端「升级」抽屉渲染。"""
    tier: str             # free/pro/max
    daily_allowance: int  # 每日点数额度


@router.get("/plans", response_model=list[Plan])
async def list_plans() -> list[Plan]:
    """套餐列表。直接由 TIER_DAILY 派生 —— 每日额度只在后端定义一份，前端不再硬编码，
    免得前后端数字对不上。顺序就是 TIER_DAILY 的定义顺序（free → pro → max）。
    """
    return [Plan(tier=tier, daily_allowance=allowance) for tier, allowance in TIER_DAILY.items()]


class SetTierRequest(BaseModel):
    tier: str  # 只能是 TIER_DAILY 里的键：free/pro/max


@router.post("/dev/set-tier", response_model=BillingStatus)
async def dev_set_tier(
    body: SetTierRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> BillingStatus:
    """【开发期临时】把当前用户切到指定档位，返回切换后的额度状态。

    只校验档位合法（必须在 TIER_DAILY 里），不做任何支付/权限校验 —— 见模块顶部警告。
    不动 daily_used：改档只换「每日上限」，今天已用的不清零（更贴近真实订阅的体感）。
    """
    if body.tier not in TIER_DAILY:
        raise HTTPException(
            status_code=400,
            detail=f"非法档位 {body.tier}，可选：{list(TIER_DAILY)}",
        )
    current_user.tier = body.tier
    await db.commit()
    return _status_of(current_user)
