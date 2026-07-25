"""预览自检截图的文件存储。

截图是一次 check_build 的短生命周期产物，但需要同时服务三个消费者：
  1. Agent：读取原图并临时作为视觉输入；
  2. 消息卡片：刷新后仍能通过鉴权接口预览；
  3. 会话删除：精确清掉这一会话名下的图片。

图片本体放在 DATABASE_URL 同目录的 ``preview-screenshots/{session_id}`` 下，不把
几百 KB 的二进制继续塞进 SQLite。又因为不新增数据库表，宽高、页面路径、画布设备和
MIME 用同名 ``.json`` sidecar 保存；截图 ID 始终是服务端生成的 UUID，读取时不会接受
任意文件名。
"""

import asyncio
import base64
import json
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy.engine import make_url

from app.config import settings


MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024

_MIME_TO_SUFFIX = {
    "image/webp": ".webp",
    "image/png": ".png",
    "image/jpeg": ".jpg",
}
_SUFFIX_TO_MIME = {suffix: mime for mime, suffix in _MIME_TO_SUFFIX.items()}


def _matches_image_signature(raw: bytes, mime: str) -> bool:
    """校验最小文件签名，不能只相信客户端声明的 Content-Type。"""
    if mime == "image/webp":
        return (
            len(raw) >= 12
            and raw[:4] == b"RIFF"
            and raw[8:12] == b"WEBP"
        )
    if mime == "image/png":
        return raw.startswith(b"\x89PNG\r\n\x1a\n")
    if mime == "image/jpeg":
        return raw.startswith(b"\xff\xd8\xff")
    return False


def _storage_root() -> Path:
    """取主数据库文件同级目录，保持 Docker 挂载与本地开发都天然持久化。"""
    url = make_url(settings.database_url)
    if not url.drivername.startswith("sqlite") or not url.database:
        raise RuntimeError("预览截图存储当前要求 DATABASE_URL 指向 SQLite 文件")

    database = url.database
    if database == ":memory:":
        # 单测若使用内存库，落盘位置仍固定在当前工作目录，不把冒号当文件夹名。
        return Path(".") / "preview-screenshots"
    return Path(database).expanduser().parent / "preview-screenshots"


def _safe_session_dir(session_id: str) -> Path:
    """把 session_id 限制为单个路径片段，杜绝删除/读取时越出截图根目录。"""
    if (
        not session_id
        or session_id in {".", ".."}
        or "/" in session_id
        or "\\" in session_id
        or "\x00" in session_id
    ):
        raise ValueError("非法 session_id")
    return _storage_root() / session_id


def _normalize_screenshot_id(screenshot_id: str) -> str:
    """截图 ID 只能是本服务生成的 UUID，不允许借 ID 传入文件路径。"""
    try:
        return str(uuid.UUID(screenshot_id))
    except (ValueError, AttributeError, TypeError) as exc:
        raise ValueError("非法 screenshot_id") from exc


@dataclass(frozen=True)
class ScreenshotRecord:
    """一张已持久化截图及其卡片展示元数据。"""

    id: str
    session_id: str
    mime: str
    width: int
    height: int
    page_path: str
    device: str
    file_path: Path

    def ref(self) -> dict[str, Any]:
        """返回可安全下发给前端的引用，不暴露服务器文件路径。"""
        return {
            "id": self.id,
            "url": (
                f"/api/sessions/{self.session_id}/preview-screenshots/{self.id}"
            ),
            "width": self.width,
            "height": self.height,
            "path": self.page_path,
            "mime": self.mime,
            "device": self.device,
        }


def _write_screenshot(
    session_id: str,
    raw: bytes,
    mime: str,
    width: int,
    height: int,
    page_path: str,
    device: str,
) -> ScreenshotRecord:
    """同步写入图片与 sidecar；由异步 API 放到线程池执行。"""
    suffix = _MIME_TO_SUFFIX[mime]
    screenshot_id = str(uuid.uuid4())
    session_dir = _safe_session_dir(session_id)
    session_dir.mkdir(parents=True, exist_ok=True)

    image_path = session_dir / f"{screenshot_id}{suffix}"
    meta_path = session_dir / f"{screenshot_id}.json"
    image_tmp = session_dir / f".{screenshot_id}{suffix}.tmp"
    meta_tmp = session_dir / f".{screenshot_id}.json.tmp"

    metadata = {
        "id": screenshot_id,
        "mime": mime,
        "width": width,
        "height": height,
        "path": page_path,
        "device": device,
        "filename": image_path.name,
    }

    try:
        image_tmp.write_bytes(raw)
        meta_tmp.write_text(
            json.dumps(metadata, ensure_ascii=False),
            encoding="utf-8",
        )
        # 同目录 os.replace 是原子的；先图片后元数据，读取方永远不会看到指向缺图的 sidecar。
        os.replace(image_tmp, image_path)
        os.replace(meta_tmp, meta_path)
    finally:
        image_tmp.unlink(missing_ok=True)
        meta_tmp.unlink(missing_ok=True)

    return ScreenshotRecord(
        id=screenshot_id,
        session_id=session_id,
        mime=mime,
        width=width,
        height=height,
        page_path=page_path,
        device=device,
        file_path=image_path,
    )


