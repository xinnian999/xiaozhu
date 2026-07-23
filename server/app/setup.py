"""系统初始化向导（首次部署用）。

问题背景：运营配置（模型 api_key/base_url、SMTP、收款）已从 .env 搬进数据库，
.env 现在只剩 JWT_SECRET。全新部署时库是空的、也还没有管理员 —— 鸡生蛋。
这个一次性向导解决它：首次访问自动引导「创建首个管理员 + 填运营配置」，完成即自锁。

「是否已初始化」的判定：库里是否存在 is_admin=True 的用户。
  - 一旦建了首个管理员，就算初始化完成 —— 不需要额外的标志位，天然自锁。
  - 用模块级缓存 _initialized 避免每次请求都查库；建成首个管理员后置 True。

安全：POST /setup 会在处理前再查一次库（不只信缓存），已初始化就 409 拒绝，
杜绝「初始化完成后有人再 POST 抢建管理员」。
"""

import html
import json

from fastapi import APIRouter, Depends, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import llm, runtime_config
from app.db import get_db
from app.mock_profile import random_avatar_seed, random_nickname
from app.model_providers import canonical_model_values, provider_catalog
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
def _render_form(
    error: str = "",
    *,
    form_values: dict[str, str] | None = None,
    model_rows: list[dict] | None = None,
) -> str:
    """渲染初始化向导表单。error 非空时在顶部显示红色错误条。

    模型区是「动态手填」：默认一行，可增删。每行手填全部字段
    （厂商 / 模型 ID / Base URL / API Key / 识图 / 倍率）。Logo 由厂商自动派生。
    提交时前端把所有行序列化成一个隐藏字段 models(JSON)，后端解析入库。

    ``form_values`` / ``model_rows`` 只接收本次 POST 的原始输入，用于校验失败时
    原样恢复表单；不会读取或回显数据库里已有的密码、API Key。
    """
    values = form_values or {}

    def field_value(name: str) -> str:
        return html.escape(values.get(name, ""), quote=True)

    # JSON 放进内联脚本前转义 HTML/script 边界字符，避免模型 ID 等输入截断脚本。
    initial_models_json = json.dumps(
        model_rows or [], ensure_ascii=False, separators=(",", ":")
    )
    initial_models_json = (
        initial_models_json.replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )
    err_html = f'<div class="err">{html.escape(error)}</div>' if error else ""
    provider_options = "".join(
        (
            f'<option value="{html.escape(item["id"], quote=True)}" '
            f'data-base-url="{html.escape(item["default_base_url"] or "", quote=True)}" '
            f'data-description="{html.escape(item["description"], quote=True)}"'
            f"{' selected' if item['id'] == 'openai' else ''}>"
            f"{html.escape(item['label'])}</option>"
        )
        for item in provider_catalog()
    )
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
  .wrap {{ max-width:600px; margin:40px auto; padding:0 20px; }}
  h1 {{ font-size:24px; margin:0 0 4px; }}
  .sub {{ color:#86868b; font-size:14px; margin:0 0 24px; }}
  .card {{ background:#fff; border-radius:14px; padding:24px; box-shadow:0 1px 3px rgba(0,0,0,.08); margin-bottom:16px; }}
  .card h2 {{ font-size:15px; margin:0 0 4px; }}
  .card .hint {{ color:#86868b; font-size:12px; margin:0 0 16px; }}
  label {{ display:block; font-size:13px; margin:12px 0 4px; color:#424245; }}
  input, select {{ width:100%; padding:9px 12px; border:1px solid #d2d2d7; border-radius:8px; font-size:14px; background:#fff; }}
  input:focus, select:focus {{ outline:none; border-color:#0071e3; }}
  .model-card {{ border:1px solid #e5e5ea; border-radius:10px; padding:14px; margin:10px 0; background:#fafafa; position:relative; }}
  .model-card .mc-head {{ display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }}
  .model-card .mc-idx {{ font-size:13px; font-weight:600; color:#1d1d1f; }}
  .model-card .mc-del {{ width:auto; margin:0; padding:4px 10px; background:#fff; color:#c53030;
                         border:1px solid #f0c0c0; border-radius:7px; font-size:12px; cursor:pointer; }}
  .model-card .mc-del:hover {{ background:#fde8e8; }}
  .model-card input, .model-card select {{ margin-bottom:8px; }}
  .model-card .provider-hint {{ min-height:17px; margin:-2px 0 8px; color:#86868b; font-size:12px; line-height:1.4; }}
  .row2 {{ display:flex; gap:12px; }}
  .row2 > div {{ flex:1; }}
  .row2 label {{ margin-top:0; }}
  .chk {{ display:flex; align-items:center; gap:8px; font-size:13px; color:#424245; margin:4px 0 0; }}
  .chk input {{ width:auto; margin:0; }}
  .add-btn {{ width:100%; padding:10px; background:#fff; color:#0071e3; border:1px dashed #0071e3;
             border-radius:10px; font-size:14px; cursor:pointer; margin-top:6px; }}
  .add-btn:hover {{ background:#f0f7ff; }}
  button.submit {{ width:100%; padding:12px; background:#0071e3; color:#fff; border:0; border-radius:10px;
           font-size:15px; cursor:pointer; margin-top:8px; }}
  button.submit:hover {{ background:#0077ed; }}
  .err {{ background:#fde8e8; color:#c53030; padding:10px 14px; border-radius:8px; font-size:13px; margin-bottom:16px; }}
  .optional {{ color:#86868b; font-weight:normal; font-size:12px; }}
</style>
</head>
<body>
<div class="wrap">
  <h1>欢迎使用小筑</h1>
  <p class="sub">首次启动，请创建管理员并填写运营配置。完成后本页自动关闭。</p>
  {err_html}
  <form method="POST" action="/setup" autocomplete="off" id="setup-form">

    <div class="card">
      <h2>管理员账号</h2>
      <p class="hint">用于登录管理后台 /admin。请牢记密码。</p>
      <label>邮箱</label>
      <input name="admin_email" type="email" placeholder="you@example.com" value="{field_value("admin_email")}" required>
      <label>密码</label>
      <input name="admin_password" type="password" placeholder="至少 6 位" value="{field_value("admin_password")}" minlength="6" required>
    </div>

    <div class="card">
      <h2>模型接入</h2>
      <p class="hint">选择 API 厂商后会自动匹配 Logo 和默认地址，<b>至少添加一个模型</b>；之后都能在后台增删改。</p>
      <div id="model-list"></div>
      <button type="button" class="add-btn" id="add-model">+ 添加模型</button>
    </div>

    <div class="card">
      <h2>邮件 SMTP <span class="optional">（选填，用于发注册验证码，可稍后在后台配）</span></h2>
      <div class="row2">
        <div><label>SMTP 服务器</label><input name="smtp_host" placeholder="smtp.qq.com" value="{field_value("smtp_host")}"></div>
        <div><label>端口</label><input name="smtp_port" placeholder="465" value="{field_value("smtp_port")}"></div>
      </div>
      <label>发信邮箱</label>
      <input name="smtp_user" placeholder="you@qq.com" value="{field_value("smtp_user")}">
      <label>授权码（不是登录密码）</label>
      <input name="smtp_password" type="password" value="{field_value("smtp_password")}">
      <label>发件人显示名</label>
      <input name="smtp_from_name" placeholder="小筑" value="{field_value("smtp_from_name")}">
    </div>

    <!-- 模型行由 JS 序列化进这里 -->
    <input type="hidden" name="models" id="models-json">
    <button type="submit" class="submit">完成初始化并进入后台</button>
  </form>
</div>

<script>
(function() {{
  var list = document.getElementById('model-list');
  var addBtn = document.getElementById('add-model');
  var form = document.getElementById('setup-form');

  // 渲染一张模型卡。字段用 data-k 标记，提交时据此收集成 JSON。
  function addRow(initial) {{
    var card = document.createElement('div');
    card.className = 'model-card';
    card.innerHTML =
      '<div class="mc-head"><span class="mc-idx">模型</span>' +
      '<button type="button" class="mc-del">删除</button></div>' +
      '<label>模型厂商</label>' +
      '<select data-k="provider">{provider_options}</select>' +
      '<p class="provider-hint"></p>' +
      '<label>模型 ID</label><input data-k="id" placeholder="如 qwen3-coder-next" required>' +
      '<label>Base URL <span class="optional">（官方厂商可使用自动配置）</span></label>' +
      '<input data-k="base_url" placeholder="选择厂商后自动填写；自定义接口请手动填写">' +
      '<label>API Key</label>' +
      '<input data-k="api_key" type="password" placeholder="sk-..." required>' +
      '<div class="row2">' +
        '<div><label>倍率</label><input data-k="cost" type="number" min="1" value="1"></div>' +
      '</div>' +
      '<label class="chk"><input data-k="vision" type="checkbox"> 支持识图（多模态图片输入）</label>';
    var provider = card.querySelector('[data-k="provider"]');
    var baseUrl = card.querySelector('[data-k="base_url"]');
    var providerHint = card.querySelector('.provider-hint');
    if (initial) {{
      card.querySelectorAll('[data-k]').forEach(function(el) {{
        var key = el.getAttribute('data-k');
        if (!(key in initial)) return;
        if (el.type === 'checkbox') {{
          el.checked = initial[key] === true || initial[key] === 'true' || initial[key] === 'on' || initial[key] === 1;
        }} else {{
          el.value = initial[key] == null ? '' : String(initial[key]);
        }}
      }});
      // 旧版 custom_openai 与未知厂商统一并入 OpenAI 兼容协议。
      if (!provider.value) provider.value = 'openai';
    }}
    function applyProviderDefaults(fillEmptyBaseUrl) {{
      var selected = provider.options[provider.selectedIndex];
      if (fillEmptyBaseUrl && !baseUrl.value.trim()) {{
        baseUrl.value = selected.getAttribute('data-base-url') || '';
      }}
      baseUrl.required = false;
      providerHint.textContent = (selected.getAttribute('data-description') || '') + ' · Logo 自动匹配';
    }}
    provider.addEventListener('change', function() {{ applyProviderDefaults(true); }});
    applyProviderDefaults(!initial);
    card.querySelector('.mc-del').onclick = function() {{
      if (list.children.length > 1) card.remove();
    }};
    list.appendChild(card);
  }}

  addBtn.onclick = function() {{ addRow(); }};
  var initialRows = {initial_models_json};
  if (Array.isArray(initialRows) && initialRows.length) {{
    initialRows.forEach(function(row) {{ addRow(row); }});
  }} else {{
    addRow(); // 默认给一行
  }}

  // 提交前把所有卡片收集成 JSON 塞进隐藏字段
  form.addEventListener('submit', function() {{
    var models = [];
    list.querySelectorAll('.model-card').forEach(function(card) {{
      var m = {{}};
      card.querySelectorAll('[data-k]').forEach(function(el) {{
        var k = el.getAttribute('data-k');
        m[k] = el.type === 'checkbox' ? el.checked : el.value.trim();
      }});
      models.push(m);
    }});
    document.getElementById('models-json').value = JSON.stringify(models);
  }});
}})();
</script>
</body>
</html>"""


@router.get("/setup", response_class=HTMLResponse)
async def setup_page(db: AsyncSession = Depends(get_db)):
    """向导页。已初始化则不再展示，直接跳登录（自锁）。"""
    if await is_initialized(db):
        return RedirectResponse("/admin/login", status_code=302)
    return HTMLResponse(_render_form())


@router.get("/api/setup-status")
async def setup_status(db: AsyncSession = Depends(get_db)) -> dict:
    """公开的初始化状态查询。前端首屏调它：未初始化就把用户导去 /setup。

    为什么前端也要查：开发环境下前台 SPA 由 Vite 直接服务、不经过后端的初始化闸门中间件，
    所以后端闸门拦不到前台首页。前端主动查一次、未初始化就跳 /setup —— dev / 生产都稳。
    无需鉴权（此时可能连管理员都还没有）。
    """
    return {"initialized": await is_initialized(db)}


@router.post("/setup")
async def setup_submit(
    admin_email: str = Form(...),
    admin_password: str = Form(...),
    models: str = Form("[]"),
    smtp_host: str = Form(""),
    smtp_port: str = Form(""),
    smtp_user: str = Form(""),
    smtp_password: str = Form(""),
    smtp_from_name: str = Form(""),
    db: AsyncSession = Depends(get_db),
):
    """处理初始化提交：建首个管理员 + 手动创建模型 + 写 SMTP。全部在一个事务里。

    models 是前端序列化的 JSON 数组，每个元素含
    {{provider, id, base_url, api_key, cost, vision}}。逐条 upsert 进 llm_models，
    厂商、Logo 和默认 Base URL 会在服务端再次规范化；全部启用、sort_order 按顺序。
    要求至少一条且每条 id/api_key 齐全，自定义兼容接口还必须填写 Base URL。
    再次校验「未初始化」——不只信缓存，防止已初始化后有人重复 POST 抢建管理员。
    """
    # 防重复：已初始化直接回登录页（自锁）
    if await is_initialized(db):
        return RedirectResponse("/admin/login", status_code=302)

    # 校验失败时只回填本次 POST 的值；绝不从数据库读取已有密码或模型密钥。
    submitted_values = {
        "admin_email": admin_email,
        "admin_password": admin_password,
        "smtp_host": smtp_host,
        "smtp_port": smtp_port,
        "smtp_user": smtp_user,
        "smtp_password": smtp_password,
        "smtp_from_name": smtp_from_name,
    }
    try:
        decoded_rows = json.loads(models)
    except json.JSONDecodeError:
        decoded_rows = None
    submitted_model_rows = (
        [row for row in decoded_rows if isinstance(row, dict)]
        if isinstance(decoded_rows, list)
        else []
    )

    def render_error(message: str) -> HTMLResponse:
        return HTMLResponse(
            _render_form(
                message,
                form_values=submitted_values,
                model_rows=submitted_model_rows,
            ),
            status_code=400,
        )

    # 基本校验
    email = admin_email.strip().lower()
    if len(admin_password) < 6:
        return render_error("密码至少 6 位")

    # 解析并校验模型列表
    if decoded_rows is None or not isinstance(decoded_rows, list):
        return render_error("模型数据格式错误，请重试")
    rows = decoded_rows

    parsed: list[dict] = []
    seen_ids: set[str] = set()
    for r in rows:
        if not isinstance(r, dict):
            continue
        mid = str(r.get("id", "")).strip()
        k = str(r.get("api_key", "")).strip()
        raw_base_url = str(r.get("base_url", "")).strip() or None
        provider, logo, base_url = canonical_model_values(
            str(r.get("provider", "")).strip() or None,
            raw_base_url,
        )
        if not (mid and k):
            return render_error("每个模型的 ID / API Key 都要填")
        if mid in seen_ids:
            return render_error(f"模型 ID「{mid}」重复了")
        seen_ids.add(mid)
        # cost 容错：非法/缺省当 1
        try:
            cost = max(1, int(r.get("cost", 1)))
        except (TypeError, ValueError):
            cost = 1
        parsed.append(
            {
                "id": mid,
                "provider": provider,
                "base_url": base_url,
                "api_key": k,
                "logo": logo,
                "vision": bool(r.get("vision", False)),
                "cost": cost,
            }
        )

    if not parsed:
        return render_error("请至少添加一个模型")

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
    # 2) 模型：逐条 upsert（全新库通常都是新建；老库若已有同 id 则覆盖），全部启用
    for i, m in enumerate(parsed):
        existing = (
            await db.execute(select(LlmModel).where(LlmModel.id == m["id"]))
        ).scalar_one_or_none()
        if existing is not None:
            existing.provider = m["provider"]
            existing.base_url = m["base_url"]
            existing.api_key = m["api_key"]
            existing.logo = m["logo"]
            existing.vision = m["vision"]
            existing.cost = m["cost"]
            existing.enabled = True
            existing.sort_order = i
        else:
            db.add(
                LlmModel(
                    id=m["id"],
                    provider=m["provider"],
                    base_url=m["base_url"],
                    api_key=m["api_key"],
                    logo=m["logo"],
                    vision=m["vision"],
                    cost=m["cost"],
                    enabled=True,
                    sort_order=i,
                )
            )
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
