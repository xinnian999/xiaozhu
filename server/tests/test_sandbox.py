import hashlib
import hmac
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

from app.api import sandbox


SESSION_ID = "session-1"
BUILD_ID = "123e4567-e89b-42d3-a456-426614174000"
WORKER_TOKEN = "worker-secret"
CAPABILITY_SECRET = "capability-secret"
JWT_SECRET = "jwt-secret"
NOW = 1_700_000_000


class _FakeResponse:
    def __init__(
        self,
        *,
        status_code: int = 200,
        json_data: object | None = None,
        content: bytes = b"",
        chunks: list[bytes] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.status_code = status_code
        self._json_data = json_data
        self.content = content
        self.chunks = chunks
        self.headers = headers or {}

    def json(self) -> object:
        return self._json_data

    async def aiter_bytes(self):
        for chunk in self.chunks if self.chunks is not None else [self.content]:
            if chunk:
                yield chunk


class _FakeStreamContext:
    def __init__(
        self,
        response: _FakeResponse | None,
        error: Exception | None,
    ) -> None:
        self.response = response
        self.error = error

    async def __aenter__(self) -> _FakeResponse:
        if self.error is not None:
            raise self.error
        if self.response is None:
            raise AssertionError("unexpected stream")
        return self.response

    async def __aexit__(self, *_args):
        return None


class _FakeClient:
    def __init__(
        self,
        *,
        post_response: _FakeResponse | None = None,
        get_response: _FakeResponse | None = None,
        get_error: Exception | None = None,
    ) -> None:
        self.post_response = post_response
        self.get_response = get_response
        self.get_error = get_error
        self.requests: list[tuple[str, str, dict[str, object]]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, url: str, **kwargs):
        self.requests.append(("POST", url, kwargs))
        if self.post_response is None:
            raise AssertionError("unexpected POST")
        return self.post_response

    def stream(self, method: str, url: str, **kwargs) -> _FakeStreamContext:
        self.requests.append((method, url, kwargs))
        return _FakeStreamContext(self.get_response, self.get_error)


def _successful_build_response() -> _FakeResponse:
    return _FakeResponse(
        json_data={
            "ok": True,
            "build_id": BUILD_ID,
            # 主 API 必须忽略 Worker 给出的公网 URL，避免浏览器访问任意上游。
            "preview_url": "http://169.254.169.254/latest/meta-data/",
            "logs": "built",
            "errors": "",
        }
    )


def _capability() -> str:
    with patch.object(sandbox.time, "time", return_value=NOW):
        return sandbox._preview_capability(SESSION_ID, BUILD_ID)


def _signed_capability(secret: str, expires: int) -> str:
    payload = f"{SESSION_ID}\n{BUILD_ID}\n{expires}".encode()
    encoded = sandbox._b64url_encode(payload)
    signature = hmac.new(
        secret.encode(),
        encoded.encode(),
        hashlib.sha256,
    ).digest()
    return f"{encoded}.{sandbox._b64url_encode(signature)}"


def _request(host: str = "app.example") -> Request:
    return Request(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "https",
            "path": "/",
            "raw_path": b"/",
            "query_string": b"",
            "headers": [(b"host", host.encode())],
            "client": ("test", 123),
            "server": (host, 443),
        }
    )


def _body_request(
    body: bytes,
    *,
    content_length: int | None = None,
) -> Request:
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    headers = [(b"content-type", b"application/json")]
    if content_length is not None:
        headers.append((b"content-length", str(content_length).encode()))
    return Request(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "https",
            "path": "/api/sandbox-build",
            "raw_path": b"/api/sandbox-build",
            "query_string": b"",
            "headers": headers,
            "client": ("test", 123),
            "server": ("app.example", 443),
        },
        receive,
    )


