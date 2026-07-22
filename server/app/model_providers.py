"""模型厂商目录与 LangChain 适配器。

``provider`` 描述实际 API 厂商/协议，而不是从模型名称猜品牌。成熟的独立
LangChain 集成优先；厂商官方推荐兼容协议时，由这里的厂商适配器负责非标准参数
与响应字段；只有未知中转才直接回退到 ``ChatOpenAI``。
"""

from dataclasses import asdict, dataclass
from typing import Any
from urllib.parse import urlparse

from langchain_anthropic import ChatAnthropic
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGenerationChunk, ChatResult
from langchain_deepseek import ChatDeepSeek
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_moonshot import ChatMoonshot
from langchain_openai import ChatOpenAI
from langchain_qwq import ChatQwen
from langchain_xai import ChatXAI


@dataclass(frozen=True)
class ProviderSpec:
    id: str
    label: str
    logo: str
    adapter: str
    default_base_url: str | None
    description: str


PROVIDERS: tuple[ProviderSpec, ...] = (
    ProviderSpec("openai", "OpenAI", "OpenAI", "ChatOpenAI", None, "OpenAI 官方 API"),
    ProviderSpec(
        "anthropic",
        "Anthropic Claude",
        "Claude.Color",
        "ChatAnthropic",
        None,
        "Anthropic Messages API",
    ),
    ProviderSpec(
        "google",
        "Google Gemini",
        "Gemini.Color",
        "ChatGoogleGenerativeAI",
        None,
        "Google Gemini Developer API",
    ),
    ProviderSpec(
        "deepseek",
        "DeepSeek 深度求索",
        "DeepSeek.Color",
        "ChatDeepSeek",
        "https://api.deepseek.com",
        "DeepSeek 独立 LangChain 集成",
    ),
    ProviderSpec(
        "qwen",
        "阿里云通义千问",
        "Qwen.Color",
        "ChatQwen",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "DashScope Qwen 独立 LangChain 集成",
    ),
    ProviderSpec(
        "moonshot",
        "月之暗面 Kimi",
        "Moonshot",
        "ChatMoonshot",
        "https://api.moonshot.cn/v1",
        "Moonshot 独立 LangChain 集成",
    ),
    ProviderSpec(
        "minimax",
        "MiniMax",
        "Minimax.Color",
        "MiniMax · Anthropic",
        "https://api.minimaxi.com/anthropic",
        "按 MiniMax 官方推荐使用 Anthropic 协议",
    ),
    ProviderSpec(
        "zhipu",
        "智谱 GLM",
        "Zhipu.Color",
        "GLM Adapter",
        "https://open.bigmodel.cn/api/paas/v4",
        "保留 GLM reasoning_content 与思考参数",
    ),
    ProviderSpec(
        "doubao",
        "字节豆包",
        "Doubao.Color",
        "Ark Adapter",
        "https://ark.cn-beijing.volces.com/api/v3",
        "火山方舟协议与思考参数适配",
    ),
    ProviderSpec(
        "xai",
        "xAI Grok",
        "Grok",
        "ChatXAI",
        "https://api.x.ai/v1",
        "xAI 独立 LangChain 集成",
    ),
    ProviderSpec(
        "custom_openai",
        "自定义 / 中转站",
        "OpenAI",
        "ChatOpenAI fallback",
        None,
        "未知厂商使用 OpenAI Chat Completions 兼容协议兜底",
    ),
)

_BY_ID = {item.id: item for item in PROVIDERS}
_REASONING_FIELDS = ("reasoning_content", "reasoning", "reasoning_details")


