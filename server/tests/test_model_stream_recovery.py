import asyncio
import json
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

import httpx
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage

from app.agents.loop import (
    _consume,
    _is_retryable_model_stream_error,
    _model_checkpoint_can_resume,
)


def _event(frame: str) -> dict:
    return json.loads(frame.removeprefix("data: ").strip())


def _streamed_write_chunk(
    call_id: str,
    *,
    reasoning: str = "",
) -> tuple[str, tuple[AIMessageChunk, dict]]:
    return (
        "messages",
        (
            AIMessageChunk(
                content="",
                additional_kwargs=(
                    {"reasoning_content": reasoning} if reasoning else {}
                ),
                tool_call_chunks=[
                    {
                        "name": "write_file",
                        "args": '{"path":"src/App.tsx","content":"',
                        "id": call_id,
                        "index": 0,
                        "type": "tool_call_chunk",
                    }
                ],
            ),
            {"langgraph_node": "model"},
        ),
    )


class _PartialDisconnectThenSuccessAgent:
    """第一次留下工具草稿后断流，恢复时才完整产出并执行工具。"""

    def __init__(self):
        self.inputs: list[object] = []
        self.state_reads = 0

    async def aget_state(self, _config):
        self.state_reads += 1
        return SimpleNamespace(
            next=("model",),
            interrupts=(),
            tasks=(SimpleNamespace(name="model", error="upstream disconnected"),),
        )

    async def astream(self, graph_input, *, stream_mode, config):
        assert stream_mode == ["updates", "messages"]
        assert config["configurable"]["thread_id"] == "thread-1"
        self.inputs.append(graph_input)

        if len(self.inputs) == 1:
            yield _streamed_write_chunk("draft-write", reasoning="正在规划")
            raise httpx.RemoteProtocolError(
                "peer closed connection without sending complete message body "
                "(incomplete chunked read)"
            )

        yield _streamed_write_chunk("real-write")
        yield (
            "updates",
            {
                "model": {
                    "messages": [
                        AIMessage(
                            content="现在开始写文件。",
                            tool_calls=[
                                {
                                    "name": "write_file",
                                    "args": {
                                        "path": "src/App.tsx",
                                        "content": "export default function App() { return null }",
                                    },
                                    "id": "real-write",
                                    "type": "tool_call",
                                }
                            ],
                        )
                    ]
                }
            },
        )
        yield (
            "updates",
            {
                "tools": {
                    "messages": [
                        ToolMessage(
                            content="已写入 src/App.tsx",
                            tool_call_id="real-write",
                        )
                    ]
                }
            },
        )
        yield ("updates", {"model": {"messages": [AIMessage(content="完成")]}})


class _AlwaysDisconnectAgent:
    def __init__(self):
        self.inputs: list[object] = []

    async def aget_state(self, _config):
        return SimpleNamespace(
            next=("model",),
            interrupts=(),
            tasks=(SimpleNamespace(name="model", error="upstream disconnected"),),
        )

    async def astream(self, graph_input, *, stream_mode, config):
        self.inputs.append(graph_input)
        yield _streamed_write_chunk(f"draft-{len(self.inputs)}")
        raise httpx.RemoteProtocolError("incomplete chunked read")


