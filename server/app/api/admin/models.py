"""管理后台 —— LLM 模型管理（对齐 admin.py 的 LlmModelAdmin：增删改 + 启停批量）。

api_key 在列表/详情响应里脱敏（编辑时前端仍可传明文新值覆盖）。
增删改后都要调 llm.refresh() 刷新内存注册表，让 /api/models 与真正的模型调用立即生效。
"""

import asyncio
import time
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response
from langchain_core.messages import HumanMessage
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app import llm
from app.db import get_db
from app.models.llm_config import (
    LlmModel,
    LlmModelAdminCreate,
    LlmModelAdminRead,
    LlmModelAdminUpdate,
    LlmModelExportBundle,
    LlmModelExportItem,
    LlmModelImportRequest,
    LlmModelImportResult,
    LlmModelTestResult,
    SetEnabledRequest,
)

from ._utils import mask_secret

router = APIRouter(prefix="/models", tags=["admin-models"])

# 连通性探测超时（秒）：避免中转无响应时一直挂起。
_TEST_TIMEOUT_SEC = 30


def _to_read(model: LlmModel) -> LlmModelAdminRead:
    data = LlmModelAdminRead.model_validate(model)
    data.api_key = mask_secret(model.api_key)
    return data


def _message_text(content: object) -> str:
    """把 LangChain 响应 content 归一成纯文本，便于展示探测结果。"""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return "".join(
            block.get("text", "") if isinstance(block, dict) else str(block)
            for block in content
        ).strip()
    return str(content).strip()


@router.get("", response_model=list[LlmModelAdminRead])
async def list_models(db: AsyncSession = Depends(get_db)) -> list[LlmModelAdminRead]:
    """全量列出模型，按排序权重展示（对齐前端清单的排序习惯）。"""
    result = await db.execute(select(LlmModel).order_by(LlmModel.sort_order))
    return [_to_read(m) for m in result.scalars().all()]


@router.get("/export", response_model=LlmModelExportBundle)
async def export_models(db: AsyncSession = Depends(get_db)) -> LlmModelExportBundle:
    """导出全部模型配置（含明文 api_key），用于跨环境迁移。"""
    result = await db.execute(select(LlmModel).order_by(LlmModel.sort_order))
    models = [
        LlmModelExportItem.model_validate(m) for m in result.scalars().all()
    ]
    return LlmModelExportBundle(exported_at=datetime.now(), models=models)


@router.post("/import", response_model=LlmModelImportResult)
async def import_models(
    body: LlmModelImportRequest,
    db: AsyncSession = Depends(get_db),
) -> LlmModelImportResult:
    """按 id upsert 导入模型配置：已存在则覆盖，不存在则新建。"""
    created = 0
    updated = 0
    for item in body.models:
        existing = await db.get(LlmModel, item.id)
        data = item.model_dump()
        if existing is None:
            db.add(LlmModel(**data))
            created += 1
        else:
            for field, value in data.items():
                setattr(existing, field, value)
            updated += 1
    await db.commit()
    await llm.refresh()
    return LlmModelImportResult(
        created=created,
        updated=updated,
        total=len(body.models),
    )


@router.post("", response_model=LlmModelAdminRead, status_code=201)
async def create_model(
    body: LlmModelAdminCreate,
    db: AsyncSession = Depends(get_db),
) -> LlmModelAdminRead:
    """新建模型。id 是主键，需手填（对齐 admin.py 的 form_include_pk=True）。"""
    existing = await db.get(LlmModel, body.id)
    if existing is not None:
        raise HTTPException(status_code=409, detail="该模型 ID 已存在")
    model = LlmModel(**body.model_dump())
    db.add(model)
    await db.commit()
    await db.refresh(model)
    await llm.refresh()
    return _to_read(model)


@router.patch("/{model_id}", response_model=LlmModelAdminRead)
async def update_model(
    model_id: str,
    body: LlmModelAdminUpdate,
    db: AsyncSession = Depends(get_db),
) -> LlmModelAdminRead:
    """编辑模型，字段都可选（partial update）。"""
    model = await db.get(LlmModel, model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="模型不存在")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(model, field, value)
    await db.commit()
    await db.refresh(model)
    await llm.refresh()
    return _to_read(model)


@router.post("/{model_id}/test", response_model=LlmModelTestResult)
async def test_model(model_id: str, db: AsyncSession = Depends(get_db)) -> LlmModelTestResult:
    """探测模型连通性：发一条极简对话，验证 base_url / api_key / 模型名是否可用。"""
    model = await db.get(LlmModel, model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="模型不存在")
    if not model.api_key:
        return LlmModelTestResult(ok=False, message="未配置 api_key")

    try:
        llm_instance = llm.build_llm(model_id)
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        return LlmModelTestResult(ok=False, message=detail)

    started = time.perf_counter()
    try:
        resp = await asyncio.wait_for(
            llm_instance.ainvoke([
                HumanMessage(content='Reply with exactly the word "ok" without any other text.'),
            ]),
            timeout=_TEST_TIMEOUT_SEC,
        )
        latency_ms = int((time.perf_counter() - started) * 1000)
        text = _message_text(resp.content)
        preview = text[:80] + ("..." if len(text) > 80 else "")
        return LlmModelTestResult(
            ok=True,
            message=f"连通正常，模型已响应（{preview or '空回复'}）",
            latency_ms=latency_ms,
        )
    except TimeoutError:
        return LlmModelTestResult(
            ok=False,
            message=f"请求超时（>{_TEST_TIMEOUT_SEC}s）",
        )
    except Exception as exc:
        latency_ms = int((time.perf_counter() - started) * 1000)
        return LlmModelTestResult(
            ok=False,
            message=f"{type(exc).__name__}: {str(exc)[:200]}",
            latency_ms=latency_ms,
        )


@router.delete("/{model_id}", status_code=204)
async def delete_model(model_id: str, db: AsyncSession = Depends(get_db)) -> Response:
    model = await db.get(LlmModel, model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="模型不存在")
    await db.delete(model)
    await db.commit()
    await llm.refresh()
    return Response(status_code=204)


@router.post("/set-enabled", response_model=list[LlmModelAdminRead])
async def set_enabled_batch(
    body: SetEnabledRequest,
    db: AsyncSession = Depends(get_db),
) -> list[LlmModelAdminRead]:
    """批量启用/禁用（对齐 admin.py 的 enable_selected / disable_selected 两个 action）。"""
    await db.execute(
        update(LlmModel).where(LlmModel.id.in_(body.model_ids)).values(enabled=body.enabled)
    )
    await db.commit()
    await llm.refresh()
    result = await db.execute(select(LlmModel).where(LlmModel.id.in_(body.model_ids)))
    return [_to_read(m) for m in result.scalars().all()]
