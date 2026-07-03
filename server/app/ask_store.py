"""AI 主动提问（ask_user）的「会合点」(rendezvous)。

和 build_store.py 是同一套范式——check_build 要等前端 build 完的结果，ask_user
要等真人点完选项 / 提交完自定义回答的结果，两者都是「这条 SSE 请求要等【另一条独立
请求】送结果回来」，用 asyncio.Event 让一边等、一边叫醒。

和 build_store 的关键区别：
  - 不设超时。check_build 等的是几秒内的自动化构建，90s 超时兜底足够；ask_user 等的
    是真人操作，可能几分钟甚至更久，用户明确要求「不操作就一直等，不自动兜底代答」，
    所以 wait() 没有 timeout 参数、也不会返回 None。
  - 多一层 tool_call_id 校验。因为等待窗口更长，更容易撞上「刷新页面后旧卡片的迟到
    POST」这种孤儿请求——report() 时校验 tool_call_id 对不对得上「当前这一轮 arm 时
    记录的那个」，对不上就静默丢弃，不会误唤醒新一轮提问。

一次 ask_user 调用可能打包多个问题（Tab 化呈现），但这一层完全不感知「多问题」这件
事——前端把所有 Tab 答完后，才把 Q&A 汇总格式化成一份文本一次性 POST 过来，这里收到
的 answer 永远是一个已经处理好的字符串，只管透传。

存内存、按进程共享（和 build_store 一样）：单机单进程的学习项目够用；将来多 worker
部署要换 Redis 之类的跨进程存储——先不管。
"""

import asyncio
from dataclasses import dataclass


@dataclass
class _Waiter:
    """一次 ask_user 调用的会合点：一面旗子 + 期望的调用 id + 一格放答案的信箱。"""

    event: asyncio.Event
    # arm 时记录「这一轮期望被唤醒的 tool_call_id」，report 时校验对不对得上，
    # 防止刷新后失效卡片的迟到 POST 误唤醒新一轮提问。
    tool_call_id: str
    # 用户提交的回答（已经在前端汇总格式化好的字符串）；还没提交时是 None。
    result: str | None = None


# session_id → 该 session 当前这一次 ask_user 调用的会合点。
_waiters: dict[str, _Waiter] = {}


def arm(session_id: str, tool_call_id: str) -> None:
    """在工具真正开始等待之前调用：建一个全新的会合点，记下期望的 tool_call_id。

    用全新的 _Waiter 覆盖旧的，等于把上一次提问残留的旗子/结果一并丢弃——保证这一次
    wait 到的一定是这一次的新答案，不会读到上一次的旧值。
    """
    _waiters[session_id] = _Waiter(event=asyncio.Event(), tool_call_id=tool_call_id)


def report(session_id: str, tool_call_id: str, answer: str) -> None:
    """前端提交回答后（经 HTTP 端点）调用：把答案放进信箱 + 立旗唤醒在等的 ask_user。

    tool_call_id 对不上「当前 arm 时记录的那个」（说明是刷新后失效卡片的迟到 POST，
    或者是上一轮已经结束的提问）—— 静默丢弃，不误唤醒任何东西。
    """
    w = _waiters.get(session_id)
    if w is None or w.tool_call_id != tool_call_id:
        return
    w.result = answer
    w.event.set()


async def wait(session_id: str) -> str:
    """ask_user 工具调用：无限期挂起直到用户提交回答。

    没有 timeout 参数、不会返回 None——只要用户不操作就一直等。唯一的退出路径是
    协程被取消（浏览器断开连接时，ASGI 层会 aclose 这个异步生成器），此时异常自然
    沿调用栈往上冒，由 agent_loop 已有的异常处理收尾，这里不用专门捕获。
    """
    w = _waiters[session_id]
    await w.event.wait()
    assert w.result is not None  # event.set() 前一定先写了 result，见 report()
    return w.result
