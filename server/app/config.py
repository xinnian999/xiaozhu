"""应用配置 —— 用 pydantic-settings 把 .env 文件里的变量读成 Python 对象。

pydantic-settings 的核心思路：
  - 继承 BaseSettings 的类，字段声明等同于 Pydantic 的 BaseModel，
    但值会自动从环境变量 / .env 文件中加载，而不是在代码里写死。
  - 这样你只需要改 .env，不用动代码，安全且灵活。
"""

import os

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # model_config 告诉 pydantic-settings 去哪里读配置文件
    model_config = SettingsConfigDict(
        env_file=".env",  # 加载项目根目录的 .env 文件
        env_file_encoding="utf-8",
        # extra="allow"：.env 里没有对应字段声明的变量（如 API_KEY_QWEN）不会被丢弃，
        # 而是收进 model_extra，供下面 api_keys 动态扫描。这是「约定式读取分组 key」的关键。
        extra="allow",
    )

    # ── LLM API（走 OpenAI 兼容协议）────────────────────────────
    # 改用 OpenAI 协议是为了兼容更多中转服务 —— Anthropic 原生协议的中转
    # 经常会注入它自己的 system prompt / 工具集，污染我们 bind_tools 的结果。
    # OpenAI 协议生态成熟，中转一般是纯透传，行为更可预测。

    # 中转站只有一个，base_url 全局共用。None 表示用官方 api.openai.com。
    openai_base_url: str | None = None

    @property
    def api_keys(self) -> dict[str, str]:
        """动态扫出所有「分组 → api_key」。

        约定：分组 key 的变量名形如 API_KEY_{分组大写}，如 API_KEY_QWEN / API_KEY_CLAUDE。
        这样加一个新分组只需在 .env 里加一行，不用回来改这里的代码。

        来源有两处，都要扫（缺一不可）：
          1. .env 文件 —— 开发时用。extra="allow" 让它们落进 self.model_extra，
             pydantic 会把变量名转小写（API_KEY_QWEN → api_key_qwen）。
          2. os.environ —— 生产（Docker）时分组 key 是真实环境变量，不走 .env。
        两边合并，按 API_KEY_ 前缀过滤，去掉前缀后剩下的就是分组名。空值跳过。
        """
        keys: dict[str, str] = {}
        prefix = "api_key_"
        # 来源 1：.env 里的额外字段（pydantic 已转小写）
        for name, value in (self.model_extra or {}).items():
            if name.startswith(prefix) and value:
                keys[name[len(prefix):]] = str(value)
        # 来源 2：真实环境变量（统一转小写后同样按前缀匹配）
        for name, value in os.environ.items():
            lname = name.lower()
            if lname.startswith(prefix) and value:
                keys[lname[len(prefix):]] = value
        return keys

    # ── 数据库 ────────────────────────────────────────────────
    # SQLite 文件路径。sqlite+aiosqlite 前缀是 SQLAlchemy 的方言写法，
    # 代表"用 aiosqlite 驱动的 SQLite"（async 版本）。
    database_url: str = "sqlite+aiosqlite:///./xiaozhu.db"

    # 是否把每条 SQL 打到控制台。dev 调试时设为 true 很有用，
    # 生产环境保持 false：避免日志噪音 + 轻微性能开销。
    # 本地想开就在 server/.env 里加一行 DB_ECHO=true。
    db_echo: bool = False

    @property
    def checkpoint_db_path(self) -> str:
        """ask_user 用的 LangGraph checkpoint 库文件路径（纯文件路径，非 SQLAlchemy URL）。

        取 DATABASE_URL 同目录下的 checkpoints.db —— 复用同一个持久化目录（生产是
        docker-compose 挂载的 /app/data），不用再单独配一个环境变量。用独立文件
        （不与 xiaozhu.db 同库）是为了不让 checkpoint 的高频写入和主库的
        aiosqlite 连接 / 锁抢占。
        """
        # database_url 形如 "sqlite+aiosqlite:///./xiaozhu.db" 或
        # "sqlite+aiosqlite:////app/data/xiaozhu.db"，"///" 后面就是纯文件路径。
        path_part = self.database_url.split("///", 1)[-1]
        directory = os.path.dirname(path_part) or "."
        return os.path.join(directory, "checkpoints.db")

    # ── JWT 鉴权 ──────────────────────────────────────────────
    # jwt_secret：签名密钥，token 防伪造的根本。必须在 .env 里配置，
    #   且要够随机（用 secrets.token_urlsafe 生成）。泄露 = 任何人都能伪造身份。
    #   这里给个空默认值只是为了类型完整；真实值从 .env 读，没配会在启动校验里暴露。
    jwt_secret: str = ""
    # 签名算法。HS256 = 用同一个密钥签名和验证（对称），最简单，单机够用。
    jwt_algorithm: str = "HS256"
    # token 有效期（分钟）。过期后需要重新登录。这里设 7 天，练手项目方便。
    access_token_expire_minutes: int = 60 * 24 * 7

    # ── CORS ──────────────────────────────────────────────────
    # list[str] 让我们可以在 .env 里写逗号分隔的多个源，
    # pydantic-settings 会自动解析成列表。
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    # ── 个人收款码（微信/支付宝）+ 订单通知 ────────────────────
    # 本项目支付走「手动核对」：用户扫收款码付款 → 点「我已支付」→ 订单转待审核 →
    # 管理员在后台人工核对到账后放行升档（_fulfill_order）。没有第三方支付渠道 / webhook。
    # 收款码是图片（data URI），一般在 /admin →「配置」页上传，故这里默认空串。值可进 .env 也可入库。
    pay_qr_wechat: str = ""    # 微信收款码图片（data URI，如 data:image/png;base64,...）
    pay_qr_alipay: str = ""    # 支付宝收款码图片（data URI）
    pay_payee_name: str = ""   # 收款人显示名（展示用，可选）
    pay_contact: str = ""      # 联系方式（微信号/QQ/邮箱）：展示在「待审核」页，供用户主动联系
    # 新订单通知收件邮箱；留空则回退到 smtp_user（见 runtime_config 的 accessor）。
    order_notify_email: str = ""

    # ── 邮件 SMTP（发注册验证码用）────────────────────────────
    # 走标准 SMTP 协议发信。smtp_password 填邮箱的「授权码」(QQ/163 在邮箱设置里单独生成的
    # 专用密钥)，不是登录密码——可单独吊销，泄露也不连累主密码。值都进 .env（密钥别入仓库）。
    smtp_host: str = ""            # SMTP 服务器，如 smtp.qq.com / smtp.163.com
    smtp_port: int = 465          # 465=SSL（最常用）；587=STARTTLS
    smtp_user: str = ""           # 发信邮箱账号（同时作为 From 地址）
    smtp_password: str = ""       # 邮箱「授权码」（不是登录密码！）
    smtp_from_name: str = "小筑"  # 发件人显示名


# 单例：整个应用只实例化一次，其他模块 from app.config import settings 直接用
settings = Settings()
