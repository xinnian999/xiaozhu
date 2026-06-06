"""Browser logs API —— 接收前端推来的预览 console 日志。

前端的 WebContainer 预览跑在浏览器 iframe 里，它的报错只有浏览器看得到。
后端的 agent 想知道「我写的代码跑起来报错没」，就得让前端先把这些日志推过来。
这个端点就是那条「前端 → 后端」的回传通道。

日志存内存（log_store），不进数据库 —— 详见 log_store.py 的说明。
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.deps import get_owned_session
from app.log_store import BrowserLog, append_logs

# 沿用其它路由的层级风格：挂在具体 session 下面。
# 同样加上归属守卫：日志虽是旁路数据，但也只该往「自己的会话」里推，防止越权写别人的缓存。
router = APIRouter(
    prefix="/api/sessions/{session_id}/logs",
    tags=["logs"],
    dependencies=[Depends(get_owned_session)],
)


class LogPush(BaseModel):
    """前端推日志的请求体：一批日志一起发，减少请求次数。"""

    logs: list[BrowserLog]


@router.post("", status_code=204)
async def push_logs(session_id: str, body: LogPush) -> None:
    """接收前端推来的一批浏览器日志，存进内存缓存。

    会话归属由路由级守卫 get_owned_session 把关（必须是自己的会话）。
    通过守卫后，这里只管把日志存进内存缓存即可。
    返回 204 No Content：存成功就行，没有 body 要返回。
    """
    append_logs(session_id, body.logs)
