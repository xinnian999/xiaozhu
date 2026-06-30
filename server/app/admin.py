"""管理后台（SQLAdmin）装配 —— 鉴权 + 各表视图。

结构：
  - AdminAuth：登录鉴权后端。复用现有用户体系，只放行 is_admin=True 的账号。
  - 各 *Admin(ModelView)：一张表一个视图，声明「列表显示哪些列、能否增删改、敏感列脱敏」。
  - setup_admin()：把上面这些装到 FastAPI app 上。

敏感列（api_key / 密钥类配置）在列表 / 详情用 _mask 脱敏显示，避免肩窥泄露。
改动「配置 / 模型 / 分组」后，对应视图的钩子会刷新内存缓存，让改动即时生效。
"""

from pathlib import Path

from sqladmin import Admin, ModelView, action
from sqladmin.authentication import AuthenticationBackend
from sqlalchemy import select, update
from starlette.requests import Request
from starlette.responses import RedirectResponse

from app import llm, runtime_config
from app.config import settings
from app.db import AsyncSessionLocal, engine
from app.models.app_setting import AppSetting
from app.models.email_code import EmailCode
from app.models.llm_config import LlmModel
from app.models.order import Order
from app.models.session import Session
from app.models.user import User
from app.security import verify_password


def _mask(value: str | None) -> str:
    """把密钥脱敏成「头3 + *** + 尾3」。短值直接全遮。空值原样返回。"""
    if not value:
        return ""
    if len(value) <= 8:
        return "***"
    return f"{value[:3]}***{value[-3:]}"


# ── 登录鉴权后端 ──────────────────────────────────────────────────────────────
class AdminAuth(AuthenticationBackend):
    """SQLAdmin 的鉴权后端：复用用户表的邮箱 + 密码登录，且必须是管理员。

    三个钩子：
      login        —— 处理登录表单：校验邮箱密码 + is_admin，通过则把 user_id 写进 session。
      logout       —— 清空 session。
      authenticate —— 每次访问后台页面前调用：没登录 / 已不是管理员都拒绝（跳回登录页）。

    session 由 AuthenticationBackend(secret_key) 启用的 SessionMiddleware 提供，
    secret_key 复用 JWT_SECRET（已是必填的强随机值），不另设密钥。
    """

    async def login(self, request: Request) -> bool:
        form = await request.form()
        email = str(form.get("username", "")).strip()  # 登录框的 username 即邮箱
        password = str(form.get("password", ""))

        async with AsyncSessionLocal() as db:
            user = (
                await db.execute(select(User).where(User.email == email))
            ).scalar_one_or_none()

        # 用户不存在 / 密码错 / 不是管理员，统一失败（不区分原因，少泄露信息）
        if user is None or not verify_password(password, user.password_hash) or not user.is_admin:
            return False

        request.session["user_id"] = user.id
        return True

    async def logout(self, request: Request) -> bool:
        request.session.clear()
        return True

    async def authenticate(self, request: Request) -> bool:
        user_id = request.session.get("user_id")
        if not user_id:
            return False
        # 不只信 session：再查一次库，确认账号还在、且仍是管理员（可能已被取消管理员 / 删号）
        async with AsyncSessionLocal() as db:
            user = await db.get(User, user_id)
        return user is not None and user.is_admin


# ── 各表视图 ──────────────────────────────────────────────────────────────────
class UserAdmin(ModelView, model=User):
    name = "用户"
    name_plural = "用户"
    icon = "fa-solid fa-user"
    # 列表展示的列。password_hash 绝不列出。
    column_list = [
        User.email, User.nickname, User.tier, User.daily_used,
        User.tier_expires_at, User.is_admin, User.created_at,
    ]
    column_searchable_list = [User.email, User.nickname]
    column_sortable_list = [User.created_at, User.tier, User.daily_used]
    # 用户由前台注册（要走邮箱验证码 + 密码哈希），后台不新建（否则密码哈希为空会出错）。
    can_create = False
    # 编辑表单：允许改档位 / 额度 / 到期 / 管理员标记，但不让在这里碰密码哈希。
    form_columns = [
        User.email, User.nickname, User.tier, User.daily_used,
        User.daily_date, User.tier_expires_at, User.is_admin,
    ]
    column_labels = {
        User.email: "邮箱", User.nickname: "昵称", User.tier: "档位",
        User.daily_used: "今日已用", User.daily_date: "用量日期",
        User.tier_expires_at: "到期时间", User.is_admin: "管理员", User.created_at: "注册时间",
    }


class OrderAdmin(ModelView, model=Order):
    name = "订单"
    name_plural = "订单"
    icon = "fa-solid fa-receipt"
    column_list = [Order.id, Order.user_id, Order.tier, Order.amount, Order.status, Order.created_at, Order.paid_at]
    column_sortable_list = [Order.created_at, Order.status]
    # 订单是支付流水，只读：不允许在后台增改删，避免破坏对账。
    can_create = False
    can_edit = False
    can_delete = False


class SessionAdmin(ModelView, model=Session):
    name = "会话"
    name_plural = "会话"
    icon = "fa-solid fa-comments"
    column_list = [Session.id, Session.user_id, Session.title, Session.created_at, Session.updated_at]
    column_sortable_list = [Session.created_at, Session.updated_at]
    can_create = False
    can_edit = False  # 会话内容由生成流程写，后台只看 / 删（清理用）


class EmailCodeAdmin(ModelView, model=EmailCode):
    name = "邮箱验证码"
    name_plural = "邮箱验证码"
    icon = "fa-solid fa-envelope"
    column_list = [EmailCode.email, EmailCode.code, EmailCode.attempts, EmailCode.expires_at, EmailCode.sent_at]
    column_sortable_list = [EmailCode.sent_at, EmailCode.expires_at]
    can_create = False
    can_edit = False  # 验证码由发码流程写，后台只看 / 删（排障用）


