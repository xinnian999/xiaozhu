"""管理后台 —— LLM 模型管理（对齐 admin.py 的 LlmModelAdmin：增删改 + 启停批量）。

api_key 在列表/详情响应里脱敏（编辑时前端仍可传明文新值覆盖）。
增删改后都要调 llm.refresh() 刷新内存注册表，让 /api/models 与真正的模型调用立即生效。
"""

import asyncio
import base64
import struct
import time
import zlib
from dataclasses import dataclass
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response
from langchain_core.messages import HumanMessage
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app import llm
from app.db import get_db
from app.model_providers import (
    canonical_model_values,
    infer_provider,
    provider_catalog,
    provider_spec,
    supports_thinking_toggle,
    tool_choice_for_provider,
    unsupported_vision_reason,
)
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
    LlmProviderRead,
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
    spec = provider_spec(model.provider)
    data.provider = spec.id
    data.logo = spec.logo
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


@dataclass(frozen=True)
class _ReasoningObservation:
    tokens: int
    content: str
    has_signal: bool


def _reasoning_tokens(value: object) -> int:
    """兼容不同集成的 usage_metadata / response_metadata 嵌套结构。"""
    best = 0
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = key.lower().replace("-", "_")
            if normalized in {
                "reasoning_tokens",
                "reasoning_token_count",
            } and isinstance(child, int):
                best = max(best, child)
            elif normalized == "reasoning" and isinstance(child, int):
                best = max(best, child)
            else:
                best = max(best, _reasoning_tokens(child))
    elif isinstance(value, (list, tuple)):
        for child in value:
            best = max(best, _reasoning_tokens(child))
    return best


def _reasoning_observation(response: object) -> _ReasoningObservation:
    """把 reasoning_content、Anthropic thinking block 等归一成一次观测。"""
    parts: list[str] = []
    has_structured_signal = False

    def collect(value: object) -> None:
        nonlocal has_structured_signal
        if isinstance(value, str):
            if value.strip():
                parts.append(value.strip())
            return
        if isinstance(value, list):
            for item in value:
                if not isinstance(item, dict):
                    continue
                block_type = str(item.get("type", "")).lower()
                if block_type in {"thinking", "reasoning", "reasoning_content"}:
                    has_structured_signal = True
                    collect(
                        item.get("thinking")
                        or item.get("reasoning")
                        or item.get("text")
                        or item.get("content")
                    )
            return
        if isinstance(value, dict):
            has_structured_signal = bool(value) or has_structured_signal
            collect(
                value.get("reasoning_content")
                or value.get("reasoning")
                or value.get("text")
                or value.get("content")
            )

    content = getattr(response, "content", None)
    collect(content if isinstance(content, list) else [])
    additional = getattr(response, "additional_kwargs", {}) or {}
    for field in ("reasoning_content", "reasoning", "reasoning_details"):
        if value := additional.get(field):
            has_structured_signal = True
            collect(value)

    # 新版 LangChain 会把厂商内容块统一成 content_blocks；与原 content 去重即可。
    try:
        collect(getattr(response, "content_blocks", []))
    except Exception:
        pass

    usage = getattr(response, "usage_metadata", {}) or {}
    metadata = getattr(response, "response_metadata", {}) or {}
    tokens = max(_reasoning_tokens(usage), _reasoning_tokens(metadata))
    unique_parts = list(dict.fromkeys(parts))
    reasoning_content = "\n".join(unique_parts).strip()
    return _ReasoningObservation(
        tokens=tokens,
        content=reasoning_content,
        has_signal=bool(reasoning_content or has_structured_signal or tokens),
    )


async def _thinking_probe(model_id: str, *, enabled: bool) -> _ReasoningObservation:
    model = llm.build_llm(model_id, thinking=enabled)
    response = await _invoke_with_timeout(
        model,
        [HumanMessage(content="请认真计算 137 × 29，只回答最终数字。")],
    )
    return _reasoning_observation(response)


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


def _canonical_config(
    data: dict,
    *,
    provider: str | None,
    base_url: str | None,
) -> dict:
    provider_id, logo, canonical_base_url = canonical_model_values(provider, base_url)
    data["provider"] = provider_id
    data["logo"] = logo
    data["base_url"] = canonical_base_url
    return data


