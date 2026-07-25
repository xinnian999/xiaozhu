"""预览自检截图 API。

上传端接收浏览器生成的原始 WebP/PNG/JPEG body，避免 base64 额外膨胀；读取端继续走
会话归属鉴权，前端需带 JWT fetch 成 Blob 后再展示，不能把私有文件当公开静态资源。
"""

from typing import Annotated, Literal
from urllib.parse import unquote

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import build_store
from app.deps import get_owned_session
from app.generation_control import is_session_deleting
from app.preview_screenshots import (
    MAX_SCREENSHOT_BYTES,
    get_screenshot,
    remove_screenshot,
    save_screenshot,
)


router = APIRouter(
    prefix="/api/sessions/{session_id}/preview-screenshots",
    tags=["preview-screenshots"],
    dependencies=[Depends(get_owned_session)],
)

_ALLOWED_MIMES = {"image/webp", "image/png", "image/jpeg"}
_MAX_PAGE_PATH_LENGTH = 2048


class PreviewScreenshotRead(BaseModel):
    """上传成功后返回给构建结果与消息卡片使用的轻量引用。"""

    id: str
    url: str
    width: int
    height: int
    path: str
    mime: str
    device: Literal["desktop", "mobile"]


async def _read_limited_body(request: Request) -> bytes:
    """流式读取并在 2 MiB 处立即止损，不能只相信 Content-Length。"""
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_SCREENSHOT_BYTES:
                raise HTTPException(
                    status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                    detail="截图不能超过 2MB",
                )
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Content-Length 格式不正确",
            ) from None

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_SCREENSHOT_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="截图不能超过 2MB",
            )
        chunks.append(chunk)
    raw = b"".join(chunks)
    if not raw:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="截图内容不能为空",
        )
    return raw


@router.post("", response_model=PreviewScreenshotRead, status_code=201)
async def upload_preview_screenshot(
    session_id: str,
    request: Request,
    width: Annotated[
        int,
        Header(alias="X-Screenshot-Width", gt=0, le=20_000),
    ],
    height: Annotated[
        int,
        Header(alias="X-Screenshot-Height", gt=0, le=20_000),
    ],
    page_path: Annotated[
        str,
        Header(alias="X-Screenshot-Path", min_length=1, max_length=_MAX_PAGE_PATH_LENGTH),
    ],
    check_id: Annotated[
        str,
        Header(alias="X-Check-Id", min_length=1, max_length=512),
    ],
    device: Annotated[
        Literal["desktop", "mobile"],
        Header(alias="X-Screenshot-Device"),
    ] = "desktop",
) -> PreviewScreenshotRead:
    """保存 iframe 自己生成的截图，并返回后续只需携带的 screenshot_id。"""
    mime = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if is_session_deleting(session_id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="项目正在删除，不能继续保存截图",
        )
    if mime not in _ALLOWED_MIMES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="截图仅支持 image/webp、image/png 或 image/jpeg",
        )

    # 只有正在等待的 check_build 能写一张截图；拒绝把鉴权上传接口变成通用文件仓库。
    if not build_store.reserve_screenshot_upload(session_id, check_id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="本次构建检查不存在、已结束或已有截图",
        )

    try:
        raw = await _read_limited_body(request)
        # 浏览器为避开 HTTP header 的非 ASCII 限制会先 encodeURIComponent；这里还原成
        # 用户真实看到的路由，再写 sidecar 和回传卡片。
        decoded_page_path = unquote(page_path)
        if not decoded_page_path or len(decoded_page_path) > _MAX_PAGE_PATH_LENGTH:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="截图页面路径不合法",
            )
        record = await save_screenshot(
            session_id,
            raw,
            mime,
            width,
            height,
            decoded_page_path,
            device,
        )
        # save_screenshot 在线程池落盘；删除可能在这段 await 中开始。二次检查保证迟到
        # 文件不会在 remove_session_screenshots 之后重新创建会话目录。
        if is_session_deleting(session_id):
            await remove_screenshot(record)
            build_store.release_screenshot_upload(session_id, check_id)
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="项目正在删除，截图已丢弃",
            )
    except HTTPException:
        build_store.release_screenshot_upload(session_id, check_id)
        raise
    except ValueError as exc:
        build_store.release_screenshot_upload(session_id, check_id)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except (OSError, RuntimeError) as exc:
        build_store.release_screenshot_upload(session_id, check_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="截图保存失败",
        ) from exc

    if not build_store.commit_screenshot_upload(
        session_id,
        check_id,
        record.id,
    ):
        # waiter 可能恰好在落盘期间超时；迟到文件没有消费者，立即回滚。
        await remove_screenshot(record)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="本次构建检查已结束",
        )
    return PreviewScreenshotRead.model_validate(record.ref())


@router.get("/{screenshot_id}")
async def read_preview_screenshot(
    session_id: str,
    screenshot_id: str,
) -> FileResponse:
    """鉴权读取私有截图；不存在、损坏或跨会话引用一律返回 404。"""
    record = await get_screenshot(session_id, screenshot_id)
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="截图不存在",
        )
    return FileResponse(
        record.file_path,
        media_type=record.mime,
        headers={
            "Cache-Control": "private, max-age=31536000, immutable",
            "Vary": "Authorization",
            "X-Content-Type-Options": "nosniff",
        },
    )
