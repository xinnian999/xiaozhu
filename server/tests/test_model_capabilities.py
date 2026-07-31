from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from pydantic import ValidationError
from langchain_core.messages import AIMessage

from app import llm
from app.api.admin.models import (
    _ANTHROPIC_THINKING_PROBE,
    _DEFAULT_THINKING_PROBE,
    _THINKING_PROBE_MAX_TOKENS,
    _THINKING_TEST_TIMEOUT_SEC,
    _record_detected_capability,
    _thinking_probe,
    _thinking_probe_output_limit,
    _capability_timeout_sec,
    test_model_capability,
)
from app.model_providers import ReasoningObservation, unsupported_vision_reason
from app.models.llm_config import LlmModelAdminUpdate


class PublicModelCapabilityTests(TestCase):
    def test_hard_blocked_provider_cannot_inherit_stale_vision_flag(self):
        self.assertFalse(llm.effective_vision_capability("deepseek", True))
        self.assertFalse(llm.effective_vision_capability("minimax", True))
        self.assertTrue(llm.effective_vision_capability("qwen", True))

    def test_public_models_exposes_persisted_capabilities(self):
        registry = {
            "qwen-test": {
                "id": "qwen-test",
                "logo": "Qwen.Color",
                "vision": True,
                "thinking": True,
                "thinking_toggle": True,
                "vision_status": "supported",
                "thinking_status": "supported",
                "cost": 1,
            }
        }
        with (
            patch.object(llm, "_MODELS_BY_ID", registry),
            patch.object(llm, "_ORDERED_IDS", ["qwen-test"]),
        ):
            self.assertEqual(
                llm.public_models(),
                [
                    {
                        "id": "qwen-test",
                        "label": "qwen-test",
                        "icon": "Qwen.Color",
                        "vision": True,
                        "thinking": True,
                        "thinking_toggle": True,
                        "vision_status": "supported",
                        "thinking_status": "supported",
                        "cost": 1,
                    }
                ],
            )

    def test_manual_capability_update_is_rejected(self):
        with self.assertRaises(ValidationError):
            LlmModelAdminUpdate.model_validate({"vision": True})

    def test_cannot_disable_model_without_detected_toggle(self):
        registry = {
            "always-thinking": {
                "thinking": True,
                "thinking_toggle": False,
            }
        }
        with patch.object(llm, "_MODELS_BY_ID", registry):
            llm.validate_thinking_option("always-thinking", True)
            with self.assertRaisesRegex(Exception, "无法关闭思考"):
                llm.validate_thinking_option("always-thinking", False)

    def test_text_only_providers_skip_invalid_vision_request(self):
        self.assertIsNotNone(unsupported_vision_reason("deepseek"))
        self.assertIsNotNone(unsupported_vision_reason("minimax"))


class CapabilityPersistenceTests(IsolatedAsyncioTestCase):
    async def test_thinking_probe_records_support_and_toggle(self):
        model = SimpleNamespace(
            thinking=False,
            thinking_toggle=False,
            thinking_status="unknown",
        )
        db = SimpleNamespace(commit=AsyncMock())
        with patch(
            "app.api.admin.models.llm.refresh",
            new_callable=AsyncMock,
        ) as refresh:
            await _record_detected_capability(
                db,  # type: ignore[arg-type]
                model,  # type: ignore[arg-type]
                "thinking",
                supported=True,
                status="supported",
                thinking_toggle=True,
            )

        self.assertTrue(model.thinking)
        self.assertTrue(model.thinking_toggle)
        self.assertEqual(model.thinking_status, "supported")
        db.commit.assert_awaited_once()
        refresh.assert_awaited_once()


