"""后端预览沙箱 API。

主 API 负责鉴权、签发预览 capability，并从共享目录直接返回静态产物；真正的 Vite
构建在独立 sandbox-worker 中完成。公网 Web 进程不接触 Docker Socket，也不直接
执行用户项目。
"""

import base64
import binascii
import hashlib
import hmac
import re
import time
import zlib
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import FileResponse
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PrivateAttr,
    ValidationError,
    field_validator,
    model_validator,
)

from app.config import settings
from app.deps import get_owned_session
from app.preview_screenshots import MAX_SCREENSHOT_BYTES


router = APIRouter(tags=["sandbox"])
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9-]{1,80}$")
_BUILD_ID_RE = re.compile(
    r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"
)
_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_PREVIEW_TTL_SECONDS = 24 * 60 * 60
_PREVIEW_CLOCK_SKEW_SECONDS = 60
# JSON 最坏会把每个源码字节转义成 6 字节（例如 U+0000 → ``\u0000``）。
# 32 MiB 足以容纳 5 MiB 源码上限及文件名、对象结构等 wire overhead。
_MAX_BUILD_BODY_BYTES = 32 * 1024 * 1024
_MAX_FILES = 200
_MAX_FILE_BYTES = 512 * 1024
_MAX_TOTAL_FILE_BYTES = 5 * 1024 * 1024
_MAX_PREVIEW_ASSET_BYTES = 16 * 1024 * 1024
_MAX_SCREENSHOT_BASE64_CHARS = 4 * ((MAX_SCREENSHOT_BYTES + 2) // 3)
_MAX_SCREENSHOT_PATH_LENGTH = 2048
_MAX_CAPTURE_ERROR_LENGTH = 4000
_MAX_RUNTIME_ERRORS = 20
_MAX_RUNTIME_ERROR_LENGTH = 4000
_SCREENSHOT_VIEWPORTS: dict[str, tuple[int, int]] = {
    "desktop": (1280, 720),
    "mobile": (390, 844),
}
_PREVIEW_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "private, no-store",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Permissions-Policy": (
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), "
        "serial=(), bluetooth=()"
    ),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}


def _preview_headers(request_host: str) -> dict[str, str]:
    preview_host = urlsplit(settings.sandbox_preview_origin).netloc.casefold()
    allow_preview_storage = bool(
        preview_host and request_host.casefold() == preview_host
    )
    frame_ancestors = settings.sandbox_frame_ancestors.strip()
    # 本地调试可能经过 Chrome 扩展、桌面 WebView 或 HMR 的 opaque 中间文档；
    # CSP 的 ``*`` 不覆盖 opaque origin。配置 ``*`` 明确表示开发环境不限制祖先，
    # 因而直接省略该指令。生产配置真实主站 Origin 时仍会生成严格白名单。
    frame_ancestors_directive = (
        ""
        if frame_ancestors == "*"
        else f"frame-ancestors {frame_ancestors}; "
    )
    sandbox_directive = "sandbox allow-scripts allow-forms allow-modals"
    if allow_preview_storage:
        sandbox_directive += " allow-same-origin"
    return {
        **_PREVIEW_HEADERS,
        "Content-Security-Policy": (
            "default-src * data: blob:; "
            "script-src * 'unsafe-inline' 'unsafe-eval' blob:; "
            "style-src * 'unsafe-inline'; "
            "img-src * data: blob:; font-src * data:; "
            "connect-src * data: blob:; "
            "object-src 'none'; base-uri 'none'; "
            f"{frame_ancestors_directive}"
            f"{sandbox_directive}"
        ),
    }