class _SerialToolsMixin:
    """默认关闭并行工具调用，保持现有共享 AsyncSession 的串行约束。"""

    def bind_tools(
        self,
        tools: Any,
        *,
        parallel_tool_calls: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        return super().bind_tools(
            tools,
            parallel_tool_calls=(
                False if parallel_tool_calls is None else parallel_tool_calls
            ),
            **kwargs,
        )


class _ReasoningHistoryMixin:
    """把非标准推理字段带回下一轮 assistant 消息。

    多数厂商集成已经能解析响应中的 ``reasoning_content``，但 OpenAI 消息
    序列化器不会自动把它重新放进工具调用后的下一次请求。DeepSeek、Qwen、
    GLM、Ark 与 xAI 的交错思考都需要这一步。
    """

    def _get_request_payload(
        self,
        input_: Any,
        *,
        stop: list[str] | None = None,
        **kwargs: Any,
    ) -> dict:
        messages = self._convert_input(input_).to_messages()
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)
        wire_messages = payload.get("messages")
        if isinstance(wire_messages, list):
            for source, wire in zip(messages, wire_messages, strict=False):
                if not isinstance(source, AIMessage) or not isinstance(wire, dict):
                    continue
                for field in _REASONING_FIELDS:
                    if field in source.additional_kwargs:
                        wire[field] = source.additional_kwargs[field]
        return payload


class ReasoningCompatibleChatOpenAI(_ReasoningHistoryMixin, ChatOpenAI):
    """官方推荐 OpenAI SDK 的厂商适配器。

    ``ChatOpenAI`` 只承诺 OpenAI 官方字段，会丢弃 GLM/Ark 等端点返回的
    ``reasoning_content``。这里保留这些扩展字段，并在后续工具回合原样传回，
    以支持交错思考。
    """

    def _create_chat_result(
        self,
        response: dict | Any,
        generation_info: dict | None = None,
    ) -> ChatResult:
        raw = response if isinstance(response, dict) else response.model_dump()
        result = super()._create_chat_result(response, generation_info)
        choices = raw.get("choices", []) if isinstance(raw, dict) else []
        for generation, choice in zip(result.generations, choices, strict=False):
            message = choice.get("message", {}) if isinstance(choice, dict) else {}
            for field in _REASONING_FIELDS:
                if value := message.get(field):
                    generation.message.additional_kwargs[field] = value
        return result

    def _convert_chunk_to_generation_chunk(
        self,
        chunk: dict,
        default_chunk_class: type,
        base_generation_info: dict | None,
    ) -> ChatGenerationChunk | None:
        generation = super()._convert_chunk_to_generation_chunk(
            chunk, default_chunk_class, base_generation_info
        )
        choices = chunk.get("choices", [])
        delta = choices[0].get("delta", {}) if choices else {}
        if generation and isinstance(generation.message, AIMessageChunk):
            for field in _REASONING_FIELDS:
                if value := delta.get(field):
                    generation.message.additional_kwargs[field] = value
        return generation


class SerialChatAnthropic(_SerialToolsMixin, ChatAnthropic):
    """Anthropic 协议适配器，默认要求一次只返回一个工具调用。"""


class ReasoningChatDeepSeek(
    _ReasoningHistoryMixin,
    _SerialToolsMixin,
    ChatDeepSeek,
):
    """保留 DeepSeek 集成的响应解析，并补齐推理历史回传。"""


