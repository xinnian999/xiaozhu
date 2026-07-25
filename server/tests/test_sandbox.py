from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch

from fastapi import HTTPException

from app.api import sandbox
from app.config import Settings


class SandboxConfigTests(TestCase):
    def test_preview_runtime_defaults_to_webcontainer(self):
        configured = Settings(_env_file=None)
        self.assertEqual(configured.preview_runtime, "webcontainer")

    def test_unknown_runtime_falls_back_to_webcontainer(self):
        with patch.object(sandbox.settings, "preview_runtime", "typo"):
            self.assertEqual(sandbox._preview_runtime(), "webcontainer")


class _FakeResponse:
    status_code = 200

    @staticmethod
    def json():
        return {
            "ok": True,
            "build_id": "build-1",
            "preview_url": "https://preview.example/build-1/",
            "logs": "built",
            "errors": "",
        }


class _FakeClient:
    def __init__(self):
        self.request = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, url, **kwargs):
        self.request = (url, kwargs)
        return _FakeResponse()


class SandboxBuildTests(IsolatedAsyncioTestCase):
    async def test_worker_token_is_required(self):
        with (
            patch.object(sandbox.settings, "preview_runtime", "server"),
            patch.object(sandbox.settings, "sandbox_worker_token", ""),
            self.assertRaises(HTTPException) as raised,
        ):
            await sandbox.build_sandbox_preview(
                "session-1",
                sandbox.SandboxBuildRequest(files={"src/App.tsx": "export default 1"}),
            )
        self.assertEqual(raised.exception.status_code, 503)

    async def test_successful_worker_response_is_validated_and_forwarded(self):
        client = _FakeClient()
        with (
            patch.object(sandbox.settings, "preview_runtime", "server"),
            patch.object(sandbox.settings, "sandbox_worker_token", "worker-secret"),
            patch.object(sandbox.settings, "sandbox_worker_url", "http://worker:8010/"),
            patch.object(sandbox.httpx, "AsyncClient", return_value=client),
        ):
            result = await sandbox.build_sandbox_preview(
                "session-1",
                sandbox.SandboxBuildRequest(
                    files={"src/App.tsx": "export default 1"},
                    device="mobile",
                ),
            )

        self.assertTrue(result.ok)
        self.assertEqual(result.preview_url, "https://preview.example/build-1/")
        self.assertIsNotNone(client.request)
        url, kwargs = client.request
        self.assertEqual(url, "http://worker:8010/internal/build")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer worker-secret")
        self.assertEqual(kwargs["json"]["device"], "mobile")


if __name__ == "__main__":
    import unittest

    unittest.main()