class SandboxBuildRequest(BaseModel):
    files: dict[str, str]
    device: Literal["desktop", "mobile"] = "desktop"

    @field_validator("files")
    @classmethod
    def validate_files(cls, files: dict[str, str]) -> dict[str, str]:
        if not 1 <= len(files) <= _MAX_FILES:
            raise ValueError(f"文件数量必须在 1–{_MAX_FILES} 之间")
        total_bytes = 0
        for file_path, content in files.items():
            size = len(content.encode("utf-8"))
            if size > _MAX_FILE_BYTES:
                raise ValueError(f"单个文件超过 512KB: {file_path}")
            total_bytes += size
            if total_bytes > _MAX_TOTAL_FILE_BYTES:
                raise ValueError("项目源码总大小超过 5MB")
        return files


def _png_dimensions(raw: bytes) -> tuple[int, int]:
    """校验 PNG 的 chunk 边界与 CRC，并读取 IHDR 中的真实像素尺寸。"""
    signature = b"\x89PNG\r\n\x1a\n"
    if not raw.startswith(signature):
        raise ValueError("PNG 文件签名无效")

    offset = len(signature)
    dimensions: tuple[int, int] | None = None
    first_chunk = True
    while offset + 12 <= len(raw):
        chunk_length = int.from_bytes(raw[offset : offset + 4], "big")
        chunk_type = raw[offset + 4 : offset + 8]
        data_start = offset + 8
        data_end = data_start + chunk_length
        chunk_end = data_end + 4
        if chunk_end > len(raw):
            raise ValueError("PNG chunk 长度无效")

        supplied_crc = int.from_bytes(raw[data_end:chunk_end], "big")
        expected_crc = zlib.crc32(chunk_type)
        expected_crc = zlib.crc32(raw[data_start:data_end], expected_crc)
        if supplied_crc != expected_crc & 0xFFFFFFFF:
            raise ValueError("PNG chunk 校验失败")

        if first_chunk:
            if chunk_type != b"IHDR" or chunk_length != 13:
                raise ValueError("PNG 缺少合法 IHDR")
            width = int.from_bytes(raw[data_start : data_start + 4], "big")
            height = int.from_bytes(raw[data_start + 4 : data_start + 8], "big")
            if width <= 0 or height <= 0:
                raise ValueError("PNG 像素尺寸无效")
            dimensions = (width, height)
            first_chunk = False
        elif chunk_type == b"IHDR":
            raise ValueError("PNG 包含重复 IHDR")

        offset = chunk_end
        if chunk_type == b"IEND":
            if chunk_length != 0 or offset != len(raw) or dimensions is None:
                raise ValueError("PNG IEND 无效")
            return dimensions

    raise ValueError("PNG 数据不完整")


_JPEG_SOF_MARKERS = {
    0xC0,
    0xC1,
    0xC2,
    0xC3,
    0xC5,
    0xC6,
    0xC7,
    0xC9,
    0xCA,
    0xCB,
    0xCD,
    0xCE,
    0xCF,
}


def _jpeg_dimensions(raw: bytes) -> tuple[int, int]:
    """遍历 JPEG 头部 segment，拒绝截断数据并读取 SOF 中的真实尺寸。"""
    if len(raw) < 4 or not raw.startswith(b"\xff\xd8\xff"):
        raise ValueError("JPEG 文件签名无效")
    if not raw.endswith(b"\xff\xd9"):
        raise ValueError("JPEG 数据不完整")

    offset = 2
    dimensions: tuple[int, int] | None = None
    while offset < len(raw) - 2:
        if raw[offset] != 0xFF:
            raise ValueError("JPEG segment 边界无效")
        while offset < len(raw) and raw[offset] == 0xFF:
            offset += 1
        if offset >= len(raw):
            raise ValueError("JPEG marker 不完整")
        marker = raw[offset]
        offset += 1

        # SOI、TEM 与 restart marker 没有长度字段；EOI 不应出现在扫描数据之前。
        if marker in {0x01, 0xD8} or 0xD0 <= marker <= 0xD7:
            continue
        if marker == 0xD9:
            break
        if offset + 2 > len(raw):
            raise ValueError("JPEG segment 长度缺失")
        segment_length = int.from_bytes(raw[offset : offset + 2], "big")
        if segment_length < 2 or offset + segment_length > len(raw):
            raise ValueError("JPEG segment 长度无效")

        if marker in _JPEG_SOF_MARKERS:
            if segment_length < 8:
                raise ValueError("JPEG SOF 长度无效")
            height = int.from_bytes(raw[offset + 3 : offset + 5], "big")
            width = int.from_bytes(raw[offset + 5 : offset + 7], "big")
            if width <= 0 or height <= 0:
                raise ValueError("JPEG 像素尺寸无效")
            dimensions = (width, height)

        if marker == 0xDA:
            # 熵编码扫描数据里允许出现转义后的 0xFF，不能再按普通 segment 遍历。
            if dimensions is None:
                raise ValueError("JPEG 缺少 SOF 尺寸信息")
            return dimensions
        offset += segment_length

    raise ValueError("JPEG 缺少扫描数据")


