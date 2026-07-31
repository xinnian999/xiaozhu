import asyncio
import json
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage

from app.agents.loop import _consume


class _StreamingReasoningAgent:
    async def astream(self, _graph_input, *, stream_mode, config):
        assert stream_mode == ["updates", "messages"]
        assert config["configurable"]["thread_id"] == "thread-1"
        yield (
            "messages",
            (
                AIMessageChunk(
                    content="",
                    additional_kwargs={"reasoning_content": "I"},
                ),
                {"langgraph_node": "model"},
            ),
        )
        yield (
            "messages",
            (
                AIMessageChunk(
                    content="",
                    additional_kwargs={"reasoning_content": " am thinking"},
                ),
                {"langgraph_node": "model"},
            ),
        )
        yield (
            "updates",
            {
                "model": {
                    "messages": [
                        AIMessage(
                            content="最终回答",
                            additional_kwargs={
                                "reasoning_content": "I am thinking",
                            },
                            response_metadata={
                                "token_usage": {
                                    "completion_tokens_details": {
                                        "reasoning_tokens": 3,
                                    },
                                },
                            },
                        )
                    ]
                }
            },
        )


class _TokenOnlyReasoningAgent:
    async def astream(self, _graph_input, *, stream_mode, config):
        assert stream_mode == ["updates", "messages"]
        assert config["configurable"]["thread_id"] == "thread-1"
        yield (
            "updates",
            {
                "model": {
                    "messages": [
                        AIMessage(
                            content="直接回答",
                            response_metadata={
                                "token_usage": {
                                    "completion_tokens_details": {
                                        "reasoning_tokens": 5,
                                    },
                                },
                            },
                        )
                    ]
                }
            },
        )


