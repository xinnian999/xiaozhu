"""运行时动态配置 —— 把原本在 .env 的「可改配置」从数据库 app_settings 表读出来用。

设计：
  - 启动时 load() 把整张 app_settings 表读进内存 _cache（一个 dict）。
  - 业务代码通过模块单例 cfg 访问，如 cfg.smtp_host —— 读的是内存缓存，不打数据库。
  - 后台（SQLAdmin）改了配置后调用 refresh() 重新 load，缓存即时更新。
  - 缓存里没有某个 key 时回退到 .env（settings.*）—— 这让「还没把配置写进库」的
    老部署无缝过渡：第一次启动 ensure_seeded() 会把 .env 现值灌进库，之后以库为准。

为什么不直接每次查库：这些配置每条请求都可能要读（发邮件、调中转），
读内存 dict 是纳秒级，查库要 await + IO，缓存是显然更划算的选择。
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.app_setting import AppSetting


# ── 配置项清单（仅元数据，用于「首次把 .env 灌进库」和后台展示）──────────────────
# 每项：(key, category, is_secret, description)
#   key         —— 与 .env 字段名对应的小写键
#   category    —— 后台分组展示用
#   is_secret   —— 密钥类，后台列表脱敏显示
#   description —— 后台提示「填什么 / 去哪拿」
# ⚠️ 不含 JWT_SECRET / DATABASE_URL：根密钥与库位置必须留在 .env（见 config.py）。
# ⚠️ 不含 api_key / base_url：模型相关配置（含每个模型自己的 base_url、api_key）在 llm_models 表。
SETTING_DEFS: list[tuple[str, str, bool, str]] = [
    ("smtp_host", "邮件", False, "SMTP 服务器，如 smtp.qq.com / smtp.163.com"),
    ("smtp_port", "邮件", False, "SMTP 端口：465=SSL（常用），587=STARTTLS"),
    ("smtp_user", "邮件", False, "发信邮箱账号（同时作为 From 地址）"),
    ("smtp_password", "邮件", True, "邮箱「授权码」（不是登录密码！）"),
    ("smtp_from_name", "邮件", False, "发件人显示名"),
    ("afdian_user_id", "爱发电", False, "创作者 user_id（开发者后台）"),
    ("afdian_token", "爱发电", True, "API Token（开发者后台生成，密钥）"),
    ("afdian_pro_plan_id", "爱发电", False, "Pro 会员商品的 plan_id"),
    ("afdian_pro_sku_id", "爱发电", False, "Pro 会员商品的 sku_id"),
    ("afdian_max_plan_id", "爱发电", False, "Max 会员商品的 plan_id"),
    ("afdian_max_sku_id", "爱发电", False, "Max 会员商品的 sku_id"),
    ("afdian_public_base", "爱发电", False, "线上公网域名（不带末尾斜杠）"),
]


class RuntimeConfig:
    """动态配置的读取入口。模块底部实例化成单例 cfg 供全局使用。"""

    # 类属性当缓存：所有实例（其实只有一个 cfg）共享同一份；refresh() 时整体替换。
    _cache: dict[str, str] = {}

    def _raw(self, key: str) -> str | None:
        """取某个 key 的原始字符串值：缓存命中（哪怕空串）就用缓存，
        否则回退到 .env（settings 上的同名属性）。回退用于「库里还没这条」的过渡期。
        """
        if key in self._cache:
            return self._cache[key]
        env_val = getattr(settings, key, None)
        return None if env_val is None else str(env_val)

    # ── 各配置项的类型化访问器（与 settings 同名，改造消费方时一一对应替换）──────
    @property
    def smtp_host(self) -> str:
        return self._raw("smtp_host") or ""

    @property
    def smtp_port(self) -> int:
        # 端口在库里是字符串，转 int；空 / 非法时回退 465（最常用的 SSL 端口）
        raw = self._raw("smtp_port")
        try:
            return int(raw) if raw else 465
        except ValueError:
            return 465

    @property
    def smtp_user(self) -> str:
        return self._raw("smtp_user") or ""

    @property
    def smtp_password(self) -> str:
        return self._raw("smtp_password") or ""

    @property
    def smtp_from_name(self) -> str:
        return self._raw("smtp_from_name") or "小筑"

    @property
    def afdian_user_id(self) -> str:
        return self._raw("afdian_user_id") or ""

    @property
    def afdian_token(self) -> str:
        return self._raw("afdian_token") or ""

    @property
    def afdian_pro_plan_id(self) -> str:
        return self._raw("afdian_pro_plan_id") or ""

    @property
    def afdian_pro_sku_id(self) -> str:
        return self._raw("afdian_pro_sku_id") or ""

    @property
    def afdian_max_plan_id(self) -> str:
        return self._raw("afdian_max_plan_id") or ""

    @property
    def afdian_max_sku_id(self) -> str:
        return self._raw("afdian_max_sku_id") or ""

    @property
    def afdian_public_base(self) -> str:
        return self._raw("afdian_public_base") or ""


# 模块单例：业务代码 from app.runtime_config import cfg 后直接 cfg.smtp_host
cfg = RuntimeConfig()


async def load(session: AsyncSession) -> None:
    """把 app_settings 整表读进内存缓存。启动时与 refresh() 时调用。"""
    result = await session.execute(select(AppSetting))
    RuntimeConfig._cache = {row.key: row.value for row in result.scalars()}


async def ensure_seeded(session: AsyncSession) -> None:
    """首次启动把 .env 现值灌进库：对清单里「库中还不存在」的 key 建行，
    值取 .env 现值。幂等 —— 已存在的 key 不动，所以不会覆盖后台后来的改动。
    """
    result = await session.execute(select(AppSetting.key))
    existing = {k for (k,) in result.all()}
    added = False
    for key, category, is_secret, description in SETTING_DEFS:
        if key in existing:
            continue
        env_val = getattr(settings, key, None)
        session.add(
            AppSetting(
                key=key,
                value="" if env_val is None else str(env_val),
                category=category,
                is_secret=is_secret,
                description=description,
            )
        )
        added = True
    if added:
        await session.commit()


async def refresh() -> None:
    """后台改完配置后刷新缓存。自己开一个 session（不依赖请求级 db）。"""
    # 延迟 import 避免与 db 模块的循环依赖
    from app.db import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        await load(session)
