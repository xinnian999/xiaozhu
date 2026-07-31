import asyncio
import base64
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase, main
from unittest.mock import AsyncMock, patch

from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app import build_store
from app.agents.middleware import ScreenshotVisionMiddleware
from app.preview_screenshots import (
    build_screenshot_artifact,
    get_screenshot,
    load_screenshot_data_url,
    remove_session_screenshots,
    save_screenshot,
)


# 一张真实的 1×1 PNG；存储层只负责格式/大小与归属，不负责重新解码图片。
_ONE_PIXEL_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "YAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)


class BuildStoreScreenshotTests(IsolatedAsyncioTestCase):
    async def test_check_id_isolation_and_single_screenshot_binding(self):
        build_store.arm("session-a", "check-1")
        build_store.arm("session-a", "check-2")

        self.assertTrue(
            build_store.reserve_screenshot_upload("session-a", "check-1")
        )
        self.assertFalse(
            build_store.reserve_screenshot_upload("session-a", "check-1")
        )
        self.assertTrue(
            build_store.commit_screenshot_upload(
                "session-a",
                "check-1",
                "shot-1",
            )
        )
        self.assertTrue(
            build_store.owns_screenshot(
                "session-a",
                "check-1",
                "shot-1",
            )
        )
        self.assertEqual(
            build_store.screenshot_for_check("session-a", "check-1"),
            "shot-1",
        )
        self.assertFalse(
            build_store.owns_screenshot(
                "session-a",
                "check-2",
                "shot-1",
            )
        )

        build_store.report(
            "session-a",
            "check-1",
            {"ok": True, "screenshot_id": "shot-1"},
        )
        result = await build_store.wait("session-a", "check-1", timeout=0.1)
        self.assertEqual(result, {"ok": True, "screenshot_id": "shot-1"})

        # wait finally 已清理本轮，迟到上传不能再占名额。
        self.assertFalse(
            build_store.reserve_screenshot_upload("session-a", "check-1")
        )
        self.assertFalse(
            build_store.report("session-a", "check-1", {"ok": True})
        )

        # 清理第二个 waiter，避免测试进程残留模块级状态。
        build_store.report("session-a", "check-2", {"ok": True})
        await build_store.wait("session-a", "check-2", timeout=0.1)

    async def test_wait_timeout_also_cleans_waiter(self):
        build_store.arm("session-b", "check-timeout")
        result = await build_store.wait(
            "session-b",
            "check-timeout",
            timeout=0.001,
        )
        self.assertIsNone(result)
        self.assertFalse(
            build_store.reserve_screenshot_upload(
                "session-b",
                "check-timeout",
            )
        )

    async def test_disarm_and_ttl_clean_pre_wait_waiters(self):
        build_store.arm("session-c", "check-disarm")
        build_store.disarm("session-c", "check-disarm")
        self.assertFalse(
            build_store.reserve_screenshot_upload(
                "session-c",
                "check-disarm",
            )
        )

        with patch.object(build_store, "_WAITER_TTL_SECONDS", 0.005):
            build_store.arm("session-c", "check-expire")
            await asyncio.sleep(0.02)
        self.assertFalse(
            build_store.reserve_screenshot_upload(
                "session-c",
                "check-expire",
            )
        )


