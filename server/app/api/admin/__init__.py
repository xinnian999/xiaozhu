"""管理员后台 API 汇总 —— 汇总各子模块的 router，统一挂 get_current_admin 门槛。

对外只暴露一个 router（prefix="/api/admin"），main.py 只需 include 这一个。
子模块（users/orders/sessions/email_codes/settings/models）各自只关心业务逻辑，
鉴权统一在这里通过 dependencies 挂上，子模块内的接口函数不用重复写。
"""

from fastapi import APIRouter, Depends

from app.deps import get_current_admin

from . import boot_failures, email_codes, models, orders, sessions, settings, users

router = APIRouter(
    prefix="/api/admin",
    tags=["admin"],
    dependencies=[Depends(get_current_admin)],
)

router.include_router(users.router)
router.include_router(orders.router)
router.include_router(sessions.router)
router.include_router(email_codes.router)
router.include_router(settings.router)
router.include_router(models.router)
router.include_router(boot_failures.router)