async def save_screenshot(
    session_id: str,
    raw: bytes,
    mime: str,
    width: int,
    height: int,
    page_path: str,
    device: str = "desktop",
) -> ScreenshotRecord:
    """持久化一张已通过 API 校验的截图。"""
    if mime not in _MIME_TO_SUFFIX:
        raise ValueError("不支持的截图格式")
    if not raw or len(raw) > MAX_SCREENSHOT_BYTES:
        raise ValueError("截图大小不合法")
    if not _matches_image_signature(raw, mime):
        raise ValueError("截图内容与声明格式不匹配")
    if device not in {"desktop", "mobile"}:
        raise ValueError("截图画布类型不合法")
    return await asyncio.to_thread(
        _write_screenshot,
        session_id,
        raw,
        mime,
        width,
        height,
        page_path,
        device,
    )


def _load_screenshot(session_id: str, screenshot_id: str) -> ScreenshotRecord | None:
    """同步校验并读取 sidecar；所有路径都由服务端 UUID 和白名单后缀组成。"""
    normalized_id = _normalize_screenshot_id(screenshot_id)
    session_dir = _safe_session_dir(session_id)
    meta_path = session_dir / f"{normalized_id}.json"
    if not meta_path.is_file():
        return None

    try:
        metadata = json.loads(meta_path.read_text(encoding="utf-8"))
        mime = str(metadata["mime"])
        suffix = _MIME_TO_SUFFIX[mime]
        # filename 不直接信 sidecar 内容，按 ID + MIME 白名单重新计算。
        image_path = session_dir / f"{normalized_id}{suffix}"
        width = int(metadata["width"])
        height = int(metadata["height"])
        page_path = str(metadata.get("path") or "/")
        # 旧 sidecar 没有设备字段，按上线前唯一存在的桌面画布兼容读取。
        device = str(metadata.get("device") or "desktop")
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None

    if (
        metadata.get("id") != normalized_id
        or width <= 0
        or height <= 0
        or device not in {"desktop", "mobile"}
        or not image_path.is_file()
    ):
        return None

    return ScreenshotRecord(
        id=normalized_id,
        session_id=session_id,
        mime=mime,
        width=width,
        height=height,
        page_path=page_path,
        device=device,
        file_path=image_path,
    )


async def get_screenshot(
    session_id: str, screenshot_id: str
) -> ScreenshotRecord | None:
    """按会话 + ID 查截图；非法 ID 与不存在统一视为未找到。"""
    try:
        return await asyncio.to_thread(
            _load_screenshot,
            session_id,
            screenshot_id,
        )
    except ValueError:
        return None


def _remove_screenshot(record: ScreenshotRecord) -> None:
    """删除一张尚未成功绑定到 build-result 的迟到截图。"""
    record.file_path.unlink(missing_ok=True)
    record.file_path.with_name(f"{record.id}.json").unlink(missing_ok=True)
    try:
        record.file_path.parent.rmdir()
    except OSError:
        # 目录里还有历史截图，或刚好有并发写入，保留目录即可。
        pass


async def remove_screenshot(record: ScreenshotRecord) -> None:
    """异步包装单图清理，供上传与 waiter 竞态失败时回滚。"""
    await asyncio.to_thread(_remove_screenshot, record)


async def build_screenshot_artifact(
    session_id: str, screenshot_id: str
) -> dict[str, Any] | None:
    """构造轻量 ToolMessage artifact；只存 ID/ref，避免 base64 进入 checkpoint。"""
    record = await get_screenshot(session_id, screenshot_id)
    if record is None:
        return None
    return {
        "screenshot": {
            "id": record.id,
            "ref": record.ref(),
        }
    }


async def load_screenshot_data_url(
    session_id: str,
    screenshot_id: str,
) -> str | None:
    """仅在视觉模型即将调用时读图并转 data URL，不写入图状态/checkpoint。"""
    record = await get_screenshot(session_id, screenshot_id)
    if record is None:
        return None
    try:
        raw = await asyncio.to_thread(record.file_path.read_bytes)
    except OSError:
        return None
    # 防止存储目录被外部篡改后把超大/伪格式文件送给模型。
    if (
        not raw
        or len(raw) > MAX_SCREENSHOT_BYTES
        or not _matches_image_signature(raw, record.mime)
    ):
        return None
    data = base64.b64encode(raw).decode("ascii")
    return f"data:{record.mime};base64,{data}"


def _remove_session_screenshots(session_id: str) -> None:
    """同步删除精确会话目录；拒绝根目录/父目录等宽泛目标。"""
    session_dir = _safe_session_dir(session_id)
    if not session_dir.exists():
        return
    if session_dir.is_symlink():
        # 目录由服务端创建，出现符号链接说明存储被外部篡改；绝不顺着链接递归删除。
        raise RuntimeError("截图会话目录不能是符号链接")
    shutil.rmtree(session_dir)


async def remove_session_screenshots(session_id: str) -> None:
    """会话删除后的文件清理入口。"""
    await asyncio.to_thread(_remove_session_screenshots, session_id)
