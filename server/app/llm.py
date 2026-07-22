"""LLM 模型注册表 + 构造 —— 以数据库为真相源，内存缓存为读取层。

模型搬进数据库（单张 llm_models 表，每个模型自带 base_url + api_key），
可在管理后台运行时增删改。本文件职责：
  1. 启动时 reload_registry() 把表读进内存缓存（_MODELS_BY_ID / _ORDERED_IDS）。
  2. 对外提供 allowed_model_ids() / default_model_id() / public_models() / build_llm()，
     都查内存缓存，不每条请求打库。
  3. 后台改了模型后调 reload_registry() 刷新缓存即时生效。
  4. 首次部署用 SEED_MODELS + .env 里的 API_KEY_* / OPENAI_BASE_URL 把库灌好（ensure_seeded）。
"""

from fastapi import HTTPException
from langchain_core.language_models import BaseChatModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.model_providers import (
    build_chat_model,
    canonical_model_values,
    infer_provider,
    provider_logo,
)
from app.models.llm_config import LlmModel


# ── 种子数据（仅首次建库用）────────────────────────────────────────────────────
# 原来写死在代码里的模型清单，现在只当「初始数据」：库为空时灌进去一次。
# vision / cost 都是实测标定过的值（见 scripts/check_vision.py 与 billing.py），别凭记忆改。
# _env_key 仅用于首次播种时去 .env 的 API_KEY_* 取对应 key，不入库、不是模型字段。
SEED_MODELS = [
    {
        "id": "qwen3-coder-next",
        "vision": False,
        "cost": 1,
        "_env_key": "qwen",
    },
    {"id": "qwen3.6-plus", "vision": True, "cost": 1, "_env_key": "qwen"},
    {"id": "gpt-5.5", "vision": False, "cost": 2, "_env_key": "gpt"},
]


# ── 内存缓存（注册表）──────────────────────────────────────────────────────────
# 由 reload_registry() 从数据库填充。业务代码只读这两个结构。
# _MODELS_BY_ID: 模型 id → {全部字段}
# _ORDERED_IDS:  按 sort_order 排好序的「已启用」模型 id 列表（默认模型 / 清单顺序用）。
_MODELS_BY_ID: dict[str, dict] = {}
_ORDERED_IDS: list[str] = []


async def reload_registry(session: AsyncSession) -> None:
    """从数据库重建内存缓存。启动时与后台改动后调用。"""
    global _MODELS_BY_ID, _ORDERED_IDS

    models = (
        (await session.execute(select(LlmModel).order_by(LlmModel.sort_order)))
        .scalars()
        .all()
    )
    _MODELS_BY_ID = {
        m.id: {
            "id": m.id,
            "provider": m.provider,
            "base_url": m.base_url,
            "api_key": m.api_key,
            "logo": provider_logo(m.provider),
            "vision": m.vision,
            "cost": m.cost,
            "enabled": m.enabled,
            "sort_order": m.sort_order,
        }
        for m in models
    }
    # 只有「启用」的模型能被选择 / 当默认；已按 sort_order 取出，这里保持顺序过滤即可。
    _ORDERED_IDS = [m.id for m in models if m.enabled]


# ── 对外读取接口（都查内存缓存）────────────────────────────────────────────────
def models_by_id() -> dict[str, dict]:
    """模型 id → 元信息（含已禁用的）。供 chat/loop 查 cost / vision。"""
    return _MODELS_BY_ID


def allowed_model_ids() -> set[str]:
    """允许被前端选择 / 调用的模型 id 集合 —— 只含「已启用」的。"""
    return set(_ORDERED_IDS)


def default_model_id() -> str:
    """默认模型：已启用模型里 sort_order 最靠前的那个。一个都没有时返回空串
    （chat 的白名单校验会据此返回明确的 400，而不是神秘失败）。"""
    return _ORDERED_IDS[0] if _ORDERED_IDS else ""


def public_models() -> list[dict]:
    """给前端的模型清单。只吐已启用模型的 id / label / icon / vision / cost ——
    故意不含 api_key（密钥，绝不外吐）。
    字段名沿用前端约定：label=id、icon=logo。
    """
    result = []
    for mid in _ORDERED_IDS:
        m = _MODELS_BY_ID[mid]
        result.append(
            {
                "id": m["id"],
                "label": m["id"],
                "icon": m["logo"],
                "vision": m["vision"],
                "cost": m["cost"],
            }
        )
    return result


def build_llm(model: str, *, thinking: bool | None = None) -> BaseChatModel:
    """按模型名构造 LLM 实例。model 必须已通过白名单校验。

    api_key / base_url 都取自该模型自己的字段。base_url 为空则走官方地址。
    """
    meta = _MODELS_BY_ID.get(model)
    if meta is None:
        raise HTTPException(status_code=400, detail=f"未知模型：{model}")
    api_key = meta.get("api_key")
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail=f"模型 {model} 未配置 api_key，请在管理后台设置。",
        )
    return build_chat_model(meta, thinking=thinking)


async def ensure_seeded(session: AsyncSession) -> None:
    """老部署迁移用：把 .env 里的模型 key 灌进库。仅当 .env 还配着 API_KEY_* 时才做。

    - 老部署（.env 还有 API_KEY_QWEN 等）：首次启动把 SEED_MODELS 连同对应 key 迁进库，
      行为和「配置搬库」之前完全一致，无缝过渡。
    - 全新部署（.env 已精简到只剩 JWT_SECRET，没有任何 API_KEY_*）：**不预建任何模型**，
      让模型完全由「系统初始化向导」手动创建 —— 否则会残留一堆空 key 的坏模型。
    幂等：表里已有模型就不动（不覆盖后台 / 向导的改动）。
    """
    has_model = (
        await session.execute(select(LlmModel.id).limit(1))
    ).first() is not None
    if has_model:
        return

    env_keys = settings.api_keys  # {分组名: api_key}，从 .env 的 API_KEY_* 扫出来
    # 全新部署没有任何 env key → 不 seed，交给初始化向导手填
    if not env_keys:
        return

    base_url = settings.openai_base_url  # 老配置是全局中转；只按官方域名识别厂商。
    provider = infer_provider(base_url)
    provider, logo, base_url = canonical_model_values(provider, base_url)

    for i, m in enumerate(SEED_MODELS):
        session.add(
            LlmModel(
                id=m["id"],
                provider=provider,
                base_url=base_url,
                api_key=env_keys.get(m["_env_key"], ""),
                logo=logo,
                vision=m["vision"],
                cost=m["cost"],
                enabled=True,
                sort_order=i,
            )
        )
    await session.commit()


async def refresh() -> None:
    """后台改完模型后刷新缓存。自己开 session。"""
    from app.db import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        await reload_registry(session)
