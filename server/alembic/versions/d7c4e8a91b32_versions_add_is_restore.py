"""versions 增加 is_restore，禁止回滚记录再次回滚

Revision ID: d7c4e8a91b32
Revises: 3f6b92c1d8a4
Create Date: 2026-07-27

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d7c4e8a91b32"
down_revision: Union[str, Sequence[str], None] = "3f6b92c1d8a4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("versions", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("is_restore", sa.Boolean(), server_default="0", nullable=False)
        )

    # 上线前已存在的回滚版本没有结构化标记，只能依据系统生成的固定摘要回填。
    op.execute(
        sa.text(
            "UPDATE versions SET is_restore = 1 "
            "WHERE summary LIKE '回滚到 v%'"
        )
    )


def downgrade() -> None:
    with op.batch_alter_table("versions", schema=None) as batch_op:
        batch_op.drop_column("is_restore")
