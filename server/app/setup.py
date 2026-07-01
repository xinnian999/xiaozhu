"""系统初始化向导（首次部署用）。

问题背景：运营配置（模型 api_key/base_url、SMTP、爱发电）已从 .env 搬进数据库，
.env 现在只剩 JWT_SECRET。全新部署时库是空的、也还没有管理员 —— 鸡生蛋。
这个一次性向导解决它：首次访问自动引导「创建首个管理员 + 填运营配置」，完成即自锁。

「是否已初始化」的判定：库里是否存在 is_admin=True 的用户。
  - 一旦建了首个管理员，就算初始化完成 —— 不需要额外的标志位，天然自锁。
  - 用模块级缓存 _initialized 避免每次请求都查库；建成首个管理员后置 True。

安全：POST /setup 会在处理前再查一次库（不只信缓存），已初始化就 409 拒绝，
杜绝「初始化完成后有人再 POST 抢建管理员」。
"""

import html

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import llm, runtime_config
from app.db import get_db
from app.llm import SEED_MODELS
from app.mock_profile import random_avatar_seed, random_nickname
from app.models.llm_config import LlmModel
from app.models.user import User
from app.security import hash_password

router = APIRouter(tags=["setup"])

# 模块级缓存：None=还没查过，True/False=查过的结果。
# 建成首个管理员后置 True，之后 is_initialized 直接返回、不再查库。
_initialized: bool | None = None


async def is_initialized(db: AsyncSession) -> bool:
    """系统是否已初始化 = 是否已存在任一管理员。带内存缓存。"""
    global _initialized
    if _initialized:
        return True
    # 缓存为 None / False 时查库（False 也要查：可能刚被别的进程初始化了）
    exists = (
        await db.execute(select(User.id).where(User.is_admin.is_(True)).limit(1))
    ).first() is not None
    _initialized = exists
    return exists


def mark_initialized() -> None:
    """建成首个管理员后调用，把缓存钉成已初始化。"""
    global _initialized
    _initialized = True


def is_initialized_cached() -> bool:
    """只读内存缓存、不查库。给请求热路径用（已初始化后每次请求都会问一下）。
    返回 True 仅当确定已初始化；None/False 都返回 False，交给调用方再走 is_initialized 查库。
    """
    return _initialized is True


