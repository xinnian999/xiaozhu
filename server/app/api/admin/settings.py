"""管理后台 —— 应用配置（对齐 admin.py 的 AppSettingAdmin）。

配置项由首次启动种子建好（见 runtime_config.SETTING_DEFS），后台只改「值」，
不增删、不改 key/分类/说明。敏感项（is_secret）在列表/详情脱敏显示。
改完调 runtime_config.refresh() 让 cfg.* 立刻读到新值，不用重启。
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import runtime_config
from app.db import get_db
from app.models.app_setting import AppSetting, AppSettingAdminRead, AppSettingAdminUpdate

from ._utils import mask_secret

router = APIRouter(prefix="/settings", tags=["admin-settings"])


def _to_read(setting: AppSetting) -> AppSettingAdminRead:
    value = mask_secret(setting.value) if setting.is_secret else setting.value
    return AppSettingAdminRead(
        key=setting.key,
        value=value,
        category=setting.category,
        is_secret=setting.is_secret,
        description=setting.description,
    )


@router.get("", response_model=list[AppSettingAdminRead])
async def list_settings(db: AsyncSession = Depends(get_db)) -> list[AppSettingAdminRead]:
    """全量列出配置项，按分类排列展示（数量不大，不分页）。"""
    result = await db.execute(select(AppSetting).order_by(AppSetting.category, AppSetting.key))
    return [_to_read(s) for s in result.scalars().all()]


@router.patch("/{key}", response_model=AppSettingAdminRead)
async def update_setting(
    key: str,
    body: AppSettingAdminUpdate,
    db: AsyncSession = Depends(get_db),
) -> AppSettingAdminRead:
    """改某一项配置的值，提交后立即刷新内存缓存。"""
    setting = await db.get(AppSetting, key)
    if setting is None:
        raise HTTPException(status_code=404, detail="配置项不存在")
    setting.value = body.value
    await db.commit()
    await db.refresh(setting)
    await runtime_config.refresh()
    return _to_read(setting)