class CapabilitySecretTestCase(IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        super().setUp()
        secret_patch = patch.object(
            sandbox.settings,
            "sandbox_capability_secret",
            CAPABILITY_SECRET,
        )
        secret_patch.start()
        self.addCleanup(secret_patch.stop)


class SandboxBuildTests(CapabilitySecretTestCase):
    async def test_worker_token_is_required(self):
        with (
            patch.object(sandbox.settings, "sandbox_worker_token", ""),
            self.assertRaises(HTTPException) as raised,
        ):
            await sandbox._submit_sandbox_build(
                SESSION_ID,
                sandbox.SandboxBuildRequest(
                    files={"src/App.tsx": "export default 1"}
                ),
            )
        self.assertEqual(raised.exception.status_code, 503)

    async def test_successful_build_mints_relative_capability_url(self):
        client = _FakeClient(post_response=_successful_build_response())
        with (
            patch.object(sandbox.settings, "sandbox_worker_token", WORKER_TOKEN),
            patch.object(sandbox.settings, "sandbox_worker_url", "http://worker:8010/"),
            patch.object(sandbox.settings, "sandbox_preview_origin", ""),
            patch.object(sandbox.time, "time", return_value=NOW),
            patch.object(sandbox.httpx, "AsyncClient", return_value=client),
        ):
            result = await sandbox._submit_sandbox_build(
                SESSION_ID,
                sandbox.SandboxBuildRequest(
                    files={"src/App.tsx": "export default 1"},
                    device="mobile",
                ),
            )

            self.assertTrue(result.ok)
            self.assertIsNotNone(result.preview_url)
            self.assertRegex(
                result.preview_url or "",
                r"^/api/sandbox-preview/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/$",
            )
            self.assertNotIn("169.254.169.254", result.preview_url or "")
            capability = (result.preview_url or "").removeprefix(
                "/api/sandbox-preview/"
            ).removesuffix("/")
            self.assertEqual(
                sandbox._read_preview_capability(capability),
                (SESSION_ID, BUILD_ID),
            )

        self.assertEqual(len(client.requests), 1)
        method, url, kwargs = client.requests[0]
        self.assertEqual(method, "POST")
        self.assertEqual(url, "http://worker:8010/internal/build")
        self.assertEqual(
            kwargs["headers"],
            {"Authorization": f"Bearer {WORKER_TOKEN}"},
        )
        self.assertEqual(kwargs["json"]["device"], "mobile")

    async def test_configured_preview_origin_is_used(self):
        client = _FakeClient(post_response=_successful_build_response())
        with (
            patch.object(sandbox.settings, "sandbox_worker_token", WORKER_TOKEN),
            patch.object(sandbox.settings, "sandbox_preview_origin", "https://preview.example/"),
            patch.object(sandbox.time, "time", return_value=NOW),
            patch.object(sandbox.httpx, "AsyncClient", return_value=client),
        ):
            result = await sandbox._submit_sandbox_build(
                SESSION_ID,
                sandbox.SandboxBuildRequest(
                    files={"src/App.tsx": "export default 1"}
                ),
            )

        self.assertIsNotNone(result.preview_url)
        self.assertTrue(
            (result.preview_url or "").startswith(
                "https://preview.example/api/sandbox-preview/"
            )
        )

    async def test_request_body_limit_is_checked_before_json_parsing(self):
        self.assertEqual(sandbox._MAX_BUILD_BODY_BYTES, 32 * 1024 * 1024)
        request = _body_request(
            b"{}",
            content_length=sandbox._MAX_BUILD_BODY_BYTES + 1,
        )
        with self.assertRaises(HTTPException) as raised:
            await sandbox._read_build_request(request)
        self.assertEqual(raised.exception.status_code, 413)

    async def test_file_limits_are_checked_by_public_request_model(self):
        oversized = "x" * (sandbox._MAX_FILE_BYTES + 1)
        request = _body_request(
            (
                '{"files":{"src/App.tsx":"'
                + oversized
                + '"},"device":"desktop"}'
            ).encode()
        )
        with self.assertRaises(HTTPException) as raised:
            await sandbox._read_build_request(request)
        self.assertEqual(raised.exception.status_code, 422)

    async def test_wire_limit_accepts_worst_case_escaped_five_mib_payload(self):
        file_count = (
            sandbox._MAX_TOTAL_FILE_BYTES // sandbox._MAX_FILE_BYTES
        )
        content = "\0" * sandbox._MAX_FILE_BYTES
        wire = json.dumps(
            {
                "files": {
                    f"src/file-{index}.txt": content
                    for index in range(file_count)
                },
                "device": "desktop",
            },
            separators=(",", ":"),
        ).encode()

        self.assertGreater(len(wire), 6 * 1024 * 1024)
        self.assertLess(len(wire), sandbox._MAX_BUILD_BODY_BYTES)
        parsed = await sandbox._read_build_request(
            _body_request(wire, content_length=len(wire))
        )
        self.assertEqual(
            sum(len(value.encode()) for value in parsed.files.values()),
            sandbox._MAX_TOTAL_FILE_BYTES,
        )


class PreviewCapabilityTests(CapabilitySecretTestCase):
    async def test_worker_token_cannot_sign_browser_capability(self):
        forged = _signed_capability(
            WORKER_TOKEN,
            NOW + sandbox._PREVIEW_TTL_SECONDS,
        )

        with (
            patch.object(sandbox.settings, "sandbox_worker_token", WORKER_TOKEN),
            patch.object(sandbox.time, "time", return_value=NOW),
            self.assertRaises(HTTPException) as raised,
        ):
            sandbox._read_preview_capability(forged)

        self.assertEqual(raised.exception.status_code, 404)

    async def test_empty_capability_secret_falls_back_to_jwt_secret(self):
        with (
            patch.object(sandbox.settings, "sandbox_capability_secret", ""),
            patch.object(sandbox.settings, "jwt_secret", JWT_SECRET),
            patch.object(sandbox.settings, "sandbox_worker_token", "worker-a"),
            patch.object(sandbox.time, "time", return_value=NOW),
        ):
            capability = sandbox._preview_capability(SESSION_ID, BUILD_ID)

        with (
            patch.object(sandbox.settings, "sandbox_capability_secret", ""),
            patch.object(sandbox.settings, "jwt_secret", JWT_SECRET),
            patch.object(sandbox.settings, "sandbox_worker_token", "worker-b"),
            patch.object(sandbox.time, "time", return_value=NOW),
        ):
            self.assertEqual(
                sandbox._read_preview_capability(capability),
                (SESSION_ID, BUILD_ID),
            )

    async def test_tampered_capability_is_hidden_as_not_found(self):
        capability = _capability()
        encoded, _signature = capability.split(".", 1)
        tampered = f"{encoded}.AAAA"

        with (
            patch.object(sandbox.settings, "sandbox_worker_token", WORKER_TOKEN),
            patch.object(sandbox.time, "time", return_value=NOW),
            self.assertRaises(HTTPException) as raised,
        ):
            sandbox._read_preview_capability(tampered)

        self.assertEqual(raised.exception.status_code, 404)
        self.assertEqual(raised.exception.detail, "预览不存在")

    async def test_noncanonical_capability_forms_are_rejected(self):
        capability = _capability()
        malformed_values = (
            capability + "!",
            capability + "!!!!",
            capability + ".",
            capability + ".AAAA",
            capability + "=",
        )

        for malformed in malformed_values:
            with self.subTest(suffix=malformed.removeprefix(capability)):
                with (
                    patch.object(sandbox.time, "time", return_value=NOW),
                    self.assertRaises(HTTPException) as raised,
                ):
                    sandbox._read_preview_capability(malformed)

                self.assertEqual(raised.exception.status_code, 404)
                self.assertEqual(raised.exception.detail, "预览不存在")

    async def test_expired_capability_is_hidden_as_not_found(self):
        capability = _capability()

        with (
            patch.object(sandbox.settings, "sandbox_worker_token", WORKER_TOKEN),
            patch.object(
                sandbox.time,
                "time",
                return_value=NOW + sandbox._PREVIEW_TTL_SECONDS,
            ),
            self.assertRaises(HTTPException) as raised,
        ):
            sandbox._read_preview_capability(capability)

        self.assertEqual(raised.exception.status_code, 404)
        self.assertEqual(raised.exception.detail, "预览不存在")

    async def test_capability_expiry_cannot_exceed_ttl_and_clock_skew(self):
        with patch.object(
            sandbox.time,
            "time",
            return_value=NOW + sandbox._PREVIEW_CLOCK_SKEW_SECONDS + 1,
        ):
            capability = sandbox._preview_capability(SESSION_ID, BUILD_ID)

        with (
            patch.object(sandbox.time, "time", return_value=NOW),
            self.assertRaises(HTTPException) as raised,
        ):
            sandbox._read_preview_capability(capability)

        self.assertEqual(raised.exception.status_code, 404)
        self.assertEqual(raised.exception.detail, "预览不存在")


class PreviewFileTests(CapabilitySecretTestCase):
    async def test_dev_wildcard_omits_frame_ancestors_for_opaque_debug_ancestors(
        self,
    ):
        with (
            patch.object(
                sandbox.settings,
                "sandbox_preview_origin",
                "http://preview.localhost:7300",
            ),
            patch.object(
                sandbox.settings,
                "sandbox_frame_ancestors",
                "*",
            ),
        ):
            csp = sandbox._preview_headers("preview.localhost:7300")[
                "Content-Security-Policy"
            ]

        self.assertNotIn("frame-ancestors", csp)
        self.assertIn("sandbox allow-scripts", csp)

    async def test_main_origin_response_is_forced_into_opaque_sandbox(self):
        with (
            patch.object(
                sandbox.settings,
                "sandbox_preview_origin",
                "https://preview.example",
            ),
            patch.object(
                sandbox.settings,
                "sandbox_frame_ancestors",
                "https://app.example",
            ),
        ):
            csp = sandbox._preview_headers("app.example")[
                "Content-Security-Policy"
            ]

        self.assertIn("sandbox allow-scripts allow-forms allow-modals", csp)
        self.assertNotIn("allow-same-origin", csp)

    def _write_asset(
        self,
        root: str,
        relative_path: str,
        content: bytes,
    ) -> None:
        target = Path(root, SESSION_ID, BUILD_ID, relative_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)

    async def test_index_is_read_directly_from_shared_directory(self):
        capability = _capability()
        with TemporaryDirectory() as root:
            self._write_asset(root, "index.html", b"<html>preview</html>")
            with (
                patch.object(sandbox.settings, "sandbox_preview_dir", root),
                patch.object(sandbox.time, "time", return_value=NOW),
            ):
                response = await sandbox.read_sandbox_preview_index(
                    capability,
                    _request(),
                )

            self.assertEqual(
                Path(response.path).read_bytes(),
                b"<html>preview</html>",
            )
            self.assertEqual(response.media_type, "text/html")

    async def test_nested_unicode_asset_is_read_from_shared_directory(self):
        capability = _capability()
        with TemporaryDirectory() as root:
            self._write_asset(root, "assets/你好 logo.svg", b"<svg/>")
            with (
                patch.object(sandbox.settings, "sandbox_preview_dir", root),
                patch.object(sandbox.time, "time", return_value=NOW),
            ):
                response = await sandbox.read_sandbox_preview_asset(
                    capability,
                    "assets/你好 logo.svg",
                    _request(),
                )

            self.assertEqual(Path(response.path).read_bytes(), b"<svg/>")
            self.assertEqual(response.media_type, "image/svg+xml")

    async def test_direct_response_has_preview_security_policy(self):
        capability = _capability()
        with TemporaryDirectory() as root:
            self._write_asset(root, "assets/app.js", b"console.log('ok')")
            with (
                patch.object(sandbox.settings, "sandbox_preview_dir", root),
                patch.object(
                    sandbox.settings,
                    "sandbox_preview_origin",
                    "https://preview.example",
                ),
                patch.object(
                    sandbox.settings,
                    "sandbox_frame_ancestors",
                    "https://app.example",
                ),
                patch.object(sandbox.time, "time", return_value=NOW),
            ):
                response = await sandbox.read_sandbox_preview_asset(
                    capability,
                    "assets/app.js",
                    _request("preview.example"),
                )

        self.assertEqual(response.headers["access-control-allow-origin"], "*")
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.assertEqual(
            response.headers["cross-origin-resource-policy"],
            "cross-origin",
        )
        self.assertIn(
            "frame-ancestors https://app.example",
            response.headers["content-security-policy"],
        )
        self.assertIn(
            "sandbox allow-scripts allow-forms allow-modals allow-same-origin",
            response.headers["content-security-policy"],
        )
        self.assertIn("camera=()", response.headers["permissions-policy"])

    async def test_oversized_asset_is_rejected(self):
        capability = _capability()
        with TemporaryDirectory() as root:
            self._write_asset(root, "assets/large.bin", b"123456789")
            with (
                patch.object(sandbox.settings, "sandbox_preview_dir", root),
                patch.object(sandbox, "_MAX_PREVIEW_ASSET_BYTES", 8),
                patch.object(sandbox.time, "time", return_value=NOW),
                self.assertRaises(HTTPException) as raised,
            ):
                await sandbox.read_sandbox_preview_asset(
                    capability,
                    "assets/large.bin",
                    _request(),
                )

        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(raised.exception.detail, "预览资源过大")

    async def test_missing_asset_returns_404(self):
        capability = _capability()
        with TemporaryDirectory() as root:
            with (
                patch.object(sandbox.settings, "sandbox_preview_dir", root),
                patch.object(sandbox.time, "time", return_value=NOW),
                self.assertRaises(HTTPException) as raised,
            ):
                await sandbox.read_sandbox_preview_asset(
                    capability,
                    "missing.js",
                    _request(),
                )

        self.assertEqual(raised.exception.status_code, 404)
        self.assertEqual(raised.exception.detail, "预览资源不存在")

    async def test_path_traversal_is_rejected(self):
        capability = _capability()
        blocked_paths = (
            "../secret",
            "assets/../secret",
            "./index.html",
            "/etc/passwd",
            r"assets\\secret.js",
            "assets//secret.js",
            "assets/\0secret.js",
        )

        with TemporaryDirectory() as root:
            for asset_path in blocked_paths:
                with self.subTest(asset_path=asset_path):
                    with (
                        patch.object(sandbox.settings, "sandbox_preview_dir", root),
                        patch.object(sandbox.time, "time", return_value=NOW),
                        self.assertRaises(HTTPException) as raised,
                    ):
                        await sandbox.read_sandbox_preview_asset(
                            capability,
                            asset_path,
                            _request(),
                        )

                    self.assertEqual(raised.exception.status_code, 404)

    async def test_symlink_cannot_escape_shared_build_directory(self):
        capability = _capability()
        with TemporaryDirectory() as root, TemporaryDirectory() as outside:
            build_root = Path(root, SESSION_ID, BUILD_ID)
            build_root.mkdir(parents=True)
            secret = Path(outside, "secret.txt")
            secret.write_text("secret")
            Path(build_root, "escape.txt").symlink_to(secret)
            with (
                patch.object(sandbox.settings, "sandbox_preview_dir", root),
                patch.object(sandbox.time, "time", return_value=NOW),
                self.assertRaises(HTTPException) as raised,
            ):
                await sandbox.read_sandbox_preview_asset(
                    capability,
                    "escape.txt",
                    _request(),
                )

        self.assertEqual(raised.exception.status_code, 404)


if __name__ == "__main__":
    import unittest

    unittest.main()
