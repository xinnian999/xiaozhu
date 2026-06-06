# Vibuild

对话式 AI 代码生成平台(类 V0)。描述需求 → AI 生成可运行的前端项目 → 在浏览器里**实时预览**,可继续对话迭代、保存版本、分享成品。

> 练手项目,目标是学 Python + FastAPI + LangChain / LangGraph + WebContainer。详见 [TECH_DESIGN.md](TECH_DESIGN.md)。

## 特性

- **浏览器内运行**:用 [WebContainer](https://webcontainer.io) 在前端跑 Node/Vite,无需后端沙箱
- **渐进式预览**:文件流式到达即增量挂载,走 Vite HMR 热更新,肉眼看着预览长出来
- **依赖秒开**:三级缓存跳过 `npm install`(见下文「提速方案」)
- **流式对话**:SSE 单连接混合推送对话增量 / 文件写入 / 工具进度 / 版本卡
- **版本管理**:整快照 + 回滚即新版(单线递增,不分支)
- **一键分享**:本地 `vite build` 出 dist 上传后端,访客走静态站点秒开、不碰 WebContainer
- **多模型**:模型白名单 + 按分组取 API key;支持深浅双主题、移动端布局

## 架构

```
┌─ 前端 (Vite + React 19) ───────────────────┐
│  ChatSidebar (SSE)   WorkArea               │
│                      ├─ 预览 iframe (WebContainer)
│                      ├─ Monaco 编辑器        │
│                      └─ xterm 终端           │
└──────────────┬──────────────────────────────┘
               │ HTTP + SSE
┌──────────────▼──────────────────────────────┐
│  后端 (FastAPI, Python 3.12+)                │
│   /api/chat (SSE)  ── Agent loop:            │
│       LLM 流式 → tool_calls 循环             │
│       工具: write/edit/read/list/logs        │
│   /api/sessions|files|versions|share|users   │
│   持久化: SQLite + SQLAlchemy(async) + Alembic│
└──────────────────────────────────────────────┘
```

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 19 · Vite · zustand · @webcontainer/api · Monaco · xterm · motion · SCSS |
| 后端 | FastAPI · SQLAlchemy 2.0 (async) · Alembic · Pydantic v2 · pydantic-settings |
| Agent | LangChain + LangGraph,LLM 经 OpenAI 兼容中转接入 |
| 持久化 | SQLite(aiosqlite) |
| 工具链 | 前端 `bun`,后端 `uv` + `ruff` |

## 提速方案:依赖三级缓存

模板固定 → `node_modules` 恒定。按依赖集合的 SHA-256(`depsKey`)缓存一份 `node_modules` 二进制快照,boot 时按顺序命中,跳过 30–60s 的 `npm install`:

| 级别 | 来源 | 速度 | 场景 |
|---|---|---|---|
| 1 | IndexedDB | 秒开(纯本地) | 老用户 / 刷新 |
| 2 | 页面预热 → IndexedDB | 秒开 | 首屏后台预下载,等首条消息时已就绪 |
| 3 | 预置静态快照 `deps-snapshot.bin`(走自家 CDN) | ~3-5s | 新用户首次,绕开 npm registry |
| 4 | `npm install` | 30-60s | 兜底,装完顺手导出快照存入 IndexedDB |

实现见 [web/src/lib/depsCache.ts](web/src/lib/depsCache.ts) 与 [web/src/lib/webcontainer.ts](web/src/lib/webcontainer.ts)。

### 改了模板依赖后,重新生成预置快照

预置快照来自模板 [server/templates/vite-react/package.json](server/templates/vite-react/package.json)。**一旦改动其依赖,`depsKey` 变化,旧快照立即失效(回退联网安装),必须重做**:

```bash
bunx playwright install chromium   # 仅首次,装浏览器内核
bun run gen-snapshot               # 改了模板依赖后重跑,产物覆盖 web/public/ 并提交
```

脚本([web/scripts/](web/scripts/))用 Playwright 开无头 Chromium 跑**真实 WebContainer** 装依赖并导出快照——因为 `node_modules` 含平台相关二进制(esbuild/rollup),必须由 WebContainer 自己的 npm 装出来才对得上,本地 Node 直接打包会装成宿主平台的、挂不上。

## 关键设计

- **预置模板而非让 LLM 写配置**:配置是确定性样板,LLM 易写错版本号/漏依赖,WebContainer 跑不起来难排查
- **工具用闭包工厂**:每请求构造,绑定 `db`/`session_id`,LLM 只看到业务参数(path/content),感知不到后端概念
- **消息分 kind(text/tool/version)**:喂 LLM 上下文只取 `text`,工具行已体现在文件现状,重放会误导
- **流式期间暂不同步预览**:避免闪半成品,等 AI 主动 `update_preview` 再整体揭晓 → HMR
- **跨域隔离头走纯 ASGI 中间件**:`BaseHTTPMiddleware` 会缓冲流式响应,纯 ASGI 只在响应头阶段插手,对 SSE 透明
- **SSE 协议早定死**:前后端双份写(Pydantic + TS type),M2 前不动
- **整快照 + 回滚即新版**:回滚直接覆盖当前态并产生新版本,seq 单向递增,历史不变

## 本地开发

**前置**:`bun`、`uv`、Node。后端首次需在 `server/.env` 配 `JWT_SECRET`(必填,否则启动自检报错):

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

```bash
bun install                              # 装前端依赖
uv run --directory server alembic upgrade head   # 建库 / 应用迁移
bun run dev                              # 前后端并行(web:5173 + server:8000)
```

改了 `server/app/models/*.py` 后走迁移(不再用 create_all):

```bash
uv run --directory server alembic revision --autogenerate -m "描述"   # 生成后人工 review
uv run --directory server alembic upgrade head
```

## 部署

`Dockerfile` 多阶段构建:前端 `bun run build` → 拷进 `server/static` 由后端托管(同源);容器启动自动 `alembic upgrade head`,并把 `deps-snapshot.bin` gzip 成 `.bin.gz` 供生产分发。`DATABASE_URL` 指向挂载的持久化目录。详见 [docker-compose.yml](docker-compose.yml)。

## 目录结构

```
web/                 前端
  src/lib/           webcontainer / depsCache / api(SSE) 等核心
  src/components/    ChatSidebar · WorkArea(预览/编辑器/终端) · TopBar …
  src/store/         zustand: session / auth / theme / ui / editor
  scripts/           gen-snapshot 工具(Playwright + 无头 WebContainer)
server/app/          后端
  api/chat.py        SSE 端点 + Agent loop(LLM 流式 + 工具闭包)
  api/               sessions · files · versions · share · users · messages · logs
  models/            ORM + Pydantic schema
  llm.py             模型白名单与 LLM 装配
  security.py deps.py  JWT / bcrypt / 依赖注入守卫
server/templates/    预置项目模板(vite-react)
server/alembic/      数据库迁移
```