class ReasoningChatQwen(_ReasoningHistoryMixin, ChatQwen):
    """补齐 Qwen 推理历史回传，并保持 Agent 工具串行执行。"""

    def bind_tools(
        self,
        tools: Any,
        *,
        tool_choice: Any = None,
        strict: bool | None = None,
        parallel_tool_calls: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        # ChatQwen 在未指定时会强制 parallel_tool_calls=True，而且显式 False
        # 也没有继续传给父类；直接调用 ChatOpenAI 的实现以避免共享 AsyncSession
        # 被多个工具并发使用。
        if tool_choice in ("required", "any"):
            tool_choice = "auto"
        return ChatOpenAI.bind_tools(
            self,
            tools,
            tool_choice=tool_choice,
            strict=strict,
            parallel_tool_calls=(
                False if parallel_tool_calls is None else parallel_tool_calls
            ),
            **kwargs,
        )


class SerialChatMoonshot(_SerialToolsMixin, ChatMoonshot):
    """Moonshot 原生适配器，默认保持工具串行执行。"""


class ReasoningChatXAI(_ReasoningHistoryMixin, _SerialToolsMixin, ChatXAI):
    """保留 xAI 原生适配器，同时支持工具回合中的推理字段回传。"""


def provider_catalog() -> list[dict]:
    return [asdict(item) for item in PROVIDERS]


def normalize_provider(provider: str | None) -> str:
    return provider if provider in _BY_ID else "custom_openai"


def provider_spec(provider: str | None) -> ProviderSpec:
    return _BY_ID[normalize_provider(provider)]


def provider_logo(provider: str | None) -> str:
    return provider_spec(provider).logo


def infer_provider(base_url: str | None) -> str:
    """迁移旧数据：只按官方 API 域名识别，自定义中转不猜模型品牌。"""
    candidate = (base_url or "").strip()
    if candidate and "://" not in candidate:
        candidate = f"//{candidate}"
    try:
        host = (urlparse(candidate).hostname or "").lower()
    except ValueError:
        return "custom_openai"
    if not host:
        return "openai"
    rules = (
        ("api.openai.com", "openai"),
        ("api.anthropic.com", "anthropic"),
        ("generativelanguage.googleapis.com", "google"),
        ("api.deepseek.com", "deepseek"),
        ("dashscope.aliyuncs.com", "qwen"),
        ("dashscope-intl.aliyuncs.com", "qwen"),
        ("dashscope-us.aliyuncs.com", "qwen"),
        ("maas.aliyuncs.com", "qwen"),
        ("api.moonshot.cn", "moonshot"),
        ("api.moonshot.ai", "moonshot"),
        ("api.minimaxi.com", "minimax"),
        ("api.minimax.io", "minimax"),
        ("api.minimax.chat", "minimax"),
        ("volces.com", "doubao"),
        ("bigmodel.cn", "zhipu"),
        ("api.x.ai", "xai"),
    )
    for domain, provider in rules:
        if host == domain or host.endswith(f".{domain}"):
            return provider
    return "custom_openai"


def canonical_model_values(
    provider: str | None, base_url: str | None
) -> tuple[str, str, str | None]:
    provider_id = normalize_provider(provider)
    spec = provider_spec(provider_id)
    normalized_base_url = base_url.strip() if isinstance(base_url, str) else base_url
    return provider_id, spec.logo, normalized_base_url or spec.default_base_url


def _thinking_extra_body(provider: str, thinking: bool) -> dict[str, Any]:
    if provider in {"deepseek", "zhipu", "doubao"}:
        config: dict[str, Any] = {"type": "enabled" if thinking else "disabled"}
        if provider == "zhipu" and thinking:
            config["clear_thinking"] = False
        return {"thinking": config}
    if provider == "qwen":
        return {"enable_thinking": thinking}
    return {}


def _is_gemini_3(model: str) -> bool:
    return model.lower().rsplit("/", 1)[-1].startswith("gemini-3")


def _google_can_disable_thinking(model: str) -> bool:
    """Google 仅允许 Gemini 2.5 Flash / Flash-Lite 用 budget=0 真正关闭。"""
    model_name = model.lower().rsplit("/", 1)[-1]
    return model_name.startswith("gemini-2.5-flash")


def build_chat_model(meta: dict, *, thinking: bool | None = None) -> BaseChatModel:
    """按厂商构造模型；None 保留厂商默认，布尔值用于能力对比测试。"""
    provider = normalize_provider(meta.get("provider"))
    model = meta["id"]
    api_key = meta["api_key"]
    base_url = meta.get("base_url") or provider_spec(provider).default_base_url

    if provider == "anthropic":
        return SerialChatAnthropic(
            model_name=model,
            api_key=api_key,
            base_url=base_url,
            max_tokens_to_sample=16384,
            max_retries=2,
            thinking=(
                {"type": "enabled", "budget_tokens": 2048} if thinking is True else None
            ),
        )
    if provider == "minimax":
        # MiniMax M2.x 官方推荐 Anthropic 协议，可原生保留 thinking block 与工具回合。
        return SerialChatAnthropic(
            model_name=model,
            api_key=api_key,
            base_url=base_url,
            max_tokens_to_sample=16384,
            max_retries=2,
        )
    if provider == "google":
        kwargs: dict[str, Any] = {
            "model": model,
            "api_key": api_key,
            "max_tokens": 16384,
            "retries": 2,
        }
        if thinking is True:
            if _is_gemini_3(model):
                kwargs["thinking_level"] = "high"
                kwargs["include_thoughts"] = True
            elif model.lower().rsplit("/", 1)[-1].startswith("gemini-2.5"):
                kwargs["thinking_budget"] = 1024
                kwargs["include_thoughts"] = True
        elif thinking is False and _google_can_disable_thinking(model):
            kwargs["thinking_budget"] = 0
            kwargs["include_thoughts"] = False
        if base_url:
            kwargs["client_options"] = {"api_endpoint": base_url}
        return ChatGoogleGenerativeAI(**kwargs)
    if provider == "deepseek":
        return ReasoningChatDeepSeek(
            model=model,
            api_key=api_key,
            base_url=base_url,
            max_tokens=16384,
            max_retries=2,
            extra_body=(
                _thinking_extra_body(provider, thinking)
                if thinking is not None
                else None
            ),
        )
    if provider == "qwen":
        kwargs = {
            "model": model,
            "api_key": api_key,
            "base_url": base_url,
            "max_tokens": 16384,
            "max_retries": 2,
        }
        if thinking is not None:
            kwargs["enable_thinking"] = thinking
        return ReasoningChatQwen(**kwargs)
    if provider == "moonshot":
        kwargs = {
            "model": model,
            "api_key": api_key,
            "base_url": base_url,
            "max_tokens": 16384,
            "max_retries": 2,
        }
        if thinking is not None:
            kwargs["thinking"] = thinking
        return SerialChatMoonshot(**kwargs)
    if provider == "xai":
        return ReasoningChatXAI(
            model=model,
            api_key=api_key,
            base_url=base_url or "https://api.x.ai/v1",
            max_tokens=16384,
            max_retries=2,
            reasoning_effort="high" if thinking is True else None,
        )
    if provider in {"zhipu", "doubao"}:
        return ReasoningCompatibleChatOpenAI(
            model=model,
            api_key=api_key,
            base_url=base_url,
            max_tokens=16384,
            max_retries=2,
            model_kwargs={"parallel_tool_calls": False},
            extra_body=(
                _thinking_extra_body(provider, thinking)
                if thinking is not None
                else None
            ),
        )

    kwargs: dict[str, Any] = {}
    if provider == "openai" and thinking is True:
        kwargs["reasoning_effort"] = "medium"
    # OpenAI 官方与未知中转共用传输类，但未知中转不注入任何厂商私有参数。
    return ChatOpenAI(
        model=model,
        api_key=api_key,
        base_url=base_url,
        max_tokens=16384,
        max_retries=2,
        model_kwargs={"parallel_tool_calls": False},
        **kwargs,
    )


def supports_thinking_toggle(
    provider: str | None,
    model: str | None = None,
) -> bool:
    """是否存在可实际发出、可对比验证的厂商思考开关。"""
    provider_id = normalize_provider(provider)
    if provider_id == "google":
        return bool(model and _google_can_disable_thinking(model))
    return provider_id in {
        "anthropic",
        "deepseek",
        "qwen",
        "moonshot",
        "zhipu",
        "doubao",
    }


def unsupported_vision_reason(provider: str | None) -> str | None:
    provider = normalize_provider(provider)
    if provider == "deepseek":
        return "DeepSeek 官方 Chat Completion 当前只接受文本消息"
    if provider == "minimax":
        return "MiniMax M2.x 文本生成端点当前不接受图片输入"
    return None


def tool_choice_for_provider(provider: str | None) -> str | None:
    """返回厂商支持的强制工具选择值；None 表示只发送工具定义。"""
    provider = normalize_provider(provider)
    if provider in {"deepseek", "qwen"}:
        return None
    if provider in {"anthropic", "google", "minimax"}:
        return "any"
    return "required"
