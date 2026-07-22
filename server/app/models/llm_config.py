"""LLM 模型配置（搬进数据库）—— 原本写死在 app/llm.py 的 AVAILABLE_MODELS。

单表设计：每个模型自带全部所需信息（不再有「分组」共享 key 的机制）：
  id / base_url / api_key / logo / cost(倍率) / vision(识图) / enabled(启用)。

读取方：app/llm.py。它启动时把本表读进内存缓存（registry），
build_llm / public_models / 白名单校验都查缓存，不每次打数据库；
后台改了模型后调用 reload_registry() 刷新缓存即时生效。
"""

from sqlalchemy import Boolean, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from datetime import datetime

from app.db import Base


class LlmModel(Base):
    """数据库表 `llm_models`：一个可选模型，自带 base_url + api_key。"""

    __tablename__ = "llm_models"

    # 真正传给中转的模型名，做主键，如 "qwen3-coder-next"。同时作为前端展示名。
    id: Mapped[str] = mapped_column(String, primary_key=True)

    # 该模型调用的中转地址（OpenAI 兼容端点）。为空则用官方 api.openai.com。
    base_url: Mapped[str | None] = mapped_column(String, nullable=True)

    # 该模型调用用的 api_key。敏感 —— 后台列表会脱敏显示。
    api_key: Mapped[str] = mapped_column(String, nullable=False, server_default="")

    # 品牌 logo 标识（@lobehub/icons 的组件标识符，如 "Qwen.Color" / "OpenAI"），
    # 不是 URL。前端拿这个字符串解析成图标；解析不出会退回兜底图标。
    logo: Mapped[str] = mapped_column(String, nullable=False, server_default="")

    # 是否支持识图（多模态）。前端据此把不支持的模型「添加图片」按钮置灰。
    vision: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="0")

    # 付费倍率：一轮对话扣多少点。普通 1、更贵的模型 2（计费见 app/billing.py）。
    cost: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")

    # 是否启用。关掉的模型不出现在前端清单、也不允许被调用 —— 这就是「临时下线」开关。
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="1")

    # 排序权重，越小越靠前。前端清单与「默认模型」都按它排序，方便调整展示顺序。
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    def __str__(self) -> str:
        return self.id


# ── Pydantic Schemas ───────────────────────────────────────────────────────────

from typing import Literal  # noqa: E402

from pydantic import BaseModel, Field  # noqa: E402


class LlmModelAdminRead(BaseModel):
    """管理后台模型列表响应。api_key 脱敏后再放进这个字段，脱敏逻辑在路由层处理。"""

    model_config = {"from_attributes": True}

    id: str
    base_url: str | None
    api_key: str
    logo: str
    vision: bool
    cost: int
    enabled: bool
    sort_order: int


class LlmModelAdminCreate(BaseModel):
    """POST /api/admin/models 的请求体：新增一个模型（对齐 admin.py 的 form_include_pk）。"""

    id: str = Field(min_length=1)
    base_url: str | None = None
    api_key: str = ""
    logo: str = ""
    vision: bool = False
    cost: int = Field(default=1, ge=1)
    enabled: bool = True
    sort_order: int = 0


class LlmModelAdminUpdate(BaseModel):
    """PATCH /api/admin/models/{id} 的请求体：编辑模型，字段都可选（partial update）。"""

    base_url: str | None = None
    api_key: str | None = None
    logo: str | None = None
    vision: bool | None = None
    cost: int | None = Field(default=None, ge=1)
    enabled: bool | None = None
    sort_order: int | None = None


class SetEnabledRequest(BaseModel):
    """POST /api/admin/models/set-enabled 的请求体：批量启停。"""

    model_ids: list[str] = Field(min_length=1)
    enabled: bool


class LlmModelExportItem(BaseModel):
    """导出/导入用的单条模型配置（含明文 api_key，仅管理员接口使用）。"""

    model_config = {"from_attributes": True}

    id: str = Field(min_length=1)
    base_url: str | None = None
    api_key: str = ""
    logo: str = ""
    vision: bool = False
    cost: int = Field(default=1, ge=1)
    enabled: bool = True
    sort_order: int = 0


class LlmModelExportBundle(BaseModel):
    """GET /api/admin/models/export 的响应体：带版本号的导出包，方便跨环境迁移。"""

    version: int = 1
    exported_at: datetime
    models: list[LlmModelExportItem]


class LlmModelImportRequest(BaseModel):
    """POST /api/admin/models/import 的请求体：按 id upsert 导入模型配置。"""

    models: list[LlmModelExportItem] = Field(min_length=1)


class LlmModelImportResult(BaseModel):
    """导入结果统计。"""

    created: int
    updated: int
    total: int


class LlmModelTestResult(BaseModel):
    """POST /api/admin/models/{id}/test 的响应体：连通性探测结果。"""

    ok: bool
    message: str
    latency_ms: int | None = None


ModelTestCapability = Literal[
    "connectivity",
    "vision",
    "thinking",
    "tools",
]
ModelTestStatus = Literal["passed", "unsupported", "failed"]


class LlmModelCapabilityTestDetail(BaseModel):
    """组合能力卡中的子项结果，目前用于思考能力的三项细分。"""

    key: Literal["thinking", "reasoning_content", "disable_thinking"]
    label: str
    status: ModelTestStatus
    message: str


class LlmModelCapabilityTestResult(BaseModel):
    """单项能力探测结果；管理后台会逐项调用，以便实时展示进度。"""

    capability: ModelTestCapability
    status: ModelTestStatus
    message: str
    latency_ms: int | None = None
    details: list[LlmModelCapabilityTestDetail] = Field(default_factory=list)
