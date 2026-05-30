"""Browser logs API —— 接收前端推来的预览 console 日志。

前端的 WebContainer 预览跑在浏览器 iframe 里，它的报错只有浏览器看得到。
后端的 agent 想知道「我写的代码跑起来报错没」，就得让前端先把这些日志推过来。
这个端点就是那条「前端 → 后端」的回传通道。

日志存内存（log_store），不进数据库 —— 详见 log_store.py 的说明。
"""

from fastapi import APIRouter
from pydantic import BaseModel

from app.log_store import BrowserLog, append_logs

# 沿用其它路由的层级风格：挂在具体 session 下面
router = APIRouter(prefix="/api/sessions/{session_id}/logs", tags=["logs"])


class LogPush(BaseModel):
    """前端推日志的请求体：一批日志一起发，减少请求次数。"""

    logs: list[BrowserLog]


@router.post("", status_code=204)
async def push_logs(session_id: str, body: LogPush) -> None:
    """接收前端推来的一批浏览器日志，存进内存缓存。

    这里故意不校验 session 是否存在 —— 日志是「尽力而为」的旁路数据，
    校验失败也不该影响主流程，直接存下即可。
    返回 204 No Content：存成功就行，没有 body 要返回。
    """
    append_logs(session_id, body.logs)
