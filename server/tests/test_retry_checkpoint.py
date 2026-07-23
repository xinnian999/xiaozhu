from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from app.agents.loop import (
    ChatRequest,
    _delete_thread_checkpoint,
    _prepare_retry,
)


class _StopAfterCheckpointReset(RuntimeError):
    pass


class _FirstResult:
    def __init__(self, value):
        self.value = value

    def scalar_one_or_none(self):
        return self.value


class _StopAfterFirstQueryDb:
    """只让 _prepare_retry 读到 last_user，下一次 DB 访问即停止测试。"""

    def __init__(self, last_user):
        self.last_user = last_user
        self.calls = 0

    async def execute(self, _statement):
        self.calls += 1
        if self.calls == 1:
            return _FirstResult(self.last_user)
        raise _StopAfterCheckpointReset


class RetryCheckpointTests(IsolatedAsyncioTestCase):
    async def test_retry_resets_checkpoint_before_touching_files(self):
        req = ChatRequest(
            session_id="session-1",
            message="",
            model="test-model",
            retry=True,
        )
        db = _StopAfterFirstQueryDb(
            SimpleNamespace(id=17, text="做一个点餐程序"),
        )

        with patch(
            "app.agents.loop._delete_thread_checkpoint",
            new_callable=AsyncMock,
        ) as reset:
            with self.assertRaises(_StopAfterCheckpointReset):
                await _prepare_retry(req, db)  # type: ignore[arg-type]

        reset.assert_awaited_once_with("session-1:17")
        self.assertEqual(req.message, "做一个点餐程序")

    async def test_checkpoint_reset_uses_exact_round_thread_id(self):
        delete_thread = AsyncMock()
        checkpointer = SimpleNamespace(adelete_thread=delete_thread)

        with patch(
            "app.agents.loop.get_checkpointer",
            return_value=checkpointer,
        ):
            await _delete_thread_checkpoint("session-1:17")

        delete_thread.assert_awaited_once_with("session-1:17")