class PreviewScreenshotStorageTests(IsolatedAsyncioTestCase):
    async def test_save_load_artifact_and_session_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "preview-screenshots"
            with patch(
                "app.preview_screenshots._storage_root",
                return_value=root,
            ):
                record = await save_screenshot(
                    "session-safe",
                    _ONE_PIXEL_PNG,
                    "image/png",
                    1,
                    1,
                    "/中文?tab=preview",
                    "mobile",
                )
                loaded = await get_screenshot("session-safe", record.id)
                self.assertIsNotNone(loaded)
                assert loaded is not None
                self.assertEqual(loaded.page_path, "/中文?tab=preview")
                self.assertEqual(loaded.device, "mobile")

                artifact = await build_screenshot_artifact(
                    "session-safe",
                    record.id,
                )
                self.assertIsNotNone(artifact)
                assert artifact is not None
                self.assertEqual(artifact["screenshot"]["id"], record.id)
                self.assertNotIn("data_url", artifact["screenshot"])
                self.assertEqual(
                    artifact["screenshot"]["ref"]["url"],
                    (
                        "/api/sessions/session-safe/preview-screenshots/"
                        f"{record.id}"
                    ),
                )
                self.assertEqual(
                    artifact["screenshot"]["ref"]["device"],
                    "mobile",
                )
                data_url = await load_screenshot_data_url(
                    "session-safe",
                    record.id,
                )
                self.assertIsNotNone(data_url)
                assert data_url is not None
                self.assertTrue(data_url.startswith("data:image/png;base64,"))

                await remove_session_screenshots("session-safe")
                self.assertFalse((root / "session-safe").exists())

    async def test_rejects_mime_spoofing(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch(
                "app.preview_screenshots._storage_root",
                return_value=Path(tmp),
            ):
                with self.assertRaisesRegex(ValueError, "格式不匹配"):
                    await save_screenshot(
                        "session-safe",
                        b"<svg onload=alert(1)>",
                        "image/png",
                        100,
                        100,
                        "/",
                    )


class ScreenshotVisionMiddlewareTests(IsolatedAsyncioTestCase):
    async def test_text_only_model_is_told_it_cannot_review_screenshot(self):
        artifact = {
            "screenshot": {
                "id": "shot-id",
                "ref": {
                    "url": "/api/sessions/session-safe/preview-screenshots/shot-id",
                    "width": 1130,
                    "height": 703,
                },
            }
        }
        messages = [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "check_build",
                        "args": {},
                        "id": "tool-id",
                        "type": "tool_call",
                    }
                ],
            ),
            ToolMessage(
                content="构建通过",
                tool_call_id="tool-id",
                artifact=artifact,
            ),
        ]
        request = ModelRequest(
            model=object(),  # type: ignore[arg-type]
            messages=messages,
        )
        captured: list[ModelRequest] = []

        async def handler(next_request: ModelRequest) -> ModelResponse:
            captured.append(next_request)
            return ModelResponse(result=[])

        with patch(
            "app.agents.middleware.load_screenshot_data_url",
            new=AsyncMock(),
        ) as load:
            middleware = ScreenshotVisionMiddleware(
                enabled=False,
                session_id="session-safe",
            )
            await middleware.awrap_model_call(request, handler)

        load.assert_not_awaited()
        self.assertEqual(len(captured[0].messages), len(messages) + 1)
        notice = captured[0].messages[-1]
        self.assertIsInstance(notice, HumanMessage)
        self.assertIn("当前模型不支持识图", str(notice.content))
        self.assertIn("禁止描述或评价截图内容", str(notice.content))

    async def test_image_is_loaded_only_for_transient_model_request(self):
        artifact = {
            "screenshot": {
                "id": "shot-id",
                "ref": {
                    "url": (
                        "/api/sessions/session-safe/"
                        "preview-screenshots/shot-id"
                    ),
                    "width": 1130,
                    "height": 703,
                    "path": "/",
                    "mime": "image/webp",
                },
            }
        }
        messages = [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "check_build",
                        "args": {},
                        "id": "tool-id",
                        "type": "tool_call",
                    }
                ],
            ),
            ToolMessage(
                content="构建通过",
                tool_call_id="tool-id",
                artifact=artifact,
            ),
        ]
        request = ModelRequest(
            model=object(),  # type: ignore[arg-type]
            messages=messages,
        )
        captured: list[ModelRequest] = []

        async def handler(next_request: ModelRequest) -> ModelResponse:
            captured.append(next_request)
            return ModelResponse(result=[])

        data_url = "data:image/png;base64," + base64.b64encode(
            _ONE_PIXEL_PNG
        ).decode("ascii")
        with patch(
            "app.agents.middleware.load_screenshot_data_url",
            new=AsyncMock(return_value=data_url),
        ) as load:
            middleware = ScreenshotVisionMiddleware(
                enabled=True,
                session_id="session-safe",
            )
            await middleware.awrap_model_call(request, handler)

        load.assert_awaited_once_with("session-safe", "shot-id")
        self.assertEqual(request.messages, messages)
        self.assertEqual(len(captured), 1)
        self.assertEqual(len(captured[0].messages), len(messages) + 1)
        image_message = captured[0].messages[-1]
        self.assertIsInstance(image_message, HumanMessage)
        self.assertIsInstance(image_message.content, list)
        assert isinstance(image_message.content, list)
        self.assertEqual(image_message.content[0]["type"], "text")
        review_prompt = image_message.content[0]["text"]
        self.assertIn("1130×703px", review_prompt)
        self.assertIn("绝不能用“可能只是窄屏”", review_prompt)
        self.assertIn("出现孤立单字", review_prompt)
        self.assertIn("不代表视觉截图已经合格", review_prompt)
        self.assertEqual(image_message.content[-1]["type"], "image")


if __name__ == "__main__":
    main()