class ThinkingProbeTests(IsolatedAsyncioTestCase):
    def test_capability_timeouts_match_expected_workload(self):
        self.assertEqual(_capability_timeout_sec("connectivity"), 60)
        self.assertEqual(_capability_timeout_sec("vision"), 30)
        self.assertEqual(_capability_timeout_sec("thinking"), 90)
        self.assertEqual(_capability_timeout_sec("tools"), 60)

    def test_google_uses_native_runtime_output_limit_name(self):
        self.assertEqual(
            _thinking_probe_output_limit("google"),
            {"max_output_tokens": _THINKING_PROBE_MAX_TOKENS},
        )
        self.assertEqual(
            _thinking_probe_output_limit("qwen"),
            {"max_tokens": _THINKING_PROBE_MAX_TOKENS},
        )

    async def test_qwen_uses_short_bounded_probe_with_longer_timeout(self):
        fake_model = object()
        response = AIMessage(
            content="13",
            additional_kwargs={"reasoning_content": "解方程得到结果。"},
        )
        with (
            patch(
                "app.api.admin.models.llm.build_llm",
                return_value=fake_model,
            ) as build_llm,
            patch(
                "app.api.admin.models._invoke_with_timeout",
                new_callable=AsyncMock,
                return_value=response,
            ) as invoke,
        ):
            observed = await _thinking_probe(
                "qwen-test",
                provider="qwen",
                enabled=True,
            )

        build_llm.assert_called_once_with("qwen-test", thinking=True)
        self.assertTrue(observed.has_signal)
        self.assertEqual(invoke.await_args.args[0], fake_model)
        self.assertEqual(
            invoke.await_args.args[1][0].content,
            _DEFAULT_THINKING_PROBE,
        )
        self.assertEqual(
            invoke.await_args.kwargs,
            {
                "timeout_sec": _THINKING_TEST_TIMEOUT_SEC,
                "max_tokens": _THINKING_PROBE_MAX_TOKENS,
            },
        )

    async def test_anthropic_keeps_harder_adaptive_thinking_probe(self):
        response = AIMessage(
            content="4005",
            content_blocks=[
                {"type": "thinking", "thinking": "计算末尾零。"},
                {"type": "text", "text": "4005"},
            ],
        )
        with (
            patch("app.api.admin.models.llm.build_llm"),
            patch(
                "app.api.admin.models._invoke_with_timeout",
                new_callable=AsyncMock,
                return_value=response,
            ) as invoke,
        ):
            await _thinking_probe(
                "claude-test",
                provider="anthropic",
                enabled=True,
            )

        self.assertEqual(
            invoke.await_args.args[1][0].content,
            _ANTHROPIC_THINKING_PROBE,
        )
        self.assertEqual(
            invoke.await_args.kwargs["output_config"],
            {"effort": "max"},
        )

    async def test_ignored_disable_switch_does_not_fail_thinking_capability(self):
        model = SimpleNamespace(
            id="thinking-test",
            provider="anthropic",
            api_key="test-key",
        )
        db = SimpleNamespace(get=AsyncMock(return_value=model))
        enabled = ReasoningObservation(
            tokens=25,
            content="visible reasoning",
            has_signal=True,
        )
        still_enabled = ReasoningObservation(
            tokens=20,
            content="still reasoning",
            has_signal=True,
        )
        with (
            patch("app.api.admin.models.llm.build_llm"),
            patch(
                "app.api.admin.models._thinking_probe",
                new_callable=AsyncMock,
                side_effect=[enabled, still_enabled],
            ),
            patch(
                "app.api.admin.models._record_detected_capability",
                new_callable=AsyncMock,
            ) as record,
        ):
            result = await test_model_capability(
                "thinking-test",
                "thinking",
                db,  # type: ignore[arg-type]
            )

        self.assertEqual(result.status, "passed")
        self.assertEqual(result.details[-1].status, "unsupported")
        self.assertIn("不可关闭", result.details[-1].message)
        record.assert_awaited_once_with(
            db,
            model,
            "thinking",
            supported=True,
            status="supported",
            thinking_toggle=False,
        )
