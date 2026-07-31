"""Build result API —— 接收浏览器预览的增强结果。

独立 sandbox-worker 跑 `vite build`，构建速度取决于 Worker 的资源配额。主后端
会直接调用 Worker 得到 Agent 所需的编译结论，不等待浏览器。浏览器在线时仍会把 iframe
运行结果与截图 POST 到这里，供当前页面展示；断线、刷新或关闭页面不会阻塞生成任务。
"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app import build_store
from app.deps import get_owned_session
from app.preview_screenshots import get_screenshot, remove_screenshot

# 沿用其它路由的层级风格：挂在具体 session 下面，并加归属守卫（只能往自己的会话报）。
router = APIRouter(
    prefix="/api/sessions/{session_id}/build-result",
    tags=["build-result"],
    dependencies=[Depends(get_owned_session)],
)


class BuildResult(BaseModel):
    """前端报回的构建结果。

    覆盖编译与运行时两类报错（前端在 vite build 后、iframe 重载渲染收集完一并回报）：
    - 编译没过：ok=false, runtime=false
    - 编译过但渲染时崩：ok=false, runtime=true
    - 预览网络/bridge 验收失败：ok=false, infrastructure=true
    - 都没问题：ok=true
    """

    # check_build 对应的 tool_call_id。它和 session_id 共同定位唯一会合点，防止上一轮
    # 迟到的结果误唤醒下一轮。
    check_id: str = Field(min_length=1, max_length=512)
    ok: bool  # 构建与运行是否都通过
    errors: str = ""  # 报错摘要；ok=true 时空串
    runtime: bool = False  # 报错是「运行时」还是「编译期」—— 供 check_build 区分文案
    # iframe 导航、bridge ready 等验收链路异常不是用户代码错误，Agent 不应据此改代码。
    infrastructure: bool = False
    # 兼容部署切换期间仍打开着的旧前端；新前端不再发送启发式布局探针结果。
    visual: bool = False
    # 截图先通过独立原始 body 接口上传，这里只关联服务端生成的轻量 ID。
    screenshot_id: str | None = None
    # 没有截图（如编译失败）时也要告诉 Agent 这次验证的是哪种画布。
    device: Literal["desktop", "mobile"] = "desktop"


def _normalize_build_outcome(body: BuildResult) -> tuple[bool, str]:
    """丢弃旧前端产生的启发式布局误报，只保留真实编译/运行错误。"""
    if not body.visual:
        return body.ok, body.errors

    errors = "\n".join(
        line
        for line in body.errors.splitlines()
        if not line.strip().startswith("[布局验收]")
    ).strip()
    return body.ok or (not body.runtime and not errors), errors


@router.post("", status_code=204)
async def report_build_result(session_id: str, body: BuildResult) -> None:
    """接收在线浏览器的运行结果与截图。

    会话归属由路由级守卫 get_owned_session 把关。build_store 只用于校验这次可选回报
    是否仍属于当前 check_id，不再承担 Agent 推进的会合职责。
    """
    # 上传请求可能已经在服务端成功 commit，但响应在网络上丢失，前端只好回报
    # screenshot_id=None。waiter 仍记得那张图，此处自动补上，避免孤儿文件和漏传 Agent。
    screenshot_id = body.screenshot_id or build_store.screenshot_for_check(
        session_id,
        body.check_id,
    )
    screenshot = None
    if screenshot_id is not None:
        if not build_store.owns_screenshot(
            session_id,
            body.check_id,
            screenshot_id,
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="截图不属于本次构建检查",
            )
        # 不能只相信客户端给的 ID：必须确认它真实存在且就在当前会话目录下。
        # get_owned_session 已保证当前用户拥有这个 session，这里再收紧到截图归属。
        screenshot = await get_screenshot(session_id, screenshot_id)
        if screenshot is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="截图不存在",
            )

    # 旧 bridge 会把 fixed + transform 的正常底部弹层误算成 203px 横向溢出。
    # 服务端在热更新期间也必须忽略这类历史结果，避免旧标签页继续误导 Agent。
    ok, errors = _normalize_build_outcome(body)

    accepted = build_store.report(
        session_id,
        body.check_id,
        {
            "ok": ok,
            "errors": errors,
            "runtime": body.runtime,
            "infrastructure": body.infrastructure,
            "screenshot_id": screenshot_id,
            "device": screenshot.device if screenshot is not None else body.device,
        },
    )
    if not accepted:
        # waiter 恰好在归属校验与 report 之间超时：这张图已没有消费者，及时回滚。
        if screenshot is not None:
            await remove_screenshot(screenshot)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="本次构建检查已结束",
        )