def _test_error_message(exc: Exception, model: LlmModel) -> str:
    """把常见厂商错误转成管理员能直接采取行动的失败原因。"""
    raw = str(exc).replace("\n", " ").strip()
    status_code = getattr(exc, "status_code", None)
    if status_code is None:
        response = getattr(exc, "response", None)
        status_code = getattr(response, "status_code", None)
    if status_code is None and (
        "error code: 401" in raw.lower() or "status code: 401" in raw.lower()
    ):
        status_code = 401

    if status_code == 401:
        spec = provider_spec(model.provider)
        base_url = model.base_url or spec.default_base_url or "厂商官方默认端点"
        if spec.id == "qwen":
            guidance = (
                "阿里云官方端点必须使用同区域的 DashScope API Key；"
                "若密钥来自中转站，请恢复对应 Base URL；"
                "中转仅兼容通用 OpenAI 协议时可选择 OpenAI 厂商。"
            )
        elif spec.id == "minimax":
            guidance = "MiniMax 中国站与国际站的 API Key 不通用，请确认 Base URL 区域。"
        elif spec.id == "openai" and model.base_url:
            guidance = "请确认该 Key 与 OpenAI 兼容 Base URL 属于同一服务。"
        else:
            guidance = "请重新填写该厂商当前区域签发的 API Key。"
        return (
            f"API Key 鉴权失败（401）：密钥与 {spec.label} 当前端点不匹配。"
            f"当前 Base URL：{base_url}。{guidance}"
        )

    if status_code == 403:
        return "鉴权成功但无权访问该模型（403），请检查模型权限、配额或区域。"
    if status_code == 429:
        return "厂商限流或额度不足（429），请检查余额与并发配额后重试。"
    return f"{type(exc).__name__}: {raw[:300]}"


@router.get("", response_model=list[LlmModelAdminRead])
async def list_models(db: AsyncSession = Depends(get_db)) -> list[LlmModelAdminRead]:
    """全量列出模型，按排序权重展示（对齐前端清单的排序习惯）。"""
    result = await db.execute(select(LlmModel).order_by(LlmModel.sort_order))
    return [_to_read(m) for m in result.scalars().all()]


@router.get("/providers", response_model=list[LlmProviderRead])
async def list_providers() -> list[LlmProviderRead]:
    """返回可选择的厂商目录；Logo 与适配器信息均由服务端维护。"""
    return [LlmProviderRead.model_validate(item) for item in provider_catalog()]


@router.get("/export", response_model=LlmModelExportBundle)
async def export_models(db: AsyncSession = Depends(get_db)) -> LlmModelExportBundle:
    """导出全部模型配置（含明文 api_key），用于跨环境迁移。"""
    result = await db.execute(select(LlmModel).order_by(LlmModel.sort_order))
    models: list[LlmModelExportItem] = []
    for model in result.scalars().all():
        item = LlmModelExportItem.model_validate(model)
        spec = provider_spec(model.provider)
        item.provider = spec.id
        item.logo = spec.logo
        models.append(item)
    return LlmModelExportBundle(version=2, exported_at=datetime.now(), models=models)


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
        # v1 导出包没有 provider：仅按官方域名迁移，不根据模型名猜厂商。
        selected_provider = (
            item.provider
            if "provider" in item.model_fields_set
            else infer_provider(item.base_url)
        )
        data = _canonical_config(
            data,
            provider=selected_provider,
            base_url=item.base_url,
        )
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
    data = body.model_dump()
    data = _canonical_config(
        data,
        provider=body.provider,
        base_url=body.base_url,
    )
    model = LlmModel(**data)
    db.add(model)
    await db.commit()
    await db.refresh(model)
    await llm.refresh()
    return _to_read(model)


