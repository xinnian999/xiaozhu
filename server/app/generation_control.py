"""会话级生成任务协调。

浏览器断开 SSE 时 ASGI 通常会取消响应任务，但“客户端已经 abort”并不等于服务端清理
已经完成。删除会话若在这条缝里执行，旧 agent 仍可能重新写出孤儿文件/消息。

每条流在返回 StreamingResponse 前先预留 lease；真正开始迭代时再绑定当前 asyncio.Task。
删除接口先把会话标为 deleting，取消并等待所有 lease 收尾，随后才删数据库。
"""

import asyncio
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from threading import Lock


@dataclass(eq=False)
class GenerationLease:
    """一条 SSE 生成流从路由创建到彻底收尾的生命周期。"""

    session_id: str
    task: asyncio.Task | None = None
    cancelled: bool = False
    done: asyncio.Event = field(default_factory=asyncio.Event)


_leases: dict[str, set[GenerationLease]] = {}
_deleting_sessions: set[str] = set()
_lock = Lock()


def reserve_generation(session_id: str) -> GenerationLease | None:
    """在 StreamingResponse 建立前预留任务；删除中的会话拒绝新生成。"""
    lease = GenerationLease(session_id=session_id)
    with _lock:
        if session_id in _deleting_sessions:
            return None
        _leases.setdefault(session_id, set()).add(lease)
    return lease


def _finish_lease(lease: GenerationLease) -> None:
    with _lock:
        entries = _leases.get(lease.session_id)
        entries and entries.discard(lease)
        if entries is not None and not entries:
            _leases.pop(lease.session_id, None)
    lease.done.set()


async def managed_generation(
    lease: GenerationLease,
    gen: AsyncGenerator[str, None],
) -> AsyncGenerator[str, None]:
    """绑定实际响应任务，并保证内层生成器关闭完成后才释放 lease。"""
    task = asyncio.current_task()
    should_run = True
    with _lock:
        if lease.cancelled:
            should_run = False
        else:
            lease.task = task

    try:
        if not should_run:
            return
        async for item in gen:
            yield item
    finally:
        # async for 因任务取消退出时不会替我们保证嵌套生成器已完成 aclose。
        # 显式关闭后再 set done，删除接口等待的才是真正的清理屏障。
        try:
            await gen.aclose()
        finally:
            _finish_lease(lease)


async def cancel_session_generations(
    session_id: str,
    *,
    prevent_new: bool = False,
) -> None:
    """取消并等待某会话的全部生成流；删除时同时阻止新的 lease。"""
    waiters: list[asyncio.Event] = []
    tasks: list[asyncio.Task] = []
    current = asyncio.current_task()

    with _lock:
        if prevent_new:
            _deleting_sessions.add(session_id)
        for lease in list(_leases.get(session_id, ())):
            lease.cancelled = True
            if lease.task is None:
                # 响应尚未开始迭代：直接释放；它以后启动时会看到 cancelled 并立即关闭。
                _finish_lease_locked(lease)
            else:
                waiters.append(lease.done)
                if lease.task is not current:
                    tasks.append(lease.task)

    for task in tasks:
        task.cancel()
    if waiters:
        await asyncio.gather(*(event.wait() for event in waiters))


def _finish_lease_locked(lease: GenerationLease) -> None:
    """仅供持有 _lock 的取消路径使用，避免重复获取非可重入锁。"""
    entries = _leases.get(lease.session_id)
    entries and entries.discard(lease)
    if entries is not None and not entries:
        _leases.pop(lease.session_id, None)
    lease.done.set()


def allow_session_generations(session_id: str) -> None:
    """删除事务失败时撤销 deleting 标记，让仍存在的会话可以继续使用。"""
    with _lock:
        _deleting_sessions.discard(session_id)


def is_session_deleting(session_id: str) -> bool:
    """截图等旁路写入在落盘前后用它拒绝删除中的会话。"""
    with _lock:
        return session_id in _deleting_sessions
