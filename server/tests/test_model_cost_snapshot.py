import asyncio
from datetime import date
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from app.agents.loop import _consume


class _EmptyAgent:
    async def astream(self, *_args, **_kwargs):
        if False:
            yield None


class ModelCostSnapshotTests(IsolatedAsyncioTestCase):
    async def test_consume_charges_captured_cost_after_registry_id_disappears(self):
        user = SimpleNamespace(daily_date=date.today(), daily_used=2)
        db = SimpleNamespace(
            get=AsyncMock(return_value=user),
            commit=AsyncMock(),
        )

        with (
            patch(
                "app.agents.loop.models_by_id",
                side_effect=AssertionError("收尾不应重新查询模型注册表"),
            ),
            patch(
                "app.agents.loop._cleanup_thread",
                new_callable=AsyncMock,
            ),
        ):
            frames = [
                frame
                async for frame in _consume(
                    _EmptyAgent(),
                    {"messages": []},
                    "thread-1",
                    session_id="session-1",
                    summary_text="测试模型改名期间的计费",
                    model="old-model-id",
                    model_cost=4,
                    db=db,  # type: ignore[arg-type]
                    db_lock=asyncio.Lock(),
                    user_id="user-1",
                )
            ]

        self.assertEqual(user.daily_used, 6)
        db.commit.assert_awaited_once()
        self.assertEqual(frames, ['data: {"type": "done"}\n\n'])
