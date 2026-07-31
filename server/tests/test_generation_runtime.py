import asyncio
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

from app.generation_control import GenerationLease
from app.generation_runtime import (
    active_generation_ids,
    is_generation_active,
    start_generation,
    subscribe_generation,
)


class _FakeSessionContext:
    async def __aenter__(self):
        return object()

    async def __aexit__(self, exc_type, exc, traceback):
        return False


class GenerationRuntimeTests(IsolatedAsyncioTestCase):
    async def test_disconnecting_subscriber_does_not_cancel_task(self):
        session_id = "background-generation-test"
        gate = asyncio.Event()

        async def frames(_db):
            yield "first"
            await gate.wait()
            yield "second"

        with patch(
            "app.generation_runtime.AsyncSessionLocal",
            return_value=_FakeSessionContext(),
        ):
            first_subscription = start_generation(
                session_id,
                GenerationLease(session_id=session_id),
                frames,
            )
            assert first_subscription is not None
            self.assertEqual(await anext(first_subscription), "first")
            await first_subscription.aclose()

            self.assertTrue(is_generation_active(session_id))
            self.assertEqual(
                active_generation_ids({session_id, "other-session"}),
                {session_id},
            )
            second_subscription = subscribe_generation(session_id)
            assert second_subscription is not None
            gate.set()
            self.assertEqual(await anext(second_subscription), "second")
            with self.assertRaises(StopAsyncIteration):
                await anext(second_subscription)

        for _ in range(20):
            if not is_generation_active(session_id):
                break
            await asyncio.sleep(0)
        self.assertFalse(is_generation_active(session_id))
        self.assertEqual(active_generation_ids({session_id}), set())
