from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.admin.models import copy_model, update_model
from app.db import Base
from app.models.llm_config import (
    LlmModel,
    LlmModelAdminCreate,
    LlmModelAdminUpdate,
)


class ModelUpdateSchemaTests(TestCase):
    def test_rejects_blank_new_model_id(self):
        with self.assertRaisesRegex(ValidationError, "模型 ID 不能为空"):
            LlmModelAdminUpdate.model_validate({"id": "   "})

    def test_normalizes_new_model_id(self):
        body = LlmModelAdminUpdate.model_validate({"id": "  renamed-model  "})

        self.assertEqual(body.id, "renamed-model")

    def test_rejects_explicit_null_model_id(self):
        with self.assertRaisesRegex(ValidationError, "以下字段不能为 null：id"):
            LlmModelAdminUpdate.model_validate({"id": None})


class ModelRenameTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    async def asyncTearDown(self):
        await self.engine.dispose()

    @staticmethod
    def _model(model_id: str, *, cost: int = 2) -> LlmModel:
        return LlmModel(
            id=model_id,
            provider="openai",
            base_url="https://code0.ai/v1",
            api_key="secret",
            logo="OpenAI",
            vision=True,
            thinking=True,
            thinking_toggle=True,
            vision_status="supported",
            thinking_status="supported",
            cost=cost,
            enabled=True,
            sort_order=3,
        )

    async def test_rename_updates_primary_key_and_resets_capabilities(self):
        async with self.sessions() as db:
            db.add(self._model("old-model"))
            await db.commit()

            with patch(
                "app.api.admin.models.llm.refresh",
                new_callable=AsyncMock,
            ) as refresh:
                result = await update_model(
                    "old-model",
                    LlmModelAdminUpdate.model_validate({"id": "new-model"}),
                    db,
                )

            self.assertEqual(result.id, "new-model")
            self.assertIsNone(await db.get(LlmModel, "old-model"))
            renamed = await db.get(LlmModel, "new-model")
            self.assertIsNotNone(renamed)
            assert renamed is not None
            # 未出现在 PATCH body 的普通配置仍保持不变。
            self.assertEqual(renamed.cost, 2)
            self.assertEqual(renamed.api_key, "secret")
            # 模型名会影响真正发给厂商的请求，旧能力探测结论不能沿用。
            self.assertFalse(renamed.vision)
            self.assertFalse(renamed.thinking)
            self.assertFalse(renamed.thinking_toggle)
            self.assertEqual(renamed.vision_status, "unknown")
            self.assertEqual(renamed.thinking_status, "unknown")
            refresh.assert_awaited_once()

    async def test_rename_rejects_existing_id_without_changing_rows(self):
        async with self.sessions() as db:
            db.add_all([
                self._model("old-model", cost=2),
                self._model("existing-model", cost=4),
            ])
            await db.commit()

            with (
                patch(
                    "app.api.admin.models.llm.refresh",
                    new_callable=AsyncMock,
                ) as refresh,
                self.assertRaises(HTTPException) as raised,
            ):
                await update_model(
                    "old-model",
                    LlmModelAdminUpdate.model_validate({"id": "existing-model"}),
                    db,
                )

            self.assertEqual(raised.exception.status_code, 409)
            self.assertEqual(raised.exception.detail, "该模型 ID 已存在")
            self.assertIsNotNone(await db.get(LlmModel, "old-model"))
            self.assertIsNotNone(await db.get(LlmModel, "existing-model"))
            refresh.assert_not_awaited()

    async def test_unchanged_id_does_not_reset_capabilities(self):
        async with self.sessions() as db:
            db.add(self._model("same-model"))
            await db.commit()

            with patch(
                "app.api.admin.models.llm.refresh",
                new_callable=AsyncMock,
            ):
                await update_model(
                    "same-model",
                    LlmModelAdminUpdate.model_validate(
                        {"id": "same-model", "cost": 5}
                    ),
                    db,
                )

            model = await db.get(LlmModel, "same-model")
            self.assertIsNotNone(model)
            assert model is not None
            self.assertEqual(model.cost, 5)
            self.assertTrue(model.vision)
            self.assertTrue(model.thinking)
            self.assertTrue(model.thinking_toggle)
            self.assertEqual(model.vision_status, "supported")
            self.assertEqual(model.thinking_status, "supported")


class ModelCopyTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    async def asyncTearDown(self):
        await self.engine.dispose()

    @staticmethod
    def _model(model_id: str, *, api_key: str = "source-secret-key") -> LlmModel:
        return LlmModel(
            id=model_id,
            provider="google",
            base_url="https://code0.ai",
            api_key=api_key,
            logo="Gemini.Color",
            vision=True,
            thinking=True,
            thinking_toggle=True,
            vision_status="supported",
            thinking_status="supported",
            cost=2,
            enabled=False,
            sort_order=3,
        )

    @staticmethod
    def _copy_body(
        target_id: str,
        *,
        api_key: str = "",
        provider: str = "google",
        base_url: str | None = " https://proxy.example/v1 ",
    ) -> LlmModelAdminCreate:
        return LlmModelAdminCreate.model_validate(
            {
                "id": target_id,
                "provider": provider,
                "base_url": base_url,
                "api_key": api_key,
                "cost": 4,
                "enabled": True,
                "sort_order": 9,
            }
        )

    async def test_copy_inherits_source_key_without_exposing_plaintext(self):
        async with self.sessions() as db:
            db.add(self._model("source-model"))
            await db.commit()

            with patch(
                "app.api.admin.models.llm.refresh",
                new_callable=AsyncMock,
            ) as refresh:
                result = await copy_model(
                    "source-model",
                    self._copy_body("copied-model"),
                    db,
                )

            copied = await db.get(LlmModel, "copied-model")
            self.assertIsNotNone(copied)
            assert copied is not None
            self.assertEqual(copied.api_key, "source-secret-key")
            self.assertEqual(result.api_key, "sou***key")
            self.assertNotEqual(result.api_key, copied.api_key)
            # 复制表单中的配置仍按创建接口做厂商与地址归一化。
            self.assertEqual(copied.provider, "google")
            self.assertEqual(copied.logo, "Gemini.Color")
            self.assertEqual(copied.base_url, "https://proxy.example/v1")
            self.assertEqual(copied.cost, 4)
            self.assertTrue(copied.enabled)
            self.assertEqual(copied.sort_order, 9)
            # 源模型的探测结论只对源 ID 有效，新模型必须重新探测。
            self.assertFalse(copied.vision)
            self.assertFalse(copied.thinking)
            self.assertFalse(copied.thinking_toggle)
            self.assertEqual(copied.vision_status, "unknown")
            self.assertEqual(copied.thinking_status, "unknown")
            refresh.assert_awaited_once()

    async def test_copy_uses_non_empty_key_as_explicit_override(self):
        async with self.sessions() as db:
            db.add(self._model("source-model"))
            await db.commit()

            with patch(
                "app.api.admin.models.llm.refresh",
                new_callable=AsyncMock,
            ):
                result = await copy_model(
                    "source-model",
                    self._copy_body("copied-model", api_key="replacement-secret"),
                    db,
                )

            copied = await db.get(LlmModel, "copied-model")
            self.assertIsNotNone(copied)
            assert copied is not None
            self.assertEqual(copied.api_key, "replacement-secret")
            self.assertEqual(result.api_key, "rep***ret")

    async def test_copy_rejects_missing_source(self):
        async with self.sessions() as db:
            with (
                patch(
                    "app.api.admin.models.llm.refresh",
                    new_callable=AsyncMock,
                ) as refresh,
                self.assertRaises(HTTPException) as raised,
            ):
                await copy_model(
                    "missing-model",
                    self._copy_body("copied-model"),
                    db,
                )

            self.assertEqual(raised.exception.status_code, 404)
            self.assertEqual(raised.exception.detail, "模型不存在")
            self.assertIsNone(await db.get(LlmModel, "copied-model"))
            refresh.assert_not_awaited()

    async def test_copy_rejects_existing_target_id(self):
        async with self.sessions() as db:
            db.add_all([
                self._model("source-model"),
                self._model("existing-model", api_key="existing-secret"),
            ])
            await db.commit()

            with (
                patch(
                    "app.api.admin.models.llm.refresh",
                    new_callable=AsyncMock,
                ) as refresh,
                self.assertRaises(HTTPException) as raised,
            ):
                await copy_model(
                    "source-model",
                    self._copy_body("existing-model"),
                    db,
                )

            self.assertEqual(raised.exception.status_code, 409)
            self.assertEqual(raised.exception.detail, "该模型 ID 已存在")
            existing = await db.get(LlmModel, "existing-model")
            self.assertIsNotNone(existing)
            assert existing is not None
            self.assertEqual(existing.api_key, "existing-secret")
            refresh.assert_not_awaited()
