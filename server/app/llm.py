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
from langchain_openai import ChatOpenAI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.llm_config import LlmModel


# ── 种子数据（仅首次建库用）────────────────────────────────────────────────────
# 原来写死在代码里的模型清单，现在只当「初始数据」：库为空时灌进去一次。
# vision / cost 都是实测标定过的值（见 scripts/check_vision.py 与 billing.py），别凭记忆改。
# _env_key 仅用于首次播种时去 .env 的 API_KEY_* 取对应 key，不入库、不是模型字段。
SEED_MODELS = [
    {"id": "qwen3-coder-next", "name": "Qwen3 Coder Next", "logo": "Qwen.Color", "vision": False, "cost": 1, "_env_key": "qwen"},
    {"id": "qwen3.6-plus", "name": "Qwen3.6 Plus", "logo": "Qwen.Color", "vision": True, "cost": 1, "_env_key": "qwen"},
    {"id": "gpt-5.5", "name": "GPT-5.5", "logo": "OpenAI", "vision": False, "cost": 2, "_env_key": "gpt"},
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
        await session.execute(select(LlmModel).order_by(LlmModel.sort_order))
    ).scalars().all()
    _MODELS_BY_ID = {
        m.id: {
            "id": m.id,
            "name": m.name,
            "base_url": m.base_url,
            "api_key": m.api_key,
            "logo": m.logo,
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
    字段名沿用前端约定：label=name、icon=logo。
    """
    result = []
    for mid in _ORDERED_IDS:
        m = _MODELS_BY_ID[mid]
        result.append(
            {
                "id": m["id"],
                "label": m["name"],
                "icon": m["logo"],
                "vision": m["vision"],
                "cost": m["cost"],
            }
        )
    return result


def build_llm(model: str) -> ChatOpenAI:
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
    return ChatOpenAI(
        model=model,
        api_key=api_key,
        base_url=meta.get("base_url") or None,
        # 一次 write_file 要塞下整个文件内容，4096 太小，写稍大的页面就会被截断。先给到 16384。
        max_tokens=16384,
        # 全局关闭 qwen 系的「思考」开关：开着既慢又看不到思维链（中转只回计数），得不偿失。
        # 经 extra_body 透传，不认识它的模型（gpt 系）会忽略，无副作用。
        extra_body={"enable_thinking": False},
    )


async def ensure_seeded(session: AsyncSession) -> None:
    """首次建库把模型灌进去。幂等：表里已有数据就不动（不覆盖后台改动）。

    api_key 取自 .env 的 API_KEY_*（settings.api_keys），base_url 取 .env 的 OPENAI_BASE_URL。
    这样老 .env 部署第一次启动后，模型与 key 自动迁进库，行为和以前完全一致。
    """
    has_model = (await session.execute(select(LlmModel.id).limit(1))).first() is not None
    if has_model:
        return

    env_keys = settings.api_keys  # {分组名: api_key}，从 .env 的 API_KEY_* 扫出来
    base_url = settings.openai_base_url  # 全局中转地址，作为每个模型 base_url 的初始值

    for i, m in enumerate(SEED_MODELS):
        session.add(
            LlmModel(
                id=m["id"],
                name=m["name"],
                base_url=base_url,
                api_key=env_keys.get(m["_env_key"], ""),
                logo=m["logo"],
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
