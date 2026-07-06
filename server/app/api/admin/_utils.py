"""管理后台专用的小工具函数 —— 目前只有敏感值脱敏。

从 admin.py 挪出来独立成模块：admin.py（SQLAdmin 方案）迁移完成后会被整个删除，
新的 /api/admin/* 不应该依赖它。
"""


def mask_secret(value: str | None) -> str:
    """把密钥脱敏成「头3 + *** + 尾3」。短值直接全遮。空值原样返回。"""
    if not value:
        return ""
    if len(value) <= 8:
        return "***"
    return f"{value[:3]}***{value[-3:]}"
