"""Versions API —— 版本列表 + 回滚。

挂在 /api/sessions/{session_id}/versions 下。
版本模型：单线递增、整快照、回滚即新版（详见 app/models/version.py）。
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models.file import File, FileRead
from app.models.version import Version, VersionFile, VersionRead
from app.versioning import snapshot_current_files

router = APIRouter(prefix="/api/sessions/{session_id}/versions", tags=["versions"])


@router.get("", response_model=list[VersionRead])
async def list_versions(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> list[VersionRead]:
    """列出某会话的所有版本，最新的在前（按 seq 倒序）。不含文件内容，列表用不上。"""
    result = await db.execute(
        select(Version)
        .where(Version.session_id == session_id)
        .order_by(Version.seq.desc())
    )
    return [VersionRead.model_validate(v) for v in result.scalars().all()]


@router.post("/{version_id}/restore", response_model=list[FileRead])
async def restore_version(
    session_id: str,
    version_id: int,
    db: AsyncSession = Depends(get_db),
) -> list[FileRead]:
    """回滚到指定版本：用该版本的快照覆盖当前 files，再把结果存成一个新版本。

    “回滚即新版”：回滚到 v3（当前在 v7）不删 v4~v7，而是 append 一个 v8，内容等于 v3。
    这样版本线永远单向递增、当前态永远是 tip。
    """
    # 1. 校验版本存在且属于该会话（防止跨会话回滚别人的版本）
    result = await db.execute(
        select(Version).where(Version.id == version_id, Version.session_id == session_id)
    )
    version = result.scalar_one_or_none()
    if version is None:
        raise HTTPException(status_code=404, detail="版本不存在")

    # 2. 取出该版本的所有文件快照
    result = await db.execute(
        select(VersionFile).where(VersionFile.version_id == version_id)
    )
    snapshot_files = result.scalars().all()

    # 3. 用快照覆盖当前 files：先清空会话现有文件，再写入快照内容。
    #    清空 + 重建放进一个事务：要么一起成功要么一起回滚，
    #    不会出现「删了旧的、新的没写进去」把项目搞空的中间态。
    await db.execute(delete(File).where(File.session_id == session_id))
    db.add_all([
        File(session_id=session_id, path=f.path, content=f.content)
        for f in snapshot_files
    ])
    await db.commit()

    # 4. 回滚即新版：把刚覆盖好的当前态再快照成新版本（复用 snapshot_current_files）
    await snapshot_current_files(db, session_id, summary=f"回滚到 v{version.seq}")

    # 5. 返回新的当前文件，前端据此重挂 WebContainer
    result = await db.execute(
        select(File).where(File.session_id == session_id).order_by(File.path)
    )
    return [FileRead.model_validate(f) for f in result.scalars().all()]
