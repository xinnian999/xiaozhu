"""应用配置 —— 用 pydantic-settings 把 .env 文件里的变量读成 Python 对象。

pydantic-settings 的核心思路：
  - 继承 BaseSettings 的类，字段声明等同于 Pydantic 的 BaseModel，
    但值会自动从环境变量 / .env 文件中加载，而不是在代码里写死。
  - 这样你只需要改 .env，不用动代码，安全且灵活。
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # model_config 告诉 pydantic-settings 去哪里读配置文件
    model_config = SettingsConfigDict(
        env_file=".env",  # 加载项目根目录的 .env 文件
        env_file_encoding="utf-8",
        extra="ignore",  # .env 里有多余字段时不报错，方便以后扩展
    )

    # ── LLM API（走 OpenAI 兼容协议）────────────────────────────
    # 改用 OpenAI 协议是为了兼容更多中转服务 —— Anthropic 原生协议的中转
    # 经常会注入它自己的 system prompt / 工具集，污染我们 bind_tools 的结果。
    # OpenAI 协议生态成熟，中转一般是纯透传，行为更可预测。
    #
    # 声明了类型 str，没有默认值 → 启动时若环境变量缺失会直接报错，
    # 而不是在调用 LLM 时才神秘失败。早报错 > 晚报错。
    openai_api_key: str

    # 用哪个模型。默认仍是 Claude，但通过中转走 OpenAI 协议调
    llm_model: str = "claude-sonnet-4-5"

    # OpenAI 兼容端点的 base url，None 表示用官方 api.openai.com
    openai_base_url: str | None = None

    # ── 数据库 ────────────────────────────────────────────────
    # SQLite 文件路径。sqlite+aiosqlite 前缀是 SQLAlchemy 的方言写法，
    # 代表"用 aiosqlite 驱动的 SQLite"（async 版本）。
    database_url: str = "sqlite+aiosqlite:///./vibuild.db"

    # ── CORS ──────────────────────────────────────────────────
    # list[str] 让我们可以在 .env 里写逗号分隔的多个源，
    # pydantic-settings 会自动解析成列表。
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]


# 单例：整个应用只实例化一次，其他模块 from app.config import settings 直接用
settings = Settings()
