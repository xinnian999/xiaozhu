"""llm_models 增加自动探测的识图与思考能力

Revision ID: 3f6b92c1d8a4
Revises: 8e7b4f1c2d90
Create Date: 2026-07-23

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = "3f6b92c1d8a4"
down_revision: Union[str, Sequence[str], None] = "8e7b4f1c2d90"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """保存能力探测结果；已有 vision=true 视作已支持，其余等待重新探测。"""
    with op.batch_alter_table("llm_models", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("thinking", sa.Boolean(), server_default="0", nullable=False)
        )
        batch_op.add_column(
            sa.Column(
                "thinking_toggle", sa.Boolean(), server_default="0", nullable=False
            )
        )
        batch_op.add_column(
            sa.Column(
                "vision_status",
                sa.String(),
                server_default="unknown",
                nullable=False,
            )
        )
        batch_op.add_column(
            sa.Column(
                "thinking_status",
                sa.String(),
                server_default="unknown",
                nullable=False,
            )
        )

    # 历史 vision=true 通常来自既有实测配置，平滑保留；false 无法区分未测与不支持，
    # 统一保留 unknown，等下一次全面测试给出真实结论。
    op.execute(
        sa.text(
            "UPDATE llm_models SET vision_status = 'supported' WHERE vision = 1"
        )
    )


def downgrade() -> None:
    """移除自动探测元数据，保留原有 vision 布尔列。"""
    with op.batch_alter_table("llm_models", schema=None) as batch_op:
        batch_op.drop_column("thinking_status")
        batch_op.drop_column("vision_status")
        batch_op.drop_column("thinking_toggle")
        batch_op.drop_column("thinking")