# ── 向导页 HTML（内联，避免为一次性页面新建模板文件）──────────────────────────
def _render_form(error: str = "") -> str:
    """渲染初始化向导表单。error 非空时在顶部显示红色错误条。"""
    # 每个 seed 模型一行：模型名（只读展示）+ 该模型的 api_key 输入框。
    # base_url 所有模型共用一个全局输入（绝大多数情况一个中转地址；需要各异可事后进后台改）。
    model_rows = "".join(
        f"""
        <div class="model-row">
          <span class="model-name">{html.escape(m['name'])}</span>
          <input name="apikey__{html.escape(m['id'])}" type="text"
                 placeholder="该模型的 API Key" required>
        </div>"""
        for m in SEED_MODELS
    )
    err_html = f'<div class="err">{html.escape(error)}</div>' if error else ""
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>小筑 · 系统初始化</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ margin:0; font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
         background:#f5f5f7; color:#1d1d1f; }}
  .wrap {{ max-width:560px; margin:40px auto; padding:0 20px; }}
  h1 {{ font-size:24px; margin:0 0 4px; }}
  .sub {{ color:#86868b; font-size:14px; margin:0 0 24px; }}
  .card {{ background:#fff; border-radius:14px; padding:24px; box-shadow:0 1px 3px rgba(0,0,0,.08); margin-bottom:16px; }}
  .card h2 {{ font-size:15px; margin:0 0 4px; }}
  .card .hint {{ color:#86868b; font-size:12px; margin:0 0 16px; }}
  label {{ display:block; font-size:13px; margin:12px 0 4px; color:#424245; }}
  input {{ width:100%; padding:9px 12px; border:1px solid #d2d2d7; border-radius:8px; font-size:14px; }}
  input:focus {{ outline:none; border-color:#0071e3; }}
  .model-row {{ display:flex; align-items:center; gap:12px; margin:10px 0; }}
  .model-row .model-name {{ flex:0 0 150px; font-size:13px; color:#1d1d1f; }}
  .model-row input {{ flex:1; margin:0; }}
  .row2 {{ display:flex; gap:12px; }}
  .row2 > div {{ flex:1; }}
  button {{ width:100%; padding:12px; background:#0071e3; color:#fff; border:0; border-radius:10px;
           font-size:15px; cursor:pointer; margin-top:8px; }}
  button:hover {{ background:#0077ed; }}
  .err {{ background:#fde8e8; color:#c53030; padding:10px 14px; border-radius:8px; font-size:13px; margin-bottom:16px; }}
  .optional {{ color:#86868b; font-weight:normal; font-size:12px; }}
</style>
</head>
<body>
<div class="wrap">
  <h1>欢迎使用小筑</h1>
  <p class="sub">首次启动，请创建管理员并填写运营配置。完成后本页自动关闭。</p>
  {err_html}
  <form method="POST" action="/setup" autocomplete="off">

    <div class="card">
      <h2>管理员账号</h2>
      <p class="hint">用于登录管理后台 /admin。请牢记密码。</p>
      <label>邮箱</label>
      <input name="admin_email" type="email" placeholder="you@example.com" required>
      <label>密码</label>
      <input name="admin_password" type="password" placeholder="至少 6 位" minlength="6" required>
    </div>

    <div class="card">
      <h2>模型接入</h2>
      <p class="hint">中转站地址所有模型共用；每个模型填各自的 API Key。之后可在后台增删改。</p>
      <label>中转 Base URL</label>
      <input name="base_url" type="text" placeholder="https://your-proxy.example.com/v1" required>
      {model_rows}
    </div>

    <div class="card">
      <h2>邮件 SMTP <span class="optional">（选填，用于发注册验证码，可稍后在后台配）</span></h2>
      <div class="row2">
        <div><label>SMTP 服务器</label><input name="smtp_host" placeholder="smtp.qq.com"></div>
        <div><label>端口</label><input name="smtp_port" placeholder="465"></div>
      </div>
      <label>发信邮箱</label>
      <input name="smtp_user" placeholder="you@qq.com">
      <label>授权码（不是登录密码）</label>
      <input name="smtp_password" type="password">
      <label>发件人显示名</label>
      <input name="smtp_from_name" placeholder="小筑">
    </div>

    <button type="submit">完成初始化并进入后台</button>
  </form>
</div>
</body>
</html>"""


@router.get("/setup", response_class=HTMLResponse)
async def setup_page(db: AsyncSession = Depends(get_db)):
    """向导页。已初始化则不再展示，直接跳登录（自锁）。"""
    if await is_initialized(db):
        return RedirectResponse("/admin/login", status_code=302)
    return HTMLResponse(_render_form())


@router.post("/setup")
async def setup_submit(
    request: Request,
    admin_email: str = Form(...),
    admin_password: str = Form(...),
    base_url: str = Form(...),
    smtp_host: str = Form(""),
    smtp_port: str = Form(""),
    smtp_user: str = Form(""),
    smtp_password: str = Form(""),
    smtp_from_name: str = Form(""),
    db: AsyncSession = Depends(get_db),
):
    """处理初始化提交：建首个管理员 + 写模型 key/base_url + 写 SMTP。全部在一个事务里。

    再次校验「未初始化」——不只信缓存，防止已初始化后有人重复 POST 抢建管理员。
    """
    # 防重复：已初始化直接回登录页（自锁）
    if await is_initialized(db):
        return RedirectResponse("/admin/login", status_code=302)

    # 基本校验
    email = admin_email.strip().lower()
    if len(admin_password) < 6:
        return HTMLResponse(_render_form("密码至少 6 位"), status_code=400)

    # 各模型的 api_key 从 apikey__<模型id> 字段取（见 _render_form）
    form = await request.form()
    model_keys = {m["id"]: str(form.get(f"apikey__{m['id']}", "")).strip() for m in SEED_MODELS}
    if any(not k for k in model_keys.values()):
        return HTMLResponse(_render_form("请为每个模型填写 API Key"), status_code=400)
    if not base_url.strip():
        return HTMLResponse(_render_form("请填写中转 Base URL"), status_code=400)

    # ── 一个事务里落库 ──
    # 1) 首个管理员
    db.add(
        User(
            email=email,
            password_hash=hash_password(admin_password),
            nickname=random_nickname(),
            avatar=random_avatar_seed(),
            is_admin=True,
        )
    )
    # 2) 模型：写 base_url + api_key（模型行本身由 llm.ensure_seeded 已在启动时建好）
    for mid, key in model_keys.items():
        m = (await db.execute(select(LlmModel).where(LlmModel.id == mid))).scalar_one_or_none()
        if m is not None:
            m.base_url = base_url.strip()
            m.api_key = key
    # 3) SMTP（选填）：只写非空项，复用 runtime_config 的 upsert 语义
    smtp_values = {
        "smtp_host": smtp_host.strip(),
        "smtp_port": smtp_port.strip(),
        "smtp_user": smtp_user.strip(),
        "smtp_password": smtp_password.strip(),
        "smtp_from_name": smtp_from_name.strip(),
    }
    await _upsert_settings(db, {k: v for k, v in smtp_values.items() if v})

    await db.commit()

    # 落库成功：钉缓存为已初始化，刷新模型注册表与配置缓存，让新 key 立即生效
    mark_initialized()
    await llm.refresh()
    await runtime_config.refresh()

    return RedirectResponse("/admin/login", status_code=302)


async def _upsert_settings(db: AsyncSession, values: dict[str, str]) -> None:
    """把若干 app_settings 项写库（存在则改、不存在则新建）。

    首次启动 runtime_config.ensure_seeded 已按 SETTING_DEFS 建好所有行（值多为空），
    所以这里基本都是「改已存在行的值」；用 upsert 兜底新建更稳妥。
    """
    from app.models.app_setting import AppSetting

    for key, value in values.items():
        row = await db.get(AppSetting, key)
        if row is not None:
            row.value = value
        else:
            db.add(AppSetting(key=key, value=value))
