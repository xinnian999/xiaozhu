"""服务端生成任务运行时。

Agent 的生命周期必须属于服务端任务，而不是某一条浏览器 SSE 响应。浏览器切后台、
刷新、切项目或直接关闭标签页时只会断开一个订阅者；后台任务继续使用自己的数据库
会话执行。用户回来后可重新订阅仍在运行的任务，完成结果始终以数据库为准。
"""

import asyncio
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass, field
from threading import Lock

from sqlalchemy.ext.asyncio import AsyncSession

from app.db import AsyncSessionLocal
from app.generation_control import (
    GenerationLease,
    managed_generation,
    release_generation,
)


_END = object()


@dataclass
class ActiveGeneration:
    session_id: str
    lease: GenerationLease
    task: asyncio.Task[None] | None = None
    subscribers: set[asyncio.Queue[object]] = field(default_factory=set)

    def publish(self, frame: str) -> None:
        for queue in tuple(self.subscribers):
            queue.put_nowait(frame)

    def finish(self) -> None:
        for queue in tuple(self.subscribers):
            queue.put_nowait(_END)


_active: dict[str, ActiveGeneration] = {}
_lock = Lock()


def is_generation_active(session_id: str) -> bool:
    with _lock:
        return session_id in _active


def active_generation_ids(session_ids: set[str]) -> set[str]:
    """批量返回给定会话中仍在运行的任务，供项目菜单展示后台状态。"""
    with _lock:
        return session_ids.intersection(_active)


def start_generation(
    session_id: str,
    lease: GenerationLease,
    factory: Callable[[AsyncSession], AsyncGenerator[str, None]],
) -> AsyncGenerator[str, None] | None:
    """启动后台任务并返回首个订阅；同一会话已有任务时返回 None。"""
    generation = ActiveGeneration(session_id=session_id, lease=lease)
    queue: asyncio.Queue[object] = asyncio.Queue()
    generation.subscribers.add(queue)
    with _lock:
        if session_id in _active:
            release_generation(lease)
            return None
        _active[session_id] = generation

    async def run() -> None:
        try:
            async with AsyncSessionLocal() as db:
                async for frame in managed_generation(lease, factory(db)):
                    generation.publish(frame)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # 请求已经与任务解耦，未捕获异常必须通过事件告知仍在线的订阅者。
            from app.agents.loop import sse

            generation.publish(
                sse(
                    {
                        "type": "error",
                        "message": f"生成任务异常：{type(exc).__name__}: {exc}",
                    }
                )
            )
            generation.publish(sse({"type": "done"}))
        finally:
            with _lock:
                if _active.get(session_id) is generation:
                    _active.pop(session_id, None)
            generation.finish()

    generation.task = asyncio.create_task(run(), name=f"generation:{session_id}")
    return _subscription(generation, queue)


def subscribe_generation(session_id: str) -> AsyncGenerator[str, None] | None:
    """订阅仍在运行的任务；断开订阅不会取消后台任务。"""
    queue: asyncio.Queue[object] = asyncio.Queue()
    with _lock:
        generation = _active.get(session_id)
        if generation is None:
            return None
        generation.subscribers.add(queue)
    return _subscription(generation, queue)


async def _subscription(
    generation: ActiveGeneration,
    queue: asyncio.Queue[object],
) -> AsyncGenerator[str, None]:
    try:
        while True:
            item = await queue.get()
            if item is _END:
                return
            yield str(item)
    finally:
        generation.subscribers.discard(queue)
