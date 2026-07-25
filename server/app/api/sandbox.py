"""后端预览沙箱 API。

主 API 只负责鉴权、限流边界和转发；真正的 Vite 构建在独立 sandbox-worker 中完成。
公网 Web 进程不接触 Docker Socket，也不直接执行用户项目。
"""

from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.config import settings
from app.deps import get_owned_session


router = APIRouter(tags=["sandbox"])


class SandboxBuildRequest(BaseModel):
    files: dict[str, str]
    device: Literal["desktop", "mobile"] = "desktop"


class SandboxBuildRead(BaseModel):
    ok: bool
    build_id: str | None = None
    preview_url: str | None = None
    logs: str = ""
    errors: str = ""


@router.post(
    "/api/sessions/{session_id}/sandbox-build",
    response_model=SandboxBuildRead,
    dependencies=[Depends(get_owned_session)],
)
async def build_sandbox_preview(
    session_id: str,
    body: SandboxBuildRequest,
) -> SandboxBuildRead:
    """把当前浏览器暂存的完整文件集交给 Worker。

    不能改为“后端自己读数据库”：同批并行工具调用时，前端通过既有 early_file_write
    已经拿到了本轮完整文件，而数据库写工具可能尚未全部提交。继续以前端完整快照为准，
    可保留现有 check_build 的时序正确性。
    """
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
        return SandboxBuildRead.model_validate(response.json())
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="沙箱 Worker 返回格式无效") from exc
