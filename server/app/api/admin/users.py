"""管理后台 —— 用户管理。

对齐 admin.py 里的 UserAdmin：
  - 列表：分页 + 按邮箱/昵称搜索。
  - 编辑：改昵称/档位/额度/到期时间/管理员标记；不可创建（用户由前台注册）、不碰密码哈希。
  - 续费/升级：批量操作，复用 app.billing.grant_tier（同档叠加、换档/过期重算）。
"""

from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.billing import SUBSCRIPTION_DAYS, grant_tier
from app.db import get_db
from app.models.user import GrantTierRequest, User, UserAdminRead, UserAdminUpdate

router = APIRouter(prefix="/users", tags=["admin-users"])


@router.get("", response_model=list[UserAdminRead])
async def list_users(
    q: str | None = Query(default=None, description="按邮箱/昵称搜索"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> list[User]:
    """用户列表，支持分页 + 搜索。按创建时间倒序，和 SQLAdmin 默认排序习惯一致。"""
    stmt = select(User).order_by(User.created_at.desc())
    if q:
        stmt = stmt.where(User.email.contains(q) | User.nickname.contains(q))
    stmt = stmt.offset(offset).limit(limit)
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.get("/count", response_model=int)
async def count_users(
    q: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> int:
    """配合分页列表用的总数，前端渲染分页器需要。"""
    stmt = select(func.count()).select_from(User)
    if q:
        stmt = stmt.where(User.email.contains(q) | User.nickname.contains(q))
    result = await db.execute(stmt)
    return result.scalar_one()


@router.patch("/{user_id}", response_model=UserAdminRead)
async def update_user(
    user_id: str,
    body: UserAdminUpdate,
    db: AsyncSession = Depends(get_db),
) -> User:
    """编辑用户：改昵称/档位/额度/管理员标记。

    「到期时间」和「用量日期」不再由前端手动填，改为后端静默维护：
      - 切换档位到付费档（pro/max）时，到期时间自动从今天起算 SUBSCRIPTION_DAYS 天；
        档位没变则保持原到期时间不动（续费请用下面的 grant-tier 批量接口）。
      - 切回 free 时，清空到期时间。
      - 改了「今日已用点数」时，用量日期同步成今天，避免跨天判断错乱。
    """
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="用户不存在")

    data = body.model_dump(exclude_unset=True)
    now = datetime.now()

    # 到期时间静默处理：只认「档位是否变化」，前端传来的日期一律忽略
    data.pop("tier_expires_at", None)
    data.pop("daily_date", None)

    if "tier" in data:
        new_tier = data.pop("tier")
        if new_tier == "free":
            # 降回免费档：清掉到期时间
            user.tier = "free"
            user.tier_expires_at = None
        elif new_tier != user.tier:
            # 切到新的付费档：从今天起算 SUBSCRIPTION_DAYS 天
            user.tier = new_tier
            user.tier_expires_at = now + timedelta(days=SUBSCRIPTION_DAYS)
        # else：档位没变，保持原到期时间不动

    # 改了当日用量：把用量日期钉到今天，否则会被当成「昨天的用量」清零
    if "daily_used" in data:
        user.daily_date = date.today()

    for field, value in data.items():
        setattr(user, field, value)
    await db.commit()
    await db.refresh(user)
    return user


@router.post("/grant-tier", response_model=list[UserAdminRead])
async def grant_tier_batch(
    body: GrantTierRequest,
    db: AsyncSession = Depends(get_db),
) -> list[User]:
    """批量续费/升级档位（对齐 admin.py 的 grant_pro_30 / grant_max_30 两个 action）。

    同档未过期会在原到期日上叠加 SUBSCRIPTION_DAYS 天，否则从现在起算 ——
    规则完全复用 app.billing.grant_tier，与真实支付履约一致。
    """
    if body.tier not in ("pro", "max"):
        raise HTTPException(status_code=400, detail="tier 只能是 pro 或 max")

    result = await db.execute(select(User).where(User.id.in_(body.user_ids)))
    users = list(result.scalars().all())
    now = datetime.now()
    for user in users:
        grant_tier(user, body.tier, now, SUBSCRIPTION_DAYS)
    await db.commit()
    for user in users:
        await db.refresh(user)
    return users
