"""Build result API —— 接收前端 vite build 的结果。

前端在 WebContainer（浏览器沙箱）里跑 `vite build`，构建快慢取决于用户本机，和后端
无关。构建一结束，前端就把「成没成、错在哪」POST 到这里；后端的 check_build 工具正
挂在 build_store 上等这个结果，收到即被唤醒返回 —— 不再靠固定窗口轮询去猜构建多久。

详见 build_store.py 对这条「前端事件 → 后端 await」会合机制的说明。
"""

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

    覆盖编译、运行时与布局验收三类报错（前端在 vite build 后、iframe 重载渲染收集完一并回报）：
    - 编译没过：ok=false, runtime=false
    - 编译过但渲染时崩：ok=false, runtime=true
    - 编译运行正常但布局溢出 / 只适配手机画布：ok=false, visual=true
    - 都没问题：ok=true
    """

    # check_build 对应的 tool_call_id。它和 session_id 共同定位唯一会合点，防止上一轮
    # 迟到的结果误唤醒下一轮。
    check_id: str = Field(min_length=1, max_length=512)
    ok: bool  # 构建、运行和基础布局验收是否都通过
    errors: str = ""  # 报错摘要；ok=true 时空串
    runtime: bool = False  # 报错是「运行时」还是「编译期」—— 供 check_build 区分文案
    visual: bool = False  # 是否命中浏览器端布局完整性检查
    # 截图先通过独立原始 body 接口上传，这里只关联服务端生成的轻量 ID。
    screenshot_id: str | None = None


@router.post("", status_code=204)
async def report_build_result(session_id: str, body: BuildResult) -> None:
    """接收前端的构建结果，唤醒正在等待的 check_build。

    会话归属由路由级守卫 get_owned_session 把关。通过后，把结果交给 build_store，
    它会立旗唤醒挂在 wait 上的 check_build。返回 204：报到即可，没有 body 要回。
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

    accepted = build_store.report(
        session_id,
        body.check_id,
        {
            "ok": body.ok,
            "errors": body.errors,
            "runtime": body.runtime,
            "visual": body.visual,
            "screenshot_id": screenshot_id,
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
