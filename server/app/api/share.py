"""Share API —— 会话分享（分享「构建产物」，访客秒开）。

整体思路（为什么这么设计见和用户的讨论）：
  分享者在自己浏览器的 WebContainer 里 `vite build` 出 dist，上传给后端存起来；
  访客打开分享链接时，后端把 dist 当**静态站点**直接发出去 —— 访客不碰 WebContainer，
  不装依赖、不构建，纯静态秒渲染。2c2g 服务器只干「发静态文件」这种最轻的活。

接口分两类：
  1. 主人操作（需登录 + 归属校验）：
       PUT    /api/sessions/{session_id}/share   上传 dist，开启/更新分享
       DELETE /api/sessions/{session_id}/share   撤销分享（删 token + dist）
  2. 公开访问（无需登录，「链接即权限」）：
       GET    /shared/{token}                     访客入口（重定向到带斜杠的根）
       GET    /shared/{token}/{path}              静态发出 dist 里的文件
"""

import base64
import mimetypes
import secrets

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse, Response
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_owned_session
from app.models.session import Session, ShareInfo
from app.models.shared_asset import ShareBuildUpload, SharedAsset

router = APIRouter(tags=["share"])


# ── 主人操作：上传构建产物 / 撤销 ─────────────────────────────────

@router.put("/api/sessions/{session_id}/share", response_model=ShareInfo)
async def upload_share_build(
    body: ShareBuildUpload,
    session: Session = Depends(get_owned_session),  # 守卫确保是「当前用户的会话」
    db: AsyncSession = Depends(get_db),
) -> ShareInfo:
    """上传 dist 并开启分享（幂等：重复分享会用新构建覆盖旧的，token 不变）。

    步骤：
      1. 没 token 就生成一个不可猜的（已有则复用，旧链接继续有效）。
      2. 清空该会话旧的 shared_assets（删干净再写，避免残留上次构建多余的文件）。
      3. 写入这次上传的全部 dist 文件。
    """
    if not body.files:
        raise HTTPException(status_code=400, detail="构建产物为空，无法分享")

    # 1. 确保有分享 token
    if not session.share_token:
        session.share_token = secrets.token_urlsafe(16)

    # 2. 清空旧构建
    await db.execute(delete(SharedAsset).where(SharedAsset.session_id == session.id))

    # 3. 写入新构建
    db.add_all([
        SharedAsset(
            session_id=session.id,
            path=f.path,
            content=f.content,
            is_base64=f.is_base64,
        )
        for f in body.files
    ])
    await db.commit()
    await db.refresh(session)
    return ShareInfo(share_token=session.share_token)


@router.delete("/api/sessions/{session_id}/share", status_code=204)
async def revoke_share(
    session: Session = Depends(get_owned_session),
    db: AsyncSession = Depends(get_db),
) -> None:
    """撤销分享：清掉 token + 删除构建产物。之前发出去的链接立即失效。"""
    session.share_token = None
    await db.execute(delete(SharedAsset).where(SharedAsset.session_id == session.id))
    await db.commit()


# ── 公开访问：把 dist 当静态站点发出去 ────────────────────────────

async def _session_by_token(token: str, db: AsyncSession) -> Session:
    """按分享 token 反查会话，查不到（无效/已撤销）统一 404。"""
    result = await db.execute(select(Session).where(Session.share_token == token))
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="分享不存在或已取消")
    return session


@router.get("/shared/{token}")
async def shared_root_redirect(token: str) -> RedirectResponse:
    """访客入口：补上结尾斜杠。

    为什么必须带斜杠？dist 用 `--base=./` 构建，index.html 里资源是相对路径
    （如 ./assets/x.js）。浏览器按「当前文档 URL」解析相对路径：
      /shared/abc      → 相对基准是 /shared/  → 资源解析成 /shared/assets/x.js（错）
      /shared/abc/     → 相对基准是 /shared/abc/ → 解析成 /shared/abc/assets/x.js（对）
    所以统一重定向到带斜杠的版本。
    """
    return RedirectResponse(url=f"/shared/{token}/")


@router.get("/shared/{token}/{path:path}")
async def serve_shared_file(
    token: str,
    path: str,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """静态发出 dist 里的某个文件。

    - path 为空（即 /shared/{token}/）→ 返回 index.html
    - 找不到该文件，但 path 看起来像前端路由（无扩展名）→ 回退到 index.html（SPA fallback）
    - 否则 404
    无登录守卫：这是公开通道，安全靠「token 不可猜 + 只读」。
    """
    session = await _session_by_token(token, db)

    # 空路径表示访问站点根，对应 index.html
    target = path or "index.html"

    asset = await _get_asset(db, session.id, target)
    if asset is None:
        # SPA 前端路由（路径里最后一段没有扩展名）回退到 index.html
        last = target.rsplit("/", 1)[-1]
        if "." not in last:
            asset = await _get_asset(db, session.id, "index.html")
        if asset is None:
            raise HTTPException(status_code=404, detail="文件不存在")

    # 按文件名猜 Content-Type（.js/.css/.html/.svg/.png...），猜不出按二进制流
    media_type = mimetypes.guess_type(asset.path)[0] or "application/octet-stream"

    # base64 的二进制内容先解码回 bytes；文本内容直接发字符串
    content: bytes | str = base64.b64decode(asset.content) if asset.is_base64 else asset.content
    return Response(content=content, media_type=media_type)


async def _get_asset(db: AsyncSession, session_id: str, path: str) -> SharedAsset | None:
    result = await db.execute(
        select(SharedAsset).where(
            SharedAsset.session_id == session_id,
            SharedAsset.path == path,
        )
    )
    return result.scalar_one_or_none()
