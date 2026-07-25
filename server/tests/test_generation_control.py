import asyncio
import unittest
from uuid import uuid4

from app.agents.loop import with_heartbeat
from app.generation_control import (
    allow_session_generations,
    cancel_session_generations,
    managed_generation,
    reserve_generation,
)


class HeartbeatCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_close_waits_for_inner_generator_finally(self):
        finalized = asyncio.Event()

        async def source():
            try:
                yield "data: first\n\n"
            finally:
                finalized.set()

        wrapped = with_heartbeat(source(), interval=0.01)
        self.assertEqual(await anext(wrapped), "data: first\n\n")

        await wrapped.aclose()

        self.assertTrue(finalized.is_set())

    async def test_task_cancellation_waits_for_pending_inner_next(self):
        started = asyncio.Event()
        finalized = asyncio.Event()

        async def source():
            try:
                started.set()
                await asyncio.Future()
                yield "never"
            finally:
                finalized.set()

        async def consume():
            async for _ in with_heartbeat(source(), interval=60):
                pass

        task = asyncio.create_task(consume())
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

        self.assertTrue(finalized.is_set())


class GenerationControlTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_waits_for_active_generation_cleanup(self):
        session_id = f"session-{uuid4()}"
        lease = reserve_generation(session_id)
        self.assertIsNotNone(lease)
        started = asyncio.Event()
        finalized = asyncio.Event()

        async def source():
            try:
                started.set()
                await asyncio.Future()
                yield "never"
            finally:
                finalized.set()

        async def consume():
            async for _ in managed_generation(lease, source()):
                pass

        task = asyncio.create_task(consume())
        await started.wait()

        await cancel_session_generations(session_id)

        self.assertTrue(task.done())
        self.assertTrue(finalized.is_set())

    async def test_delete_tombstone_rejects_new_generation(self):
        session_id = f"session-{uuid4()}"

        await cancel_session_generations(session_id, prevent_new=True)
        self.assertIsNone(reserve_generation(session_id))

        allow_session_generations(session_id)
        lease = reserve_generation(session_id)
        self.assertIsNotNone(lease)
        await cancel_session_generations(session_id)

    async def test_cancelled_unstarted_lease_closes_without_running_source(self):
        session_id = f"session-{uuid4()}"
        lease = reserve_generation(session_id)
        self.assertIsNotNone(lease)
        ran = False

        async def source():
            nonlocal ran
            ran = True
            yield "never"

        await cancel_session_generations(session_id)
        output = [item async for item in managed_generation(lease, source())]

        self.assertEqual(output, [])
        self.assertFalse(ran)
