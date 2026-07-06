"""管理后台 —— 邮箱验证码查看（对齐 admin.py 的 EmailCodeAdmin：只读 + 可删，排障用）。

验证码由发码流程写，后台只看/删，不允许编辑。
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models.email_code import EmailCode, EmailCodeAdminRead

router = APIRouter(prefix="/email-codes", tags=["admin-email-codes"])


@router.get("", response_model=list[EmailCodeAdminRead])
async def list_email_codes(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> list[EmailCode]:
    stmt = select(EmailCode).order_by(EmailCode.sent_at.desc()).offset(offset).limit(limit)
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.get("/count", response_model=int)
async def count_email_codes(db: AsyncSession = Depends(get_db)) -> int:
    result = await db.execute(select(func.count()).select_from(EmailCode))
    return result.scalar_one()


@router.delete("/{email}", status_code=204)
async def delete_email_code(email: str, db: AsyncSession = Depends(get_db)) -> Response:
    rec = await db.get(EmailCode, email)
    if rec is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    await db.delete(rec)
    await db.commit()
    return Response(status_code=204)
