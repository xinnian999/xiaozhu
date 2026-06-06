"""LLM 模型注册表 + 构造 —— 模型配置的单一真相源。

加一个新模型，原则上只动这个文件的 AVAILABLE_MODELS 一处：
  - 已有分组的模型：只在 AVAILABLE_MODELS 加一项。
  - 新分组的模型：AVAILABLE_MODELS 加一项 + 在 .env 加一行 API_KEY_{分组大写}。
config.py / chat.py 都不用改。
"""

from fastapi import HTTPException
from langchain_openai import ChatOpenAI

from app.config import settings


# ── 可选模型白名单 ────────────────────────────────────────────────────────────────
# 前端只能从这个列表里「选」，不能「传」任意 model 字符串。原因：
#   1. 安全 —— 模型名是计费/能力相关的敏感参数，不该把选择权完全交给客户端。
#   2. 可控 —— 中转到底支持哪些模型由后端说了算，前端瞎传一个不存在的会神秘失败。
#   3. 解耦 —— 以后改清单只动这一处，前端从 GET /api/models 动态拉，不用跟着改。
# 这就是「白名单」：它是可选模型的唯一真相源。
#
# 每项三个字段：
#   id    —— 真正传给中转的模型名（后端 / API 用）
#   label —— 给前端下拉框展示的人类可读名
#   group —— 该模型属于中转站的哪个「分组」。中转站按分组发不同 api_key，
#            所以这里只存分组名（不存 key！），真正的 key 在 build_llm 里按分组从 .env 取。
#            同一分组下的多个模型共用一个 key —— 这正是「分组」存在的意义。
#            另：分组在本项目里就等于「厂商」，所以 logo 也按分组派生（见 GROUP_ICONS）。
AVAILABLE_MODELS = [
    {"id": "qwen3-coder-next", "label": "Qwen3 Coder Next", "group": "qwen"},
    {"id": "qwen3.6-plus", "label": "Qwen3.6 Plus", "group": "qwen"},
    {"id": "gpt-5.5", "label": "GPT-5.5", "group": "gpt"},
]

# 分组 → 品牌 logo（@lobehub/icons 的「组件标识符」，不是 URL！）。
# 格式 "{Name}" 或 "{Name}.{Variant}"，如 "Qwen.Color" / "OpenAI"。前端拿这个字符串解析成图标组件。
# logo 是「厂商」属性，而分组在本项目里就是厂商，所以同分组的模型共用一个 logo —— 没必要每个模型重复写。
# 注意：不是每个厂商都有 .Color 彩色变体（如 OpenAI logo 本身是纯黑，只有默认 Mono 形态）。
GROUP_ICONS = {
    "qwen": "Qwen.Color",
    "gpt": "OpenAI",
}

# 校验用的集合：判断「前端传来的 model 是否合法」时，用 set 查 O(1)，
# 比每次遍历 AVAILABLE_MODELS 快，也读着更清楚（in 一个集合 = 在不在白名单里）。
ALLOWED_MODEL_IDS = {m["id"] for m in AVAILABLE_MODELS}

# 「模型 id → 该模型的元信息」索引，build_llm 里 O(1) 查到它属于哪个分组。
MODELS_BY_ID = {m["id"]: m for m in AVAILABLE_MODELS}

# 白名单第一个模型当默认 —— 前端不传 model 时用它，保证向后兼容。
DEFAULT_MODEL_ID = AVAILABLE_MODELS[0]["id"]


def public_models() -> list[dict]:
    """给前端的模型清单。只吐 id / label / icon —— 故意不含 group，更不含 api_key：
    group 是后端内部「选哪个 key」的路由信息，前端不需要知道；
    api_key 是密钥，绝不能出现在任何响应里。

    icon 不存在模型里，而是这里按 group 现派生出来：分组找不到对应 logo 就给空串，
    前端解析不出会自动退回兜底图标，不会报错。
    """
    return [
        {"id": m["id"], "label": m["label"], "icon": GROUP_ICONS.get(m["group"], "")}
        for m in AVAILABLE_MODELS
    ]


def build_llm(model: str) -> ChatOpenAI:
    """按指定模型名构造一个 LLM 实例。model 必须已通过白名单校验。

    根据模型所属的「分组」取对应的 api_key —— 中转站按分组发不同 key。
    base_url 全局共用；变的只是 key。

    故意不在这里 bind_tools：工具实现要闭包捕获请求级别的 db / session_id，
    所以每次请求才能把工具构造出来再 bind。
    """
    group = MODELS_BY_ID[model]["group"]
    api_key = settings.api_keys.get(group)
    if not api_key:
        # 分组的 key 没在 .env 配置 —— 明确报错，而不是带空 key 去调用、
        # 等中转返回 401 才发现。早报错好定位。
        raise HTTPException(
            status_code=400,
            detail=f"模型 {model} 所属分组「{group}」未配置 api_key，请在 .env 设置对应 API_KEY_*。",
        )
    return ChatOpenAI(
        model=model,
        api_key=api_key,
        base_url=settings.openai_base_url,
        # 一次 write_file 要塞下整个文件内容，4096 太小，写稍大的页面就会被截断
        # （finish_reason=length），导致工具参数残缺、本轮空转。先给到 16384。
        max_tokens=16384,
    )