class _ToolIntroAgent:
    """模型先输出开场，再开始流式生成长工具参数。"""

    async def astream(self, _graph_input, *, stream_mode, config):
        assert stream_mode == ["updates", "messages"]
        assert config["configurable"]["thread_id"] == "thread-1"
        yield (
            "messages",
            (
                AIMessageChunk(content="我来做一个作品主页，"),
                {"langgraph_node": "model"},
            ),
        )
        yield (
            "messages",
            (
                AIMessageChunk(
                    content="马上开始。",
                    tool_call_chunks=[
                        {
                            "name": "write_file",
                            "args": '{"path":"src/App.tsx","content":"',
                            "id": "write-1",
                            "index": 0,
                            "type": "tool_call_chunk",
                        }
                    ],
                ),
                {"langgraph_node": "model"},
            ),
        )
        yield (
            "updates",
            {
                "model": {
                    "messages": [
                        AIMessage(
                            content="我来做一个作品主页，马上开始。",
                            tool_calls=[
                                {
                                    "name": "write_file",
                                    "args": {
                                        "path": "src/App.tsx",
                                        "content": "export default function App() { return null }",
                                    },
                                    "id": "write-1",
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
                            tool_call_id="write-1",
                        )
                    ]
                }
            },
        )
        yield (
            "updates",
            {"model": {"messages": [AIMessage(content="完成")]}},
        )


def _event(frame: str) -> dict:
    return json.loads(frame.removeprefix("data: ").strip())


class ReasoningStreamTests(IsolatedAsyncioTestCase):
    async def test_tool_intro_is_emitted_before_tool_card_without_duplication(self):
        db = SimpleNamespace(commit=AsyncMock())

        async def save_message(*_args, **_kwargs):
            return SimpleNamespace(text="", images=None)

        with (
            patch(
                "app.agents.loop._save_message",
                new=AsyncMock(side_effect=save_message),
            ) as save_message_mock,
            patch(
                "app.agents.loop._charge_user",
                new_callable=AsyncMock,
            ),
            patch(
                "app.agents.loop._cleanup_thread",
                new_callable=AsyncMock,
            ),
            patch(
                "app.agents.loop.snapshot_current_files",
                new=AsyncMock(return_value=None),
            ),
            patch(
                "app.agents.loop.name_next_generated_version",
                new=AsyncMock(
                    return_value=SimpleNamespace(
                        version_name="测试版本",
                        project_name=None,
                    )
                ),
            ),
        ):
            frames = [
                frame
                async for frame in _consume(
                    _ToolIntroAgent(),
                    {"messages": []},
                    "thread-1",
                    session_id="session-1",
                    summary_text="做一个作品主页",
                    model="test-model",
                    db=db,  # type: ignore[arg-type]
                    db_lock=asyncio.Lock(),
                    user_id="user-1",
                )
            ]

        events = [_event(frame) for frame in frames]
        event_types = [event["type"] for event in events]
        self.assertLess(
            event_types.index("message_delta"),
            event_types.index("tool_call"),
        )
        intro_events = [
            event
            for event in events
            if event["type"] == "message_delta"
            and "作品主页" in event["text"]
        ]
        self.assertEqual(
            intro_events,
            [{"type": "message_delta", "text": "我来做一个作品主页，马上开始。"}],
        )
        saved_texts = [
            call.args[4]
            for call in save_message_mock.await_args_list
            if len(call.args) >= 5 and call.args[3] == "assistant"
        ]
        self.assertEqual(saved_texts.count("我来做一个作品主页，马上开始。"), 1)

    async def test_reasoning_chunks_arrive_before_final_answer(self):
        with (
            patch(
                "app.agents.loop._save_reasoning_message",
                new_callable=AsyncMock,
            ) as save_reasoning,
            patch(
                "app.agents.loop._save_message",
                new_callable=AsyncMock,
            ) as save_message,
            patch(
                "app.agents.loop._charge_user",
                new_callable=AsyncMock,
            ),
            patch(
                "app.agents.loop._cleanup_thread",
                new_callable=AsyncMock,
            ),
        ):
            frames = [
                frame
                async for frame in _consume(
                    _StreamingReasoningAgent(),
                    {"messages": []},
                    "thread-1",
                    session_id="session-1",
                    summary_text="测试流式思考",
                    model="test-model",
                    db=object(),  # type: ignore[arg-type]
                    db_lock=asyncio.Lock(),
                    user_id="user-1",
                )
            ]

        events = [_event(frame) for frame in frames]
        self.assertEqual(
            [event["type"] for event in events],
            [
                "reasoning_delta",
                "reasoning_delta",
                "reasoning",
                "message_delta",
                "done",
            ],
        )
        self.assertEqual(
            "".join(event["text"] for event in events[:2]),
            "I am thinking",
        )
        self.assertEqual(events[0]["id"], events[1]["id"])
        self.assertEqual(events[1]["id"], events[2]["id"])
        self.assertEqual(events[2]["text"], "I am thinking")
        self.assertEqual(events[2]["tokens"], 3)
        self.assertEqual(events[3]["text"], "最终回答")
        save_reasoning.assert_awaited_once()
        save_message.assert_awaited_once()

    async def test_disabled_reasoning_is_not_emitted_or_persisted(self):
        with (
            patch(
                "app.agents.loop._save_reasoning_message",
                new_callable=AsyncMock,
            ) as save_reasoning,
            patch(
                "app.agents.loop._save_message",
                new_callable=AsyncMock,
            ) as save_message,
            patch(
                "app.agents.loop._charge_user",
                new_callable=AsyncMock,
            ),
            patch(
                "app.agents.loop._cleanup_thread",
                new_callable=AsyncMock,
            ),
        ):
            frames = [
                frame
                async for frame in _consume(
                    _StreamingReasoningAgent(),
                    {"messages": []},
                    "thread-1",
                    session_id="session-1",
                    summary_text="关闭思考",
                    model="test-model",
                    db=object(),  # type: ignore[arg-type]
                    db_lock=asyncio.Lock(),
                    user_id="user-1",
                    emit_reasoning=False,
                )
            ]

        events = [_event(frame) for frame in frames]
        self.assertEqual(
            [event["type"] for event in events],
            ["message_delta", "done"],
        )
        save_reasoning.assert_not_awaited()
        save_message.assert_awaited_once()

    async def test_reasoning_card_is_omitted_without_real_content(self):
        with (
            patch(
                "app.agents.loop._save_reasoning_message",
                new_callable=AsyncMock,
            ) as save_reasoning,
            patch(
                "app.agents.loop._save_message",
                new_callable=AsyncMock,
            ) as save_message,
            patch(
                "app.agents.loop._charge_user",
                new_callable=AsyncMock,
            ),
            patch(
                "app.agents.loop._cleanup_thread",
                new_callable=AsyncMock,
            ),
        ):
            frames = [
                frame
                async for frame in _consume(
                    _TokenOnlyReasoningAgent(),
                    {"messages": []},
                    "thread-1",
                    session_id="session-1",
                    summary_text="简单问题不展示空思考卡",
                    model="test-model",
                    db=object(),  # type: ignore[arg-type]
                    db_lock=asyncio.Lock(),
                    user_id="user-1",
                )
            ]

        events = [_event(frame) for frame in frames]
        self.assertEqual(
            [event["type"] for event in events],
            ["message_delta", "done"],
        )
        self.assertEqual(events[0]["text"], "直接回答")
        save_reasoning.assert_not_awaited()
        save_message.assert_awaited_once()
