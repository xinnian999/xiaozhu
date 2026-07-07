"""AppSetting（应用配置）—— 把原本散在 .env 里的「运行时可改配置」搬进数据库。

为什么用「键值表」而不是给每个配置开一列：
  - 这些配置（SMTP_*、PAY_* 等）数量会变、彼此无关，用一张 key/value 表最灵活：
    以后加一个新配置 = 插一行，不用再写迁移加列。
  - 管理后台（web-admin）对一张 KV 表能直接渲染「列表 + 编辑」界面，前端也几乎零额外代码。

读取方：app/runtime_config.py。它启动时把本表全部读进内存缓存，
业务代码通过 cfg.smtp_host 这种属性访问；后台改了值会刷新缓存。
缓存为空（首次部署、表里还没数据）时回退到 .env，所以老部署无缝过渡。

⚠️ 哪些**不**放这里：JWT_SECRET、DATABASE_URL —— 它们是「根密钥 / 库位置」，
放进库里有循环信任 / 鸡生蛋问题，必须留在 .env（见 config.py 顶部说明）。
"""

from sqlalchemy import Boolean, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class AppSetting(Base):
    """数据库表 `app_settings` 的 ORM 映射：一行就是一个「配置项」。"""

    __tablename__ = "app_settings"

    # 配置键，主键。约定用小写、与 .env 字段名对应（如 smtp_host / pay_qr_wechat）。
    key: Mapped[str] = mapped_column(String, primary_key=True)

    # 配置值，统一用字符串存。需要数字（如 smtp_port）的，由读取方负责转换。
    # 用 Text 而不是 String：个别值（如将来某些长配置）可能较长，Text 不限长更省心。
    value: Mapped[str] = mapped_column(Text, nullable=False, server_default="")

    # 分类，纯展示用：让后台列表能按「邮件 / 收款 / 模型」分组看，便于查找。
    category: Mapped[str] = mapped_column(String, nullable=False, server_default="")

    # 是否敏感（密钥类）。后台列表会据此把值脱敏显示（如 sk-***123），避免肩窥泄露。
    is_secret: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="0")

    # 人类可读的说明，后台展示，提醒「这项填什么、去哪拿」。
    description: Mapped[str] = mapped_column(String, nullable=False, server_default="")


# ── Pydantic Schemas ───────────────────────────────────────────────────────────

from pydantic import BaseModel  # noqa: E402


class AppSettingAdminRead(BaseModel):
    """管理后台配置列表响应。value 敏感项会在路由层脱敏后再放进这个字段，不在此处理。"""
    model_config = {"from_attributes": True}

    key: str
    value: str
    category: str
    is_secret: bool
    description: str


class AppSettingAdminUpdate(BaseModel):
    """PATCH /api/admin/settings/{key} 的请求体：只能改 value（对齐 admin.py 的 form_columns）。"""
    value: str