@router.patch(
    "/{model_id}",
    response_model=LlmModelAdminRead,
    include_in_schema=False,
)
@router.patch("/operations/model", response_model=LlmModelAdminRead)
async def update_model(
    model_id: str,
    body: LlmModelAdminUpdate,
    db: AsyncSession = Depends(get_db),
) -> LlmModelAdminRead:
    """编辑模型，字段都可选（partial update）。"""
    model = await db.get(LlmModel, model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="模型不存在")
    data = body.model_dump(exclude_unset=True)
    selected_provider = data.get("provider", model.provider)
    selected_base_url = data.get("base_url", model.base_url)
    data = _canonical_config(
        data,
        provider=selected_provider,
        base_url=selected_base_url,
    )
    for field, value in data.items():
        setattr(model, field, value)
    await db.commit()
    await db.refresh(model)
    await llm.refresh()
    return _to_read(model)


@router.post(
    "/{model_id}/test",
    response_model=LlmModelTestResult,
    include_in_schema=False,
)
@router.post("/operations/model/test", response_model=LlmModelTestResult)
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
    except Exception as exc:
        return LlmModelTestResult(
            ok=False,
            message=f"适配器初始化失败：{type(exc).__name__}: {str(exc)[:200]}",
        )

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
            message=_test_error_message(exc, model),
            latency_ms=latency_ms,
        )


@router.post(
    "/{model_id}/test/{capability}",
    response_model=LlmModelCapabilityTestResult,
    include_in_schema=False,
)
@router.post(
    "/operations/model/test/{capability}",
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
    except Exception as exc:
        return LlmModelCapabilityTestResult(
            capability=capability,
            status="failed",
            message=f"适配器初始化失败：{type(exc).__name__}: {str(exc)[:200]}",
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
            if reason := unsupported_vision_reason(model.provider):
                return _capability_result(
                    capability,
                    "unsupported",
                    reason,
                    started,
                )
            image_data_url = _solid_png_data_url(230, 35, 45)
            header, image_data = image_data_url.split(",", 1)
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
                                "type": "image",
                                "base64": image_data,
                                "mime_type": header[5:].split(";", 1)[0],
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
            enabled = await _thinking_probe(model_id, enabled=True)
            details = [
                LlmModelCapabilityTestDetail(
                    key="thinking",
                    label="思考信号",
                    status="passed" if enabled.has_signal else "unsupported",
                    message=(
                        f"检测到 {enabled.tokens} 个推理 token"
                        if enabled.tokens
                        else "检测到模型返回的推理信号"
                        if enabled.has_signal
                        else "未检测到推理内容或推理 token"
                    ),
                ),
                LlmModelCapabilityTestDetail(
                    key="reasoning_content",
                    label="推理内容",
                    status="passed" if enabled.content else "unsupported",
                    message=(
                        f"返回 {len(enabled.content)} 个字符"
                        if enabled.content
                        else "未返回 thinking / reasoning_content 文本"
                    ),
                ),
            ]

            if not enabled.has_signal:
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

            if not supports_thinking_toggle(model.provider, model.id):
                details.append(
                    LlmModelCapabilityTestDetail(
                        key="disable_thinking",
                        label="关闭思考",
                        status="unsupported",
                        message="该厂商或当前模型没有可验证的关闭思考参数",
                    )
                )
                return _capability_result(
                    capability,
                    "unsupported",
                    "支持思考，但无法验证关闭开关",
                    started,
                    details,
                )

            try:
                disabled = await _thinking_probe(model_id, enabled=False)
                can_disable = not disabled.has_signal
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
                        message=_test_error_message(exc, model),
                    )
                )

            status: ModelTestStatus = (
                "failed"
                if not can_disable
                else "passed"
                if enabled.content
                else "unsupported"
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
        # 工具能力独立测试：可关闭思考的厂商先关闭，避免 thinking 模式对
        # tool_choice 的额外限制；不支持关闭的适配器会保留厂商默认行为。
        tool_model = llm.build_llm(model_id, thinking=False)
        tool_choice = tool_choice_for_provider(model.provider)
        if tool_choice is None:
            tool_llm = tool_model.bind_tools([tool_schema])
        else:
            tool_llm = tool_model.bind_tools([tool_schema], tool_choice=tool_choice)
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
            _test_error_message(exc, model),
            started,
        )


@router.delete("/{model_id}", status_code=204, include_in_schema=False)
@router.delete("/operations/model", status_code=204)
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