def _decode_screenshot_data(value: str) -> bytes:
    """严格解码 canonical Base64，并在解码后执行 2 MiB 硬上限。"""
    try:
        encoded = value.encode("ascii")
        raw = base64.b64decode(encoded, validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
        raise ValueError("截图 Base64 无效") from exc
    if base64.b64encode(raw).decode("ascii") != value:
        raise ValueError("截图 Base64 不是 canonical 形式")
    if not raw or len(raw) > MAX_SCREENSHOT_BYTES:
        raise ValueError("截图大小必须在 1 字节到 2MB 之间")
    return raw


class SandboxScreenshotRead(BaseModel):
    """Worker 返回的内联截图；只在主 API 内存中使用，不下发给浏览器。"""

    model_config = ConfigDict(extra="forbid")

    data_base64: str = Field(
        min_length=4,
        max_length=_MAX_SCREENSHOT_BASE64_CHARS,
    )
    mime: Literal["image/jpeg", "image/png"]
    width: Annotated[int, Field(strict=True, gt=0, le=20_000)]
    height: Annotated[int, Field(strict=True, gt=0, le=20_000)]
    path: str = Field(min_length=1, max_length=_MAX_SCREENSHOT_PATH_LENGTH)
    device: Literal["desktop", "mobile"]
    _decoded_bytes: bytes = PrivateAttr(default=b"")

    @field_validator("path")
    @classmethod
    def validate_page_path(cls, value: str) -> str:
        if not value.startswith("/") or any(ord(char) < 0x20 for char in value):
            raise ValueError("截图页面路径无效")
        return value

    @model_validator(mode="after")
    def validate_image(self) -> "SandboxScreenshotRead":
        raw = _decode_screenshot_data(self.data_base64)
        dimensions = (
            _jpeg_dimensions(raw)
            if self.mime == "image/jpeg"
            else _png_dimensions(raw)
        )
        if dimensions != (self.width, self.height):
            raise ValueError("截图声明尺寸与图片内容不一致")
        if dimensions != _SCREENSHOT_VIEWPORTS[self.device]:
            raise ValueError("截图尺寸与画布类型不匹配")
        self._decoded_bytes = raw
        return self

    def decoded_bytes(self) -> bytes:
        """返回已经过格式、大小及真实尺寸校验的原始图片。"""
        if not self._decoded_bytes:
            # 正常 model_validate/model_copy 都会保留私有校验结果。若有人绕过验证用
            # model_construct 伪造对象，宁可降级截图，也不能只解 Base64 后直接落盘。
            raise ValueError("截图尚未完成完整校验")
        return self._decoded_bytes


RuntimeErrorText = Annotated[
    str,
    Field(strict=True, min_length=1, max_length=_MAX_RUNTIME_ERROR_LENGTH),
]


class SandboxBuildRead(BaseModel):
    """构建公共结果；截图等 Worker 内部字段不会进入 FastAPI 响应。"""

    ok: bool
    build_id: str | None = None
    preview_url: str | None = None
    logs: str = ""
    errors: str = ""
    screenshot: SandboxScreenshotRead | None = Field(
        default=None,
        exclude=True,
        repr=False,
    )
    capture_error: str = Field(default="", exclude=True, repr=False)
    runtime_errors: list[RuntimeErrorText] = Field(
        default_factory=list,
        max_length=_MAX_RUNTIME_ERRORS,
        exclude=True,
        repr=False,
    )


class _SandboxWorkerExtras(BaseModel):
    """单独校验 Worker 扩展字段，避免畸形截图抹掉可信编译结论。"""

    model_config = ConfigDict(extra="ignore")

    capture_error: str = Field(
        default="",
        strict=True,
        max_length=_MAX_CAPTURE_ERROR_LENGTH,
    )
    runtime_errors: list[RuntimeErrorText] = Field(
        default_factory=list,
        max_length=_MAX_RUNTIME_ERRORS,
    )

    @field_validator("capture_error")
    @classmethod
    def normalize_capture_error(cls, value: str) -> str:
        return value.strip()

    @field_validator("runtime_errors")
    @classmethod
    def normalize_runtime_errors(cls, values: list[str]) -> list[str]:
        normalized = [value.strip() for value in values]
        if any(not value for value in normalized):
            raise ValueError("运行时错误不能为空")
        return normalized


def _parse_worker_build_response(
    worker_body: object,
    expected_device: Literal["desktop", "mobile"],
    *,
    expect_capture: bool = True,
) -> SandboxBuildRead:
    """拆分校验构建结论与截图，截图损坏时仍保留可信的编译结果。"""
    if not isinstance(worker_body, dict):
        raise ValueError("Worker 响应不是对象")

    # 内联图片不能经公开 /sandbox-build 透传。这里只把既有公共字段交给公共模型，
    # Worker 扩展协议在下面单独收紧。
    public_payload = {
        key: worker_body[key]
        for key in ("ok", "build_id", "preview_url", "logs", "errors")
        if key in worker_body
    }
    result = SandboxBuildRead.model_validate(public_payload)
    extras = _SandboxWorkerExtras.model_validate(worker_body)

    screenshot: SandboxScreenshotRead | None = None
    capture_error = extras.capture_error
    raw_screenshot = worker_body.get("screenshot")
    if result.ok and expect_capture and raw_screenshot is not None:
        try:
            screenshot = SandboxScreenshotRead.model_validate(raw_screenshot)
            if screenshot.device != expected_device:
                raise ValueError("截图画布与构建请求不一致")
        except (ValidationError, ValueError):
            # 截图属于编译后的增强采集。协议数据畸形不能把已经可信的 Vite 成功结论
            # 改写成构建失败，但必须丢弃，绝不能存盘或送给视觉模型。
            screenshot = None
            local_error = "服务端截图返回无效，已安全忽略"
            capture_error = (
                f"{capture_error}；{local_error}" if capture_error else local_error
            )
    elif not result.ok:
        # 编译失败不会进入页面渲染阶段；即使异常 Worker 附带图片也不消费。
        screenshot = None

    if result.ok and expect_capture and screenshot is None and not capture_error:
        capture_error = "服务端未返回截图"

    return result.model_copy(
        update={
            "screenshot": screenshot,
            "capture_error": capture_error,
            "runtime_errors": extras.runtime_errors,
        }
    )


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _b64url_decode_canonical(value: str) -> bytes:
    if not _B64URL_RE.fullmatch(value):
        raise ValueError("base64url 字符无效")
    decoded = _b64url_decode(value)
    if _b64url_encode(decoded) != value:
        raise ValueError("base64url 编码不是 canonical 形式")
    return decoded


def _capability_hmac_key() -> bytes:
    # capability 属于浏览器可见的主 API 协议，不能与主 API ↔ Worker 凭证共用密钥。
    secret = settings.sandbox_capability_secret or settings.jwt_secret
    if not secret:
        raise HTTPException(status_code=503, detail="预览 capability 密钥未配置")
    return secret.encode()


def _preview_capability(session_id: str, build_id: str) -> str:
    expires = int(time.time()) + _PREVIEW_TTL_SECONDS
    payload = f"{session_id}\n{build_id}\n{expires}".encode()
    encoded = _b64url_encode(payload)
    signature = hmac.new(
        _capability_hmac_key(),
        encoded.encode(),
        hashlib.sha256,
    ).digest()
    return f"{encoded}.{_b64url_encode(signature)}"


def _read_preview_capability(capability: str) -> tuple[str, str]:
    try:
        parts = capability.split(".")
        if len(parts) != 2:
            raise ValueError
        encoded, supplied_signature = parts
        payload = _b64url_decode_canonical(encoded)
        signature = _b64url_decode_canonical(supplied_signature)
        if len(signature) != hashlib.sha256().digest_size:
            raise ValueError
        expected_signature = hmac.new(
            _capability_hmac_key(),
            encoded.encode(),
            hashlib.sha256,
        ).digest()
        if not hmac.compare_digest(signature, expected_signature):
            raise ValueError
        session_id, build_id, raw_expires = payload.decode().split("\n")
        expires = int(raw_expires)
    except (binascii.Error, UnicodeDecodeError, ValueError):
        raise HTTPException(status_code=404, detail="预览不存在") from None

    now = int(time.time())
    if (
        not _SESSION_ID_RE.fullmatch(session_id)
        or not _BUILD_ID_RE.fullmatch(build_id)
        or expires <= now
        or expires > now + _PREVIEW_TTL_SECONDS + _PREVIEW_CLOCK_SKEW_SECONDS
    ):
        raise HTTPException(status_code=404, detail="预览不存在")
    return session_id, build_id


def _safe_preview_asset_path(asset_path: str) -> tuple[str, ...]:
    if not asset_path:
        return ("index.html",)
    if "\0" in asset_path or "\\" in asset_path or asset_path.startswith("/"):
        raise HTTPException(status_code=404, detail="预览资源不存在")
    parts = asset_path.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise HTTPException(status_code=404, detail="预览资源不存在")
    return tuple(parts)


def _read_preview_asset(
    capability: str,
    asset_path: str,
    request_host: str,
) -> Response:
    session_id, build_id = _read_preview_capability(capability)
    path_parts = _safe_preview_asset_path(asset_path)
    preview_root = Path(settings.sandbox_preview_dir).resolve()
    build_root = (preview_root / session_id / build_id).resolve()
    target = build_root.joinpath(*path_parts)
    try:
        actual_build_root = build_root.resolve(strict=True)
        actual_target = target.resolve(strict=True)
        actual_target.relative_to(actual_build_root)
        target_stat = actual_target.stat()
    except (FileNotFoundError, NotADirectoryError, ValueError):
        raise HTTPException(status_code=404, detail="预览资源不存在") from None
    if not actual_target.is_file() or target.is_symlink():
        raise HTTPException(status_code=404, detail="预览资源不存在")
    if target_stat.st_size > _MAX_PREVIEW_ASSET_BYTES:
        raise HTTPException(status_code=413, detail="预览资源过大")
    return FileResponse(
        actual_target,
        headers=_preview_headers(request_host),
    )


async def _read_build_request(request: Request) -> SandboxBuildRequest:
    raw_content_length = request.headers.get("content-length")
    if raw_content_length:
        try:
            content_length = int(raw_content_length)
        except ValueError:
            raise HTTPException(status_code=400, detail="Content-Length 无效") from None
        if content_length > _MAX_BUILD_BODY_BYTES:
            raise HTTPException(status_code=413, detail="沙箱构建请求过大")

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > _MAX_BUILD_BODY_BYTES:
            raise HTTPException(status_code=413, detail="沙箱构建请求过大")
    try:
        return SandboxBuildRequest.model_validate_json(body)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="沙箱构建请求无效") from exc


