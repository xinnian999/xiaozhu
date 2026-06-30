"""LLM 模型配置（搬进数据库）—— 原本写死在 app/llm.py 的 AVAILABLE_MODELS。

单表设计：每个模型自带全部所需信息（不再有「分组」共享 key 的机制）：
  id / name / base_url / api_key / logo / cost(倍率) / vision(识图) / enabled(启用)。

读取方：app/llm.py。它启动时把本表读进内存缓存（registry），
build_llm / public_models / 白名单校验都查缓存，不每次打数据库；
后台改了模型后调用 reload_registry() 刷新缓存即时生效。
"""

from sqlalchemy import Boolean, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class LlmModel(Base):
    """数据库表 `llm_models`：一个可选模型，自带 base_url + api_key。"""

    __tablename__ = "llm_models"

    # 真正传给中转的模型名，做主键，如 "qwen3-coder-next"。
    id: Mapped[str] = mapped_column(String, primary_key=True)

    # 给前端下拉框展示的人类可读名，如 "Qwen3 Coder Next"。
    name: Mapped[str] = mapped_column(String, nullable=False)

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
        # 后台关联展示时的文本。用「显示名」更直观。
        return self.name
