"""管理后台 —— 预览 boot 失败监控（只读）。

WebContainer 运行环境从境外 boot，国内偶发失败。前端把失败上报到 boot_failures 表，
这里给后台列出来 + 统计近 24h 失败数，用于监控失败率、定位偶发原因。只读，不提供改。
"""

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models.boot_failure import BootFailure, BootFailureAdminRead

router = APIRouter(prefix="/boot-failures", tags=["admin-boot-failures"])


@router.get("", response_model=list[BootFailureAdminRead])
async def list_boot_failures(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> list[BootFailure]:
    stmt = (
        select(BootFailure)
        .order_by(BootFailure.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.get("/count", response_model=int)
async def count_boot_failures(db: AsyncSession = Depends(get_db)) -> int:
    result = await db.execute(select(func.count()).select_from(BootFailure))
    return result.scalar_one()


@router.get("/recent-count", response_model=int)
async def recent_boot_failures(
    hours: int = Query(default=24, ge=1, le=720),
    db: AsyncSession = Depends(get_db),
) -> int:
    """最近 N 小时的失败数，后台顶部展示「近 24h 失败」用。"""
    since = datetime.utcnow() - timedelta(hours=hours)
    result = await db.execute(
        select(func.count()).select_from(BootFailure).where(BootFailure.created_at >= since)
    )
    return result.scalar_one()