@router.post(
    "/api/sessions/{session_id}/sandbox-build",
    response_model=SandboxBuildRead,
    dependencies=[Depends(get_owned_session)],
)
async def build_sandbox_preview(
    session_id: str,
    request: Request,
) -> SandboxBuildRead:
    """把当前浏览器暂存的完整文件集交给 Worker。

    不能改为“后端自己读数据库”：同批并行工具调用时，前端通过既有 early_file_write
    已经拿到了本轮完整文件，而数据库写工具可能尚未全部提交。继续以前端完整快照为准，
    可保留现有 check_build 的时序正确性。
    """
    body = await _read_build_request(request)
    return await _submit_sandbox_build(session_id, body)


async def _submit_sandbox_build(
    session_id: str,
    body: SandboxBuildRequest,
    *,
    capture: bool = False,
) -> SandboxBuildRead:
    if not settings.sandbox_worker_token:
        raise HTTPException(status_code=503, detail="沙箱 Worker 密钥未配置")

    payload = {
        "session_id": session_id,
        "files": body.files,
        "device": body.device,
    }
    # 普通预览刷新只构建/复用静态产物；只有服务端 Agent 验收才启动 Chromium。
    if capture:
        payload["capture"] = True
    headers = {"Authorization": f"Bearer {settings.sandbox_worker_token}"}
    try:
        async with httpx.AsyncClient(timeout=settings.sandbox_build_timeout_s) as client:
            response = await client.post(
                f"{settings.sandbox_worker_url.rstrip('/')}/internal/build",
                json=payload,
                headers=headers,
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="后端沙箱构建超时") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="无法连接沙箱 Worker") from exc

    if response.status_code == status.HTTP_429_TOO_MANY_REQUESTS:
        raise HTTPException(status_code=429, detail="沙箱正在构建，请稍后重试")
    if response.status_code >= 500:
        raise HTTPException(status_code=502, detail="沙箱 Worker 执行失败")
    if response.status_code >= 400:
        detail = "沙箱拒绝了本次构建"
        try:
            worker_body = response.json()
            if isinstance(worker_body, dict) and isinstance(worker_body.get("error"), str):
                detail = worker_body["error"]
        except ValueError:
            pass
        raise HTTPException(status_code=response.status_code, detail=detail)

    try:
        result = _parse_worker_build_response(
            response.json(),
            body.device,
            expect_capture=capture,
        )
    except (ValidationError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="沙箱 Worker 返回格式无效") from exc

    if not result.ok:
        return result
    if not result.build_id or not _BUILD_ID_RE.fullmatch(result.build_id):
        raise HTTPException(status_code=502, detail="沙箱 Worker 返回的构建 ID 无效")
    capability = _preview_capability(session_id, result.build_id)
    preview_path = f"/api/sandbox-preview/{capability}/"
    preview_origin = settings.sandbox_preview_origin.rstrip("/")
    return result.model_copy(
        update={
            "preview_url": (
                f"{preview_origin}{preview_path}" if preview_origin else preview_path
            )
        }
    )


@router.get("/api/sandbox-preview/{capability}/")
async def read_sandbox_preview_index(
    capability: str,
    request: Request,
) -> Response:
    """以短期 capability 读取入口页；iframe 导航无需暴露登录 JWT。"""
    return _read_preview_asset(
        capability,
        "index.html",
        request.headers.get("host", ""),
    )


@router.get("/api/sandbox-preview/{capability}/{asset_path:path}")
async def read_sandbox_preview_asset(
    capability: str,
    asset_path: str,
    request: Request,
) -> Response:
    """只读取 capability 绑定的共享目录产物，浏览器不能指定任意文件根目录。"""
    return _read_preview_asset(
        capability,
        asset_path,
        request.headers.get("host", ""),
    )
