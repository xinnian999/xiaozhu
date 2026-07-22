"""llm_models 增加 provider，并迁移官方厂商配置

Revision ID: 8e7b4f1c2d90
Revises: 122ab191c2b1
Create Date: 2026-07-22

"""

from typing import Sequence, Union
from urllib.parse import urlparse

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = "8e7b4f1c2d90"
down_revision: Union[str, Sequence[str], None] = "122ab191c2b1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_PROVIDER_LOGOS = {
    "openai": "OpenAI",
    "anthropic": "Claude.Color",
    "google": "Gemini.Color",
    "deepseek": "DeepSeek.Color",
    "qwen": "Qwen.Color",
    "moonshot": "Moonshot",
    "doubao": "Doubao.Color",
    "zhipu": "Zhipu.Color",
    "minimax": "Minimax.Color",
    "xai": "Grok",
    "custom_openai": "OpenAI",
}

_OFFICIAL_DOMAINS = (
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
    ("volces.com", "doubao"),
    ("bigmodel.cn", "zhipu"),
    ("api.minimaxi.com", "minimax"),
    ("api.minimax.io", "minimax"),
    ("minimax.chat", "minimax"),
    ("api.x.ai", "xai"),
)


def _infer_provider(base_url: str | None) -> str:
    """只按官方 API 域名判断；模型名和自定义中转域名都不参与推断。"""
    if not base_url:
        return "openai"
    try:
        candidate = base_url.strip()
        if not candidate:
            return "openai"
        parsed = urlparse(candidate if "://" in candidate else f"//{candidate}")
        host = (parsed.hostname or "").lower().rstrip(".")
    except ValueError:
        return "custom_openai"
    for domain, provider in _OFFICIAL_DOMAINS:
        if host == domain or host.endswith(f".{domain}"):
            return provider
    return "custom_openai"


def _minimax_anthropic_base_url(base_url: str | None) -> str:
    """MiniMax API Key 分区域生效，迁移时必须保留原来的国际/中国站。"""
    try:
        candidate = (base_url or "").strip()
        parsed = urlparse(candidate if "://" in candidate else f"//{candidate}")
        host = (parsed.hostname or "").lower().rstrip(".")
    except ValueError:
        host = ""
    if host == "api.minimax.io" or host.endswith(".api.minimax.io"):
        return "https://api.minimax.io/anthropic"
    return "https://api.minimaxi.com/anthropic"


def upgrade() -> None:
    """增加 provider，并让现有记录的 provider/logo 收敛到厂商目录。"""
    op.add_column(
        "llm_models",
        sa.Column(
            "provider",
            sa.String(),
            server_default="custom_openai",
            nullable=False,
        ),
    )

    models = sa.table(
        "llm_models",
        sa.column("id", sa.String()),
        sa.column("base_url", sa.String()),
        sa.column("provider", sa.String()),
        sa.column("logo", sa.String()),
    )
    connection = op.get_bind()
    rows = connection.execute(sa.select(models.c.id, models.c.base_url)).mappings()
    for row in rows:
        provider = _infer_provider(row["base_url"])
        base_url = row["base_url"]
        if provider == "minimax":
            # 新适配器按官方推荐走 Anthropic 协议，同时保留 API Key 所属区域。
            base_url = _minimax_anthropic_base_url(base_url)
        connection.execute(
            models.update()
            .where(models.c.id == row["id"])
            .values(
                provider=provider,
                logo=_PROVIDER_LOGOS[provider],
                base_url=base_url,
            )
        )


def downgrade() -> None:
    """移除 provider；logo 保留迁移后的厂商图标。"""
    with op.batch_alter_table("llm_models", schema=None) as batch_op:
        batch_op.drop_column("provider")
