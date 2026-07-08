"""Boot result API —— 接收前端「预览运行环境 boot 结果」的上报。

WebContainer 的运行时需从境外 boot，国内偶发失败/很慢。前端每次 boot 结束都 POST 到这里：
成功报 kind='ok' + 耗时，失败报 timeout/error + 原因。落 boot_failures 表，管理后台据此
统计 boot 耗时分布 + 监控失败率、定位偶发原因。

上报要求登录（能进到预览一定已登录，见前端 AuthGate），这样能顺带记下 user_id；
但走 best-effort：即便这里出错也不该影响用户，所以前端调用是静默的。
"""

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_user
from app.models.boot_failure import BootFailure, BootFailureReport
from app.models.user import User

router = APIRouter(prefix="/api/boot-failure", tags=["boot-failure"])


@router.post("", status_code=204)
async def report_boot_failure(
    body: BootFailureReport,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """记录一次 boot 结果。user_id 从登录态取，UA 从请求头取，其余由前端上报。

    成功（kind='ok'）与失败（timeout/error）都会调这里，用于统计 boot 耗时分布 + 失败率。
    """
    # message 兜个上限，别让异常堆栈把表撑爆。
    message = (body.message or "")[:2000]
    ua = (request.headers.get("user-agent") or "")[:500]
    db.add(
        BootFailure(
            session_id=body.session_id,
            user_id=user.id,
            stage=body.stage or "booting",
            kind=body.kind or "error",
            message=message,
            cross_origin_isolated=body.cross_origin_isolated,
            elapsed_ms=body.elapsed_ms,
            cold=body.cold,
            user_agent=ua,
        )
    )
    await db.commit()
