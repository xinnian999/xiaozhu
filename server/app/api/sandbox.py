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
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, ValidationError, field_validator

from app.config import settings
from app.deps import get_owned_session


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
            f"frame-ancestors {settings.sandbox_frame_ancestors}; "
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


class SandboxBuildRead(BaseModel):
    ok: bool
    build_id: str | None = None
    preview_url: str | None = None
    logs: str = ""
    errors: str = ""


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
) -> SandboxBuildRead:
    if not settings.sandbox_worker_token:
        raise HTTPException(status_code=503, detail="沙箱 Worker 密钥未配置")

    payload = {
        "session_id": session_id,
        "files": body.files,
        "device": body.device,
    }
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
        result = SandboxBuildRead.model_validate(response.json())
    except (ValueError, TypeError) as exc:
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
