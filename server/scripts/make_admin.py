"""把某个已注册用户设为 / 取消管理员。

为什么用脚本而不在界面里自助升管理员：自助升级 = 任何登录用户都能给自己提权，
是典型的越权漏洞。管理员只能由「能登服务器执行命令的人」来指定，这才安全。

用法（在 server/ 目录）：
    uv run python -m scripts.make_admin you@example.com          # 设为管理员
    uv run python -m scripts.make_admin you@example.com --revoke # 取消管理员
"""

import argparse
import asyncio

from sqlalchemy import select

from app.db import AsyncSessionLocal
from app.models.user import User


async def main() -> None:
    parser = argparse.ArgumentParser(description="设置 / 取消用户的管理员身份")
    parser.add_argument("email", help="目标用户的邮箱")
    parser.add_argument("--revoke", action="store_true", help="取消管理员（默认是设为管理员）")
    args = parser.parse_args()

    async with AsyncSessionLocal() as db:
        user = (
            await db.execute(select(User).where(User.email == args.email))
        ).scalar_one_or_none()
        if user is None:
            print(f"❌ 没找到邮箱为 {args.email} 的用户（先在前台注册这个账号）")
            return
        user.is_admin = not args.revoke
        await db.commit()
        state = "管理员" if user.is_admin else "普通用户"
        print(f"✅ 已把 {args.email} 设为「{state}」")


if __name__ == "__main__":
    asyncio.run(main())
