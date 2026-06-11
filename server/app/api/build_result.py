"""Build result API —— 接收前端 vite build 的结果。

前端在 WebContainer（浏览器沙箱）里跑 `vite build`，构建快慢取决于用户本机，和后端
无关。构建一结束，前端就把「成没成、错在哪」POST 到这里；后端的 check_build 工具正
挂在 build_store 上等这个结果，收到即被唤醒返回 —— 不再靠固定窗口轮询去猜构建多久。

详见 build_store.py 对这条「前端事件 → 后端 await」会合机制的说明。
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app import build_store
from app.deps import get_owned_session

# 沿用其它路由的层级风格：挂在具体 session 下面，并加归属守卫（只能往自己的会话报）。
router = APIRouter(
    prefix="/api/sessions/{session_id}/build-result",
    tags=["build-result"],
    dependencies=[Depends(get_owned_session)],
)


class BuildResult(BaseModel):
    """前端报回的构建结果。"""

    ok: bool  # 构建是否通过（vite build 退出码为 0）
    errors: str = ""  # 失败时的错误摘要；成功时空串


@router.post("", status_code=204)
async def report_build_result(session_id: str, body: BuildResult) -> None:
    """接收前端的构建结果，唤醒正在等待的 check_build。

    会话归属由路由级守卫 get_owned_session 把关。通过后，把结果交给 build_store，
    它会立旗唤醒挂在 wait 上的 check_build。返回 204：报到即可，没有 body 要回。
    """
    build_store.report(session_id, {"ok": body.ok, "errors": body.errors})
