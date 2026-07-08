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
from app.models.user import User

router = APIRouter(prefix="/boot-failures", tags=["admin-boot-failures"])


def _apply_kind_filter(stmt, kind: str | None):
    """按 kind 查询参数给语句加 where。
      - None：不加条件，全量（含成功 ok）
      - 'fail'：只看失败（kind != 'ok'）
      - 其他（'ok' / 'timeout' / 'error'）：精确匹配该 kind
    """
    if kind is None:
        return stmt
    if kind == "fail":
        return stmt.where(BootFailure.kind != "ok")
    return stmt.where(BootFailure.kind == kind)


@router.get("", response_model=list[BootFailureAdminRead])
async def list_boot_failures(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=200),
    # kind 过滤：不传 = 全量（含成功 ok）；传 'ok' / 'timeout' / 'error' 只看该类；
    # 传 'fail' 是快捷值 = 只看失败（timeout + error，排除 ok）。
    kind: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[BootFailureAdminRead]:
    # LEFT JOIN users：把 user_id 换成昵称 + 邮箱展示（裸 id 看了没意义）。
    # 用 outerjoin —— user_id 可空 / 用户可能已删，join 不上时昵称邮箱为 None，记录仍要显示。
    stmt = select(BootFailure, User.nickname, User.email).outerjoin(
        User, BootFailure.user_id == User.id
    )
    stmt = _apply_kind_filter(stmt, kind)
    stmt = stmt.order_by(BootFailure.created_at.desc()).offset(offset).limit(limit)
    result = await db.execute(stmt)
    out: list[BootFailureAdminRead] = []
    for bf, nickname, email in result.all():
        row = BootFailureAdminRead.model_validate(bf)
        row.user_nickname = nickname
        row.user_email = email
        out.append(row)
    return out


@router.get("/count", response_model=int)
async def count_boot_failures(
    kind: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> int:
    stmt = _apply_kind_filter(select(func.count()).select_from(BootFailure), kind)
    result = await db.execute(stmt)
    return result.scalar_one()


@router.get("/recent-count", response_model=int)
async def recent_boot_failures(
    hours: int = Query(default=24, ge=1, le=720),
    db: AsyncSession = Depends(get_db),
) -> int:
    """最近 N 小时的失败数（timeout + error，排除成功），后台顶部展示「近 24h 失败」用。"""
    since = datetime.utcnow() - timedelta(hours=hours)
    result = await db.execute(
        select(func.count())
        .select_from(BootFailure)
        .where(BootFailure.kind != "ok", BootFailure.created_at >= since)
    )
    return result.scalar_one()


@router.get("/boot-stats", response_model=dict)
async def boot_stats(db: AsyncSession = Depends(get_db)) -> dict:
    """boot 耗时统计 —— 回答「boot 到底多快/多慢、失败多频繁」。

    - success：成功 boot（kind='ok'）的样本数 + 平均/最快/最慢耗时，再按冷/热分组。
    - failed：失败样本数（timeout / error 各自计数）。
    - buckets：成功耗时的分布直方图（按秒分档），用来看慢的样本是不是扎堆在某个档
      （比如都卡在 ~78s → 强烈指向固定限速，而非随机拥塞）。
    """

    def _agg_where(*extra):
        return (
            select(
                func.count(),
                func.avg(BootFailure.elapsed_ms),
                func.min(BootFailure.elapsed_ms),
                func.max(BootFailure.elapsed_ms),
            )
            .select_from(BootFailure)
            .where(BootFailure.elapsed_ms.isnot(None), *extra)
        )

    async def _stat(*extra) -> dict:
        count, avg_ms, min_ms, max_ms = (await db.execute(_agg_where(*extra))).one()
        return {
            "count": count,
            "avg_ms": round(avg_ms) if avg_ms is not None else None,
            "min_ms": min_ms,
            "max_ms": max_ms,
        }

    ok = BootFailure.kind == "ok"
    success = await _stat(ok)
    success_cold = await _stat(ok, BootFailure.cold.is_(True))
    success_hot = await _stat(ok, BootFailure.cold.is_(False))

    # 失败按类型计数
    fail_rows = (
        await db.execute(
            select(BootFailure.kind, func.count())
            .select_from(BootFailure)
            .where(BootFailure.kind != "ok")
            .group_by(BootFailure.kind)
        )
    ).all()
    failed = {k: c for k, c in fail_rows}

    # 成功耗时分布直方图：按秒分档 [0,5),[5,15),[15,30),[30,60),[60,120),[120,∞)
    # 用 CASE 归档，一次查询出各档计数。
    bucket_bounds = [0, 5000, 15000, 30000, 60000, 120000]
    bucket_labels = ["<5s", "5-15s", "15-30s", "30-60s", "60-120s", ">120s"]
    buckets: list[dict] = []
    for i, label in enumerate(bucket_labels):
        lo = bucket_bounds[i]
        hi = bucket_bounds[i + 1] if i + 1 < len(bucket_bounds) else None
        cond = [ok, BootFailure.elapsed_ms.isnot(None), BootFailure.elapsed_ms >= lo]
        if hi is not None:
            cond.append(BootFailure.elapsed_ms < hi)
        c = (
            await db.execute(select(func.count()).select_from(BootFailure).where(*cond))
        ).scalar_one()
        buckets.append({"label": label, "count": c})

    return {
        "success": success,
        "success_cold": success_cold,
        "success_hot": success_hot,
        "failed": failed,
        "buckets": buckets,
    }
