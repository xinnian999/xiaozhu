from types import SimpleNamespace
from unittest import TestCase

from langchain_core.messages import AIMessage, HumanMessage

from app.model_providers import (
    SerialChatAnthropic,
    build_chat_model,
    reasoning_observation,
    supports_thinking_toggle,
)


def _meta(model: str) -> dict:
    return {
        "id": model,
        "provider": "anthropic",
        "api_key": "test-key",
        "base_url": "https://example.com",
    }


class AnthropicThinkingConfigTests(TestCase):
    def test_sonnet_5_uses_adaptive_thinking_with_visible_summary(self):
        model = build_chat_model(_meta("claude-sonnet-5"), thinking=True)

        payload = model._get_request_payload([HumanMessage(content="test")])

        self.assertEqual(
            payload["thinking"],
            {"type": "adaptive", "display": "summarized"},
        )
        self.assertEqual(payload["output_config"], {"effort": "high"})
        self.assertNotIn("budget_tokens", payload["thinking"])

    def test_opus_5_is_disabled_at_high_effort(self):
        model = build_chat_model(_meta("claude-opus-5"), thinking=False)

        payload = model._get_request_payload([HumanMessage(content="test")])

        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertEqual(payload["output_config"], {"effort": "high"})

    def test_legacy_claude_keeps_manual_thinking_budget(self):
        model = build_chat_model(
            _meta("claude-sonnet-4-5-20250929"),
            thinking=True,
        )

        payload = model._get_request_payload([HumanMessage(content="test")])

        self.assertEqual(
            payload["thinking"],
            {"type": "enabled", "budget_tokens": 2048},
        )
        self.assertNotIn("output_config", payload)

    def test_always_thinking_anthropic_model_has_no_disable_toggle(self):
        self.assertFalse(supports_thinking_toggle("anthropic", "claude-fable-5"))
        self.assertTrue(supports_thinking_toggle("anthropic", "claude-sonnet-5"))

        model = build_chat_model(_meta("claude-fable-5"), thinking=False)
        payload = model._get_request_payload([HumanMessage(content="test")])
        self.assertNotIn("thinking", payload)


class AnthropicThinkingObservationTests(TestCase):
    def test_empty_thinking_block_is_still_a_reasoning_signal(self):
        response = AIMessage(
            content=[
                {
                    "type": "thinking",
                    "thinking": "",
                    "signature": "opaque",
                },
                {"type": "text", "text": "answer"},
            ]
        )

        observation = reasoning_observation(response)

        self.assertTrue(observation.has_signal)
        self.assertEqual(observation.content, "")

    def test_thinking_token_usage_is_recognized(self):
        response = AIMessage(
            content="answer",
            response_metadata={
                "usage": {
                    "output_tokens_details": {
                        "thinking_tokens": 321,
                    }
                }
            },
        )

        observation = reasoning_observation(response)

        self.assertTrue(observation.has_signal)
        self.assertEqual(observation.tokens, 321)


class AnthropicStreamCompatibilityTests(TestCase):
    def test_dict_context_management_is_preserved_in_message_delta(self):
        model = SerialChatAnthropic(
            model_name="claude-opus-5",
            api_key="test-key",
            base_url="https://example.com",
        )
        event = SimpleNamespace(
            type="message_delta",
            usage=SimpleNamespace(input_tokens=10, output_tokens=3),
            delta=SimpleNamespace(
                stop_reason="tool_use",
                stop_sequence=None,
            ),
            context_management={"applied_edits": []},
        )

        chunk, _ = model._make_message_chunk_from_anthropic_event(
            event,
            stream_usage=True,
            coerce_content_to_string=False,
        )

        self.assertIsNotNone(chunk)
        self.assertEqual(
            chunk.response_metadata["context_management"],
            {"applied_edits": []},
        )

    def test_dict_container_is_preserved_in_message_delta(self):
        model = SerialChatAnthropic(
            model_name="claude-opus-5",
            api_key="test-key",
            base_url="https://example.com",
        )
        event = SimpleNamespace(
            type="message_delta",
            usage=SimpleNamespace(input_tokens=10, output_tokens=3),
            delta=SimpleNamespace(
                stop_reason="end_turn",
                stop_sequence=None,
                container={"id": "container-1"},
            ),
        )

        chunk, _ = model._make_message_chunk_from_anthropic_event(
            event,
            stream_usage=True,
            coerce_content_to_string=False,
        )

        self.assertIsNotNone(chunk)
        self.assertEqual(
            chunk.response_metadata["container"],
            {"id": "container-1"},
        )
