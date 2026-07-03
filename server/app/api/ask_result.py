"""Ask result API —— 接收前端 ask_user 交互的用户回答。

AI 调 ask_user 工具时会阻塞等待真人操作（见 app.ask_store 对这套「前端事件 → 后端
await」会合机制的说明）。不管这次 ask_user 打包了几个问题、前端渲成了几个 Tab，
用户按顺序答完全部问题后，前端只会汇总成一份文本 POST 到这里一次，唤醒正挂在
ask_store 上等结果的 ask_user。
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app import ask_store
from app.deps import get_owned_session

# 沿用其它路由的层级风格：挂在具体 session 下面，并加归属守卫（只能往自己的会话报）。
router = APIRouter(
    prefix="/api/sessions/{session_id}/ask-result",
    tags=["ask-result"],
    dependencies=[Depends(get_owned_session)],
)


class AskResult(BaseModel):
    """前端报回的回答。

    tool_call_id 用来匹配「当前 arm 时记录的那个」——刷新页面后失效卡片的迟到 POST
    会因为 tool_call_id 对不上而被 ask_store 静默丢弃，不会误唤醒新一轮提问。
    answer 是前端已经把所有 Tab 的 Q&A 汇总格式化好的一份文本。
    """

    tool_call_id: str
    answer: str


@router.post("", status_code=204)
async def report_ask_result(session_id: str, body: AskResult) -> None:
    """接收前端提交的回答，唤醒正在等待的 ask_user。

    会话归属由路由级守卫 get_owned_session 把关。通过后，把回答交给 ask_store，
    它会校验 tool_call_id、对得上才立旗唤醒挂在 wait 上的 ask_user。返回 204：
    报到即可，没有 body 要回。
    """
    ask_store.report(session_id, body.tool_call_id, body.answer)
