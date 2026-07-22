"""管理后台 —— LLM 模型管理（对齐 admin.py 的 LlmModelAdmin：增删改 + 启停批量）。

api_key 在列表/详情响应里脱敏（编辑时前端仍可传明文新值覆盖）。
增删改后都要调 llm.refresh() 刷新内存注册表，让 /api/models 与真正的模型调用立即生效。
"""

import asyncio
import base64
import struct
import time
import zlib
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
    LlmModelCapabilityTestDetail,
    LlmModelExportBundle,
    LlmModelExportItem,
    LlmModelImportRequest,
    LlmModelImportResult,
    LlmModelCapabilityTestResult,
    LlmModelTestResult,
    ModelTestCapability,
    ModelTestStatus,
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


def _solid_png_data_url(red: int, green: int, blue: int) -> str:
    """用标准库生成 32×32 纯色 PNG，避免为识图探测引入图片依赖。"""
    width = height = 32
    raw = b"".join(b"\x00" + bytes((red, green, blue)) * width for _ in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    return "data:image/png;base64," + base64.b64encode(png).decode()


def _reasoning_tokens(resp: object) -> int:
    """兼容不同中转/LangChain 版本，提取可观察到的推理 token 数。"""
    response_metadata = getattr(resp, "response_metadata", {}) or {}
    usage_metadata = getattr(resp, "usage_metadata", {}) or {}
    candidates = [
        response_metadata.get("token_usage", {}),
        response_metadata.get("usage", {}),
        usage_metadata,
    ]
    for usage in candidates:
        if not isinstance(usage, dict):
            continue
        details = (
            usage.get("completion_tokens_details")
            or usage.get("output_token_details")
            or {}
        )
        if isinstance(details, dict):
            value = details.get("reasoning_tokens") or details.get("reasoning")
            if isinstance(value, int):
                return value
    return 0


def _has_reasoning_signal(resp: object) -> bool:
    additional = getattr(resp, "additional_kwargs", {}) or {}
    if isinstance(additional, dict):
        for key in ("reasoning_content", "reasoning", "reasoning_details"):
            if additional.get(key):
                return True
    return _reasoning_tokens(resp) > 0


def _reasoning_content(resp: object) -> str:
    """只读取中转明确返回的 reasoning_content，不用 token 数推测正文。"""
    additional = getattr(resp, "additional_kwargs", {}) or {}
    if not isinstance(additional, dict):
        return ""
    content = additional.get("reasoning_content")
    return _message_text(content) if content else ""


async def _invoke_with_timeout(
    llm_instance: object, messages: list[HumanMessage], **kwargs: object
):
    return await asyncio.wait_for(
        llm_instance.ainvoke(messages, **kwargs),  # type: ignore[attr-defined]
        timeout=_TEST_TIMEOUT_SEC,
    )


def _capability_result(
    capability: ModelTestCapability,
    status: ModelTestStatus,
    message: str,
    started: float,
    details: list[LlmModelCapabilityTestDetail] | None = None,
) -> LlmModelCapabilityTestResult:
    return LlmModelCapabilityTestResult(
        capability=capability,
        status=status,
        message=message,
        latency_ms=int((time.perf_counter() - started) * 1000),
        details=details or [],
    )


@router.get("", response_model=list[LlmModelAdminRead])
async def list_models(db: AsyncSession = Depends(get_db)) -> list[LlmModelAdminRead]:
    """全量列出模型，按排序权重展示（对齐前端清单的排序习惯）。"""
    result = await db.execute(select(LlmModel).order_by(LlmModel.sort_order))
    return [_to_read(m) for m in result.scalars().all()]


@router.get("/export", response_model=LlmModelExportBundle)
async def export_models(db: AsyncSession = Depends(get_db)) -> LlmModelExportBundle:
    """导出全部模型配置（含明文 api_key），用于跨环境迁移。"""
    result = await db.execute(select(LlmModel).order_by(LlmModel.sort_order))
    models = [LlmModelExportItem.model_validate(m) for m in result.scalars().all()]
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
async def test_model(
    model_id: str, db: AsyncSession = Depends(get_db)
) -> LlmModelTestResult:
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
            llm_instance.ainvoke(
                [
                    HumanMessage(
                        content='Reply with exactly the word "ok" without any other text.'
                    ),
                ]
            ),
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


@router.post(
    "/{model_id}/test/{capability}",
    response_model=LlmModelCapabilityTestResult,
)
async def test_model_capability(
    model_id: str,
    capability: ModelTestCapability,
    db: AsyncSession = Depends(get_db),
) -> LlmModelCapabilityTestResult:
    """独立探测一项模型能力，供“全面测试”弹窗逐项执行并实时展示。"""
    model = await db.get(LlmModel, model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="模型不存在")
    if not model.api_key:
        return LlmModelCapabilityTestResult(
            capability=capability,
            status="failed",
            message="未配置 API Key",
        )

    try:
        llm_instance = llm.build_llm(model_id)
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        return LlmModelCapabilityTestResult(
            capability=capability,
            status="failed",
            message=detail,
        )

    started = time.perf_counter()
    try:
        if capability == "connectivity":
            resp = await _invoke_with_timeout(
                llm_instance,
                [
                    HumanMessage(
                        content='Reply with exactly the word "ok" without any other text.'
                    )
                ],
            )
            preview = _message_text(resp.content)
            preview = preview[:60] + ("…" if len(preview) > 60 else "")
            return _capability_result(
                capability,
                "passed",
                f"连接成功，模型已响应：{preview or '空回复'}",
                started,
            )

        if capability == "vision":
            resp = await _invoke_with_timeout(
                llm_instance,
                [
                    HumanMessage(
                        content=[
                            {
                                "type": "text",
                                "text": "这张纯色图片是什么颜色？只回答颜色名称。",
                            },
                            {
                                "type": "image_url",
                                "image_url": {"url": _solid_png_data_url(230, 35, 45)},
                            },
                        ]
                    )
                ],
            )
            answer = _message_text(resp.content)
            if "红" in answer or "red" in answer.lower():
                return _capability_result(
                    capability,
                    "passed",
                    f"正确识别红色测试图（{answer[:50]}）",
                    started,
                )
            return _capability_result(
                capability,
                "unsupported",
                f"图片请求已返回，但未正确识别红色测试图（{answer[:60] or '空回复'}）",
                started,
            )

        if capability == "thinking":
            resp = await _invoke_with_timeout(
                llm_instance,
                [HumanMessage(content="请认真计算 137 × 29，只回答最终数字。")],
                extra_body={"enable_thinking": True},
            )
            tokens = _reasoning_tokens(resp)
            content = _reasoning_content(resp)
            has_reasoning = _has_reasoning_signal(resp)
            details = [
                LlmModelCapabilityTestDetail(
                    key="thinking",
                    label="思考信号",
                    status="passed" if has_reasoning else "unsupported",
                    message=(
                        f"检测到 {tokens} 个推理 token"
                        if tokens
                        else "检测到模型返回的推理信号"
                        if has_reasoning
                        else "未检测到推理内容或推理 token"
                    ),
                ),
                LlmModelCapabilityTestDetail(
                    key="reasoning_content",
                    label="推理内容",
                    status="passed" if content else "unsupported",
                    message=(
                        f"返回 {len(content)} 个字符"
                        if content
                        else "未返回 reasoning_content 文本"
                    ),
                ),
            ]

            if not has_reasoning:
                details.append(
                    LlmModelCapabilityTestDetail(
                        key="disable_thinking",
                        label="关闭思考",
                        status="unsupported",
                        message="未先检测到思考，无法验证关闭开关",
                    )
                )
                return _capability_result(
                    capability,
                    "unsupported",
                    "未检测到模型思考能力",
                    started,
                    details,
                )

            try:
                disabled_resp = await _invoke_with_timeout(
                    llm_instance,
                    [HumanMessage(content="请计算 137 × 29，只回答最终数字。")],
                    extra_body={"enable_thinking": False},
                )
                can_disable = not _has_reasoning_signal(disabled_resp)
                details.append(
                    LlmModelCapabilityTestDetail(
                        key="disable_thinking",
                        label="关闭思考",
                        status="passed" if can_disable else "failed",
                        message=(
                            "关闭后推理信号已消失"
                            if can_disable
                            else "关闭后仍检测到推理信号，开关可能被忽略"
                        ),
                    )
                )
            except TimeoutError:
                can_disable = False
                details.append(
                    LlmModelCapabilityTestDetail(
                        key="disable_thinking",
                        label="关闭思考",
                        status="failed",
                        message=f"关闭验证超时（>{_TEST_TIMEOUT_SEC}s）",
                    )
                )
            except Exception as exc:
                can_disable = False
                details.append(
                    LlmModelCapabilityTestDetail(
                        key="disable_thinking",
                        label="关闭思考",
                        status="failed",
                        message=f"{type(exc).__name__}: {str(exc)[:120]}",
                    )
                )

            status: ModelTestStatus = (
                "failed" if not can_disable else "passed" if content else "unsupported"
            )
            return _capability_result(
                capability,
                status,
                "已完成思考能力组合测试",
                started,
                details,
            )

        tool_schema = {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "查询指定城市当前天气",
                "parameters": {
                    "type": "object",
                    "properties": {"city": {"type": "string", "description": "城市名"}},
                    "required": ["city"],
                },
            },
        }
        tool_llm = llm_instance.bind_tools([tool_schema], tool_choice="required")
        resp = await _invoke_with_timeout(
            tool_llm,
            [HumanMessage(content="请调用工具查询北京天气，不要直接回答。")],
        )
        tool_calls = getattr(resp, "tool_calls", []) or []
        if tool_calls and tool_calls[0].get("name") == "get_weather":
            args = tool_calls[0].get("args", {})
            return _capability_result(
                capability,
                "passed",
                f"成功生成 get_weather 工具调用（参数：{args}）",
                started,
            )
        return _capability_result(
            capability,
            "unsupported",
            "请求成功，但模型没有返回规范的工具调用",
            started,
        )
    except TimeoutError:
        return _capability_result(
            capability, "failed", f"请求超时（>{_TEST_TIMEOUT_SEC}s）", started
        )
    except Exception as exc:
        return _capability_result(
            capability,
            "failed",
            f"{type(exc).__name__}: {str(exc)[:200]}",
            started,
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
        update(LlmModel)
        .where(LlmModel.id.in_(body.model_ids))
        .values(enabled=body.enabled)
    )
    await db.commit()
    await llm.refresh()
    result = await db.execute(select(LlmModel).where(LlmModel.id.in_(body.model_ids)))
    return [_to_read(m) for m in result.scalars().all()]
