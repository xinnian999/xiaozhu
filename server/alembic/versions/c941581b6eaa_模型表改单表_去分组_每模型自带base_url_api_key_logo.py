"""模型表改单表:去分组,每模型自带base_url/api_key/logo

Revision ID: c941581b6eaa
Revises: 4b247f0ab0a1
Create Date: 2026-06-30 16:39:46.915369

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c941581b6eaa'
down_revision: Union[str, Sequence[str], None] = '4b247f0ab0a1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    模型配置从「分组表 + 模型表」改为单张 llm_models 表，每个模型自带 base_url / api_key / logo。
    旧表里只有可丢弃的种子数据（启动时会从 .env 重新播种），所以直接 drop 旧的两张表、
    重建新的 llm_models，比逐列改名/加列（非空列加列还要塞默认值）干净得多。
    顺带删掉 app_settings 里已废弃的 openai_base_url 行（base_url 现在落在每个模型上）。
    """
    op.drop_table("llm_models")
    op.drop_table("llm_groups")
    op.create_table(
        "llm_models",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("base_url", sa.String(), nullable=True),
        sa.Column("api_key", sa.String(), server_default="", nullable=False),
        sa.Column("logo", sa.String(), server_default="", nullable=False),
        sa.Column("vision", sa.Boolean(), server_default="0", nullable=False),
        sa.Column("cost", sa.Integer(), server_default="1", nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default="1", nullable=False),
        sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    # 删除已废弃的全局 base_url 配置项（若存在）
    op.execute("DELETE FROM app_settings WHERE key = 'openai_base_url'")


def downgrade() -> None:
    """Downgrade schema：回到「分组表 + 模型表」结构（数据不还原，靠重新播种）。"""
    op.drop_table("llm_models")
    op.create_table(
        "llm_groups",
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("api_key", sa.String(), server_default="", nullable=False),
        sa.Column("base_url", sa.String(), nullable=True),
        sa.Column("icon", sa.String(), server_default="", nullable=False),
        sa.PrimaryKeyConstraint("name"),
    )
    op.create_table(
        "llm_models",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("group_name", sa.String(), nullable=False),
        sa.Column("vision", sa.Boolean(), server_default="0", nullable=False),
        sa.Column("cost", sa.Integer(), server_default="1", nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default="1", nullable=False),
        sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
        sa.ForeignKeyConstraint(["group_name"], ["llm_groups.name"]),
        sa.PrimaryKeyConstraint("id"),
    )