class ModelStreamRecoveryTests(IsolatedAsyncioTestCase):
    async def _consume_agent(self, agent):
        db = SimpleNamespace(commit=AsyncMock())

        async def save_message(*_args, **_kwargs):
            return SimpleNamespace(text="", images=None, tool_args=None)

        with (
            patch(
                "app.agents.loop._save_message",
                new=AsyncMock(side_effect=save_message),
            ) as save_message_mock,
            patch(
                "app.agents.loop._charge_user",
                new_callable=AsyncMock,
            ) as charge_user,
            patch(
                "app.agents.loop._cleanup_thread",
                new_callable=AsyncMock,
            ) as cleanup_thread,
            patch(
                "app.agents.loop.snapshot_current_files",
                new=AsyncMock(return_value=None),
            ),
            patch(
                "app.agents.loop.name_next_generated_version",
                new=AsyncMock(
                    return_value=SimpleNamespace(
                        version_name="恢复测试",
                        project_name=None,
                    )
                ),
            ),
            patch(
                "app.agents.loop.asyncio.sleep",
                new_callable=AsyncMock,
            ) as sleep,
        ):
            frames = [
                frame
                async for frame in _consume(
                    agent,
                    {"messages": []},
                    "thread-1",
                    session_id="session-1",
                    summary_text="生成页面",
                    model="test-model",
                    model_cost=1,
                    db=db,  # type: ignore[arg-type]
                    db_lock=asyncio.Lock(),
                    user_id="user-1",
                )
            ]
        return (
            [_event(frame) for frame in frames],
            save_message_mock,
            charge_user,
            cleanup_thread,
            sleep,
        )

    async def test_partial_model_stream_resumes_once_without_replaying_tools(self):
        agent = _PartialDisconnectThenSuccessAgent()
        (
            events,
            save_message,
            charge_user,
            cleanup_thread,
            sleep,
        ) = await self._consume_agent(agent)

        self.assertEqual(agent.inputs, [{"messages": []}, None])
        self.assertEqual(agent.state_reads, 1)
        self.assertEqual(
            [event for event in events if event["type"] == "generation_retry"],
            [
                {
                    "type": "generation_retry",
                    "attempt": 1,
                    "max_attempts": 1,
                    "discard_tool_ids": ["draft-write"],
                }
            ],
        )
        self.assertEqual(
            len([event for event in events if event["type"] == "reasoning_discard"]),
            1,
        )
        # 第一次的 draft-write 只是前端草稿；真正工具结果与文件写入都只有一次。
        self.assertEqual(
            [event["id"] for event in events if event["type"] == "tool_result"],
            ["real-write"],
        )
        self.assertEqual(
            [event["path"] for event in events if event["type"] == "file_write"],
            ["src/App.tsx"],
        )
        # 断流前已落库的兜底开场不应在恢复后的 model update 里重复保存。
        saved_assistant_texts = [
            call.args[4]
            for call in save_message.await_args_list
            if len(call.args) >= 5 and call.args[3] == "assistant" and call.args[4]
        ]
        self.assertEqual(
            saved_assistant_texts,
            ["好的，我已经理解需求，现在开始实现。", "完成"],
        )
        sleep.assert_awaited_once_with(1.0)
        charge_user.assert_awaited_once()
        cleanup_thread.assert_awaited_once_with("thread-1")
        self.assertEqual(events[-1], {"type": "done"})

    async def test_second_disconnect_stops_with_friendly_error_and_draft_reset(self):
        agent = _AlwaysDisconnectAgent()
        (
            events,
            _save_message,
            charge_user,
            cleanup_thread,
            sleep,
        ) = await self._consume_agent(agent)

        self.assertEqual(agent.inputs, [{"messages": []}, None])
        errors = [event for event in events if event["type"] == "error"]
        self.assertEqual(len(errors), 1)
        self.assertTrue(errors[0]["reset_draft"])
        self.assertEqual(errors[0]["discard_tool_ids"], ["draft-2"])
        self.assertIn("自动恢复后仍未成功", errors[0]["message"])
        self.assertNotIn("chunked", errors[0]["message"])
        self.assertEqual(
            len([event for event in events if event["type"] == "generation_retry"]),
            1,
        )
        sleep.assert_awaited_once_with(1.0)
        charge_user.assert_not_awaited()
        cleanup_thread.assert_awaited_once_with("thread-1")
        self.assertEqual(events[-1], {"type": "done"})

    def test_classifier_only_accepts_transport_failures(self):
        wrapped = RuntimeError("SDK wrapper")
        wrapped.__cause__ = httpx.RemoteProtocolError("server disconnected")
        self.assertTrue(_is_retryable_model_stream_error(wrapped))
        self.assertFalse(_is_retryable_model_stream_error(ValueError("bad payload")))

    async def test_checkpoint_guard_rejects_tool_task(self):
        agent = SimpleNamespace(
            aget_state=AsyncMock(
                return_value=SimpleNamespace(
                    next=("tools",),
                    interrupts=(),
                    tasks=(SimpleNamespace(name="tools", error="worker failed"),),
                )
            )
        )
        self.assertFalse(
            await _model_checkpoint_can_resume(
                agent,
                {"configurable": {"thread_id": "thread-1"}},
            )
        )