class AppSettingAdmin(ModelView, model=AppSetting):
    name = "应用配置"
    name_plural = "应用配置"
    icon = "fa-solid fa-gear"
    column_list = [AppSetting.key, AppSetting.value, AppSetting.category, AppSetting.is_secret, AppSetting.description]
    column_labels = {
        AppSetting.key: "键", AppSetting.value: "值", AppSetting.category: "分类",
        AppSetting.is_secret: "敏感", AppSetting.description: "说明",
    }
    # 配置项由首次启动种子建好；后台只改「值」，不增删、不改 key/分类/说明。
    can_create = False
    can_delete = False
    form_columns = [AppSetting.value]
    # 敏感项（密钥）在列表 / 详情脱敏显示。column_formatters 的函数签名是 (model, attribute)。
    column_formatters = {
        AppSetting.value: lambda m, a: _mask(m.value) if m.is_secret else m.value,
    }
    column_formatters_detail = {
        AppSetting.value: lambda m, a: _mask(m.value) if m.is_secret else m.value,
    }

    async def after_model_change(self, data, model, is_created, request) -> None:
        # 改完配置刷新内存缓存，让 cfg.* 立刻读到新值（不必重启）。
        await runtime_config.refresh()


class LlmModelAdmin(ModelView, model=LlmModel):
    name = "模型"
    name_plural = "模型"
    icon = "fa-solid fa-robot"
    column_list = [
        LlmModel.sort_order, LlmModel.id, LlmModel.name, LlmModel.base_url,
        LlmModel.api_key, LlmModel.logo, LlmModel.vision, LlmModel.cost, LlmModel.enabled,
    ]
    column_sortable_list = [LlmModel.sort_order, LlmModel.cost]
    # id 是主键、要手填模型名，必须出现在新建表单里（sqladmin 默认隐藏主键）。
    form_include_pk = True
    form_columns = [
        LlmModel.id, LlmModel.name, LlmModel.base_url, LlmModel.api_key,
        LlmModel.logo, LlmModel.vision, LlmModel.cost, LlmModel.enabled, LlmModel.sort_order,
    ]
    column_labels = {
        LlmModel.id: "模型 ID", LlmModel.name: "显示名",
        LlmModel.base_url: "Base URL（空=官方）", LlmModel.api_key: "API Key",
        LlmModel.logo: "Logo 标识", LlmModel.vision: "识图",
        LlmModel.cost: "倍率", LlmModel.enabled: "启用", LlmModel.sort_order: "排序",
    }
    # api_key 列表 / 详情脱敏（编辑表单里仍是明文，方便粘贴新值）。
    column_formatters = {LlmModel.api_key: lambda m, a: _mask(m.api_key)}
    column_formatters_detail = {LlmModel.api_key: lambda m, a: _mask(m.api_key)}

    async def after_model_change(self, data, model, is_created, request) -> None:
        await llm.refresh()

    async def after_model_delete(self, model, request) -> None:
        await llm.refresh()

    # ── 一键启用 / 禁用（批量操作）────────────────────────────────────────────
    # @action 会在「列表页的批量操作下拉」和「详情页」各加一个按钮：
    #   - 列表页：先勾选若干模型，再点按钮 → 对所选批量启停；
    #   - 详情页：点按钮 → 对当前这一个启停。
    # 选中的主键由 sqladmin 以 query 参数 pks（逗号分隔）传进来。
    async def _set_enabled(self, request: Request, value: bool) -> RedirectResponse:
        """把所选模型的 enabled 批量改成 value，再刷新内存注册表，最后跳回原页面。"""
        pks = request.query_params.get("pks", "")
        ids = [p for p in pks.split(",") if p]
        if ids:
            async with AsyncSessionLocal() as db:
                await db.execute(
                    update(LlmModel).where(LlmModel.id.in_(ids)).values(enabled=value)
                )
                await db.commit()
            await llm.refresh()  # 让 /api/models 立刻反映启停结果
        # 跳回来源页（保留筛选/分页）；没有 referer 就回列表页
        referer = request.headers.get("referer")
        return RedirectResponse(referer or request.url_for("admin:list", identity=self.identity))

    @action(name="enable", label="启用所选")
    async def enable_selected(self, request: Request) -> RedirectResponse:
        return await self._set_enabled(request, True)

    @action(name="disable", label="禁用所选")
    async def disable_selected(self, request: Request) -> RedirectResponse:
        return await self._set_enabled(request, False)


def setup_admin(app) -> Admin:
    """把 SQLAdmin（含鉴权与各表视图）挂到 FastAPI app 上。"""
    authentication_backend = AdminAuth(secret_key=settings.jwt_secret)
    # templates_dir 指向本目录下的 admin_templates：放了一套汉化版同名模板。
    # SQLAdmin 用 ChoiceLoader（先找这个目录、再回退包内模板），所以只需覆盖含英文的几个，
    # 其余自动用原版。用绝对路径，避免受 uvicorn 启动时工作目录影响。
    templates_dir = str(Path(__file__).resolve().parent / "admin_templates")
    admin = Admin(
        app,
        engine,
        title="小筑 管理后台",
        authentication_backend=authentication_backend,
        templates_dir=templates_dir,
    )
    for view in (
        UserAdmin, OrderAdmin, SessionAdmin, EmailCodeAdmin,
        AppSettingAdmin, LlmModelAdmin,
    ):
        admin.add_view(view)
    return admin
