"""构建结果的「会合点」(rendezvous)。

为什么需要它？
  check_build 工具跑在「SSE 那条请求」里（agent 的推理循环），它要等的「构建结果」
  却由【另一条请求】送来 —— 前端 build 完后单独 POST /api/sessions/{id}/build-result。
  这两条请求是两个独立的协程，普通的局部变量传不过去。需要一块「按 session 共享」的
  状态，让一边能「等」、另一边能「叫醒」。这正是 asyncio.Event 的用途。

asyncio.Event 是什么？
  一面「带记忆的旗子」：
    - await event.wait() —— 旗子没立就在这儿挂着（让出事件循环、不占 CPU，也不挡别的
      请求）；旗子已经立着就立刻返回。
    - event.set()       —— 把旗子立起来，所有在 wait 的协程被唤醒。
  关键：旗子「立起来」是有记忆的 —— 哪怕 set 发生在 wait 之前，之后再 wait 也会立刻
  返回。所以只要用的是【同一个 Event 对象】，就不怕「结果先到、等待后到」。

时序陷阱（为什么要 arm）：
  前端的节奏是「收到构建信号 → build → POST 结果」。如果我们等 check_build 真正执行时
  才创建 Event，那在「发构建信号」到「创建 Event」这段空隙里，万一前端已经 POST 回来，
  就找不到 Event、结果丢了。所以反过来：在【发构建信号之前】就先把 Event 建好（arm），
  保证前端的 POST 一定能找到它。这是异步协调的通用套路 —— 先架好接收器，再触发动作。

存内存、按进程共享（和 log_store 一样）：单机单进程的学习项目够用；将来多 worker
部署要换 Redis 之类的跨进程存储 —— 先不管。
"""

import asyncio
from dataclasses import dataclass, field


@dataclass
class _Waiter:
    """一个 session 的会合点：一面旗子 + 一格放结果的信箱。"""

    # default_factory：每个 _Waiter 实例都新建一个自己的 Event，不能所有实例共享一个。
    event: asyncio.Event = field(default_factory=asyncio.Event)
    # 前端报回的构建结果，形如 {"ok": bool, "errors": str}；还没报回时是 None。
    result: dict | None = None


# session_id → 该 session 当前这一轮的会合点。
_waiters: dict[str, _Waiter] = {}


def arm(session_id: str) -> None:
    """在「触发前端构建」之前调用：建一个全新的会合点。

    用全新的 _Waiter 覆盖旧的，等于把上一轮残留的旗子/结果一并丢弃 —— 保证这一轮
    wait 到的一定是这一轮的新结果，不会读到上一次的旧值。
    """
    _waiters[session_id] = _Waiter()


def report(session_id: str, result: dict) -> None:
    """前端 build 完后（经 HTTP 端点）调用：把结果放进信箱 + 立旗唤醒在等的 check_build。"""
    w = _waiters.get(session_id)
    if w is None:
        # 没 arm 过就收到结果（理论上不会发生）：直接丢弃。不凭空建一个没人 reset 的
        # 残留会合点，否则它的旧结果可能在下一轮被错读。
        return
    w.result = result
    w.event.set()


async def wait(session_id: str, timeout: float) -> dict | None:
    """check_build 调用：挂起直到前端报回结果，或超时。

    返回结果 dict；若超时（前端迟迟没回，可能构建卡死或断线）返回 None。
    注意：前端多快报回，这里就多快返回 —— timeout 只是「前端彻底失联」的兜底，
    设得宽松点不会拖慢正常情况（因为一旦 report 立旗，wait 立即醒）。
    """
    w = _waiters.get(session_id)
    if w is None:
        return None
    try:
        # wait_for 给 event.wait() 套一个超时：超时会抛 TimeoutError。
        await asyncio.wait_for(w.event.wait(), timeout)
        return w.result
    except asyncio.TimeoutError:
        return None
