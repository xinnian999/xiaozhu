import asyncio
import json
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from langchain_core.messages import AIMessage, AIMessageChunk

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


def _event(frame: str) -> dict:
    return json.loads(frame.removeprefix("data: ").strip())


class ReasoningStreamTests(IsolatedAsyncioTestCase):
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
