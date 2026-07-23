from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from pydantic import ValidationError

from app import llm
from app.api.admin.models import _record_detected_capability
from app.models.llm_config import LlmModelAdminUpdate


class PublicModelCapabilityTests(TestCase):
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
