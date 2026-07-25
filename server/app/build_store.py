"""构建结果的「会合点」(rendezvous)。

为什么需要它？
  check_build 工具跑在「SSE 那条请求」里（agent 的推理循环），它要等的「构建结果」
  却由【另一条请求】送来 —— 前端 build 完后单独 POST /api/sessions/{id}/build-result。
  这两条请求是两个独立的协程，普通的局部变量传不过去。需要一块「按 session +
  check_id 共享」的状态，让一边能「等」、另一边能「叫醒」。这正是
  asyncio.Event 的用途。

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
    # 截图上传必须绑定仍在等待的 check_build，且每轮最多接收一张，避免鉴权用户绕过
    # Agent 流程把此接口当成无限文件仓库。
    screenshot_reserved: bool = False
    screenshot_id: str | None = None
    # arm 后如果客户端恰在 preview_refresh 帧断开，check_build 可能尚未真正进入 wait；
    # 定时句柄保证这种异常路径也会自动回收。
    expiry: asyncio.TimerHandle | None = None


# (session_id, check_id) → 某一次 check_build 的会合点。
#
# 不能只按 session_id：上一轮构建/截图如果迟到，可能正好撞上下一轮已经 arm 的
# 会合点，把旧结果塞给新的 check_build。tool_call_id 天然逐次唯一，拿它当 check_id
# 后，迟到结果最多命中自己那一轮（若已超时清理则直接丢弃），不会串轮。
_waiters: dict[tuple[str, str], _Waiter] = {}
_WAITER_TTL_SECONDS = 100.0


async def _remove_orphan_screenshot(
    session_id: str,
    screenshot_id: str,
) -> None:
    """延迟导入避免模块环；过期/disarm 的未引用截图立即清盘。"""
    try:
        from app.preview_screenshots import get_screenshot, remove_screenshot

        record = await get_screenshot(session_id, screenshot_id)
        if record is not None:
            await remove_screenshot(record)
    except Exception as exc:
        print(
            "[build_store] 孤儿截图清理失败: "
            f"{type(exc).__name__}: {exc}"
        )


def _schedule_orphan_cleanup(
    session_id: str,
    screenshot_id: str | None,
) -> None:
    if screenshot_id is None:
        return
    try:
        asyncio.get_running_loop().create_task(
            _remove_orphan_screenshot(session_id, screenshot_id)
        )
    except RuntimeError:
        # 进程关闭、事件循环已结束时不再创建后台任务；会话删除仍会兜底清目录。
        pass


def _expire_waiter(
    key: tuple[str, str],
    waiter: _Waiter,
) -> None:
    """arm 后长期无人 wait/report 时的最终保险。"""
    if _waiters.get(key) is not waiter:
        return
    _waiters.pop(key, None)
    _schedule_orphan_cleanup(key[0], waiter.screenshot_id)


def arm(session_id: str, check_id: str) -> None:
    """在「触发前端构建」之前调用：建一个全新的会合点。

    用全新的 _Waiter 覆盖旧的，等于把上一轮残留的旗子/结果一并丢弃 —— 保证这一轮
    wait 到的一定是这一轮的新结果，不会读到上一次的旧值。
    """
    key = (session_id, check_id)
    previous = _waiters.pop(key, None)
    if previous is not None:
        if previous.expiry is not None:
            previous.expiry.cancel()
        _schedule_orphan_cleanup(session_id, previous.screenshot_id)

    waiter = _Waiter()
    try:
        waiter.expiry = asyncio.get_running_loop().call_later(
            _WAITER_TTL_SECONDS,
            _expire_waiter,
            key,
            waiter,
        )
    except RuntimeError:
        # 正常调用点都在 FastAPI 事件循环；同步单测/脚本场景没有 loop 时仍可手动 wait。
        pass
    _waiters[key] = waiter


def disarm(session_id: str, check_id: str) -> None:
    """SSE/agent 消费提前结束时撤销尚未被 wait 清理的会合点。"""
    waiter = _waiters.pop((session_id, check_id), None)
    if waiter is None:
        return
    if waiter.expiry is not None:
        waiter.expiry.cancel()
    _schedule_orphan_cleanup(session_id, waiter.screenshot_id)


def disarm_session(session_id: str) -> None:
    """删除会话前撤销其全部构建会合点，拒绝迟到的截图与 build-result。"""
    check_ids = [
        check_id
        for waiter_session_id, check_id in _waiters
        if waiter_session_id == session_id
    ]
    for check_id in check_ids:
        disarm(session_id, check_id)


def report(session_id: str, check_id: str, result: dict) -> bool:
    """前端 build 完后（经 HTTP 端点）调用：把结果放进信箱 + 立旗唤醒在等的 check_build。"""
    w = _waiters.get((session_id, check_id))
    if w is None:
        # 没 arm 过就收到结果（理论上不会发生）：直接丢弃。不凭空建一个没人 reset 的
        # 残留会合点，否则它的旧结果可能在下一轮被错读。
        return False
    w.result = result
    w.event.set()
    return True


def reserve_screenshot_upload(session_id: str, check_id: str) -> bool:
    """为仍在等待的检查原子预留唯一截图名额。"""
    w = _waiters.get((session_id, check_id))
    if w is None or w.screenshot_reserved:
        return False
    w.screenshot_reserved = True
    return True


def release_screenshot_upload(session_id: str, check_id: str) -> None:
    """上传校验/写盘失败时归还名额，允许前端在本轮内重试。"""
    w = _waiters.get((session_id, check_id))
    if w is None or w.screenshot_id is not None:
        return
    w.screenshot_reserved = False


def commit_screenshot_upload(
    session_id: str,
    check_id: str,
    screenshot_id: str,
) -> bool:
    """把已落盘截图绑定到本轮；waiter 已超时消失时拒绝迟到结果。"""
    w = _waiters.get((session_id, check_id))
    if w is None or not w.screenshot_reserved or w.screenshot_id is not None:
        return False
    w.screenshot_id = screenshot_id
    return True


def owns_screenshot(
    session_id: str,
    check_id: str,
    screenshot_id: str,
) -> bool:
    """build-result 只可引用本轮上传成功的那一张图。"""
    w = _waiters.get((session_id, check_id))
    return w is not None and w.screenshot_id == screenshot_id


def screenshot_for_check(session_id: str, check_id: str) -> str | None:
    """返回本轮已提交的截图；用于上传响应丢失时由 build-result 自动补关联。"""
    w = _waiters.get((session_id, check_id))
    return w.screenshot_id if w is not None else None


async def wait(session_id: str, check_id: str, timeout: float) -> dict | None:
    """check_build 调用：挂起直到前端报回结果，或超时。

    返回结果 dict；若超时（前端迟迟没回，可能构建卡死或断线）返回 None。
    注意：前端多快报回，这里就多快返回 —— timeout 只是「前端彻底失联」的兜底，
    设得宽松点不会拖慢正常情况（因为一旦 report 立旗，wait 立即醒）。
    """
    key = (session_id, check_id)
    w = _waiters.get(key)
    if w is None:
        return None
    try:
        # wait_for 给 event.wait() 套一个超时：超时会抛 TimeoutError。
        await asyncio.wait_for(w.event.wait(), timeout)
        return w.result
    except asyncio.TimeoutError:
        return None
    finally:
        # 无论正常、超时还是调用方被取消，都释放这一轮可能携带截图信息的结果。
        # identity 判断防止极端情况下同一个 key 被重新 arm 后，旧协程误删新 waiter。
        if _waiters.get(key) is w:
            _waiters.pop(key, None)
            if w.expiry is not None:
                w.expiry.cancel()
            if w.result is None:
                _schedule_orphan_cleanup(session_id, w.screenshot_id)
