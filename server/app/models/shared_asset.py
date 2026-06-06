"""SharedAsset 数据模型：一个会话「分享出去的构建产物」（dist 静态文件）。

和 files 表的区别：
  - files       = 项目源码（可编辑、给 WebContainer 跑 dev）
  - shared_assets = 分享者在自己浏览器里 `vite build` 出来的成品 dist
                    （只读、给访客当静态站点直接渲染，秒开）

每次「分享」会先清空该会话旧的 shared_assets，再写入这次构建的全部 dist 文件。
公开访问时按 session.share_token 找到会话，再按 path 取这里的文件发出去。
"""

from pydantic import BaseModel
from sqlalchemy import Boolean, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


# ── ORM Model ──────────────────────────────────────────────────────────────────

class SharedAsset(Base):
    __tablename__ = "shared_assets"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)

    # 归属会话；index 方便按会话批量查/删
    session_id: Mapped[str] = mapped_column(
        String, ForeignKey("sessions.id"), index=True, nullable=False
    )

    # dist 里的相对路径，如 "index.html" / "assets/index-xxx.js"
    path: Mapped[str] = mapped_column(String, nullable=False)

    # 文件内容。文本文件直接存原文；二进制文件（图片/字体等）存 base64，由 is_base64 标记
    content: Mapped[str] = mapped_column(Text, nullable=False)

    # 是否是 base64 编码的二进制内容。发出去时若为 True 则先解码回 bytes
    is_base64: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # 同一会话下 path 唯一
    __table_args__ = (UniqueConstraint("session_id", "path", name="uq_shared_session_path"),)


# ── Pydantic Schemas ───────────────────────────────────────────────────────────

class ShareAssetIn(BaseModel):
    """上传构建产物时的单个文件。"""
    path: str
    content: str
    is_base64: bool = False


class ShareBuildUpload(BaseModel):
    """PUT /api/sessions/{id}/share 的请求体：整个 dist 的文件列表。"""
    files: list[ShareAssetIn]
