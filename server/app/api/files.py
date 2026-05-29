"""Files API —— session 下文件的 CRUD。

路由全部挂在 /api/sessions/{session_id}/files 下，
{path:path} 写法允许路径参数包含斜杠（如 src/App.tsx）。
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models.file import File, FileRead, FileWrite

router = APIRouter(prefix="/api/sessions/{session_id}/files", tags=["files"])


async def _get_or_404(session_id: str, path: str, db: AsyncSession) -> File:
    """按 session_id + path 查文件，不存在则 404。"""
    result = await db.execute(
        select(File).where(File.session_id == session_id, File.path == path)
    )
    file = result.scalar_one_or_none()
    if file is None:
        raise HTTPException(status_code=404, detail=f"文件不存在: {path}")
    return file


@router.get("", response_model=list[FileRead])
async def list_files(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> list[FileRead]:
    """列出 session 下所有文件（只返回路径列表，不含 content，减少传输量）。"""
    result = await db.execute(
        select(File).where(File.session_id == session_id).order_by(File.path)
    )
    return [FileRead.model_validate(f) for f in result.scalars().all()]


@router.get("/{path:path}", response_model=FileRead)
async def read_file(
    session_id: str,
    path: str,
    db: AsyncSession = Depends(get_db),
) -> FileRead:
    """读取单个文件内容。"""
    file = await _get_or_404(session_id, path, db)
    return FileRead.model_validate(file)


@router.put("/{path:path}", response_model=FileRead)
async def write_file(
    session_id: str,
    path: str,
    body: FileWrite,
    db: AsyncSession = Depends(get_db),
) -> FileRead:
    """新建或覆盖文件（upsert）。

    用 SQLite 的 INSERT OR REPLACE 语义：
      - path 不存在 → INSERT
      - path 已存在 → UPDATE content + updated_at
    这样调用方不需要区分新建还是修改，统一用 PUT 即可。
    """
    stmt = (
        sqlite_insert(File)
        .values(session_id=session_id, path=path, content=body.content)
        .on_conflict_do_update(
            index_elements=["session_id", "path"],  # 冲突条件：同 session + 同 path
            set_={"content": body.content},         # 冲突时只更新 content
        )
    )
    await db.execute(stmt)
    await db.commit()
    return FileRead.model_validate(await _get_or_404(session_id, path, db))


@router.delete("/{path:path}", status_code=204)
async def delete_file(
    session_id: str,
    path: str,
    db: AsyncSession = Depends(get_db),
) -> None:
    """删除文件，不存在则 404。"""
    file = await _get_or_404(session_id, path, db)
    await db.delete(file)
    await db.commit()
