# 小筑（Xiaozhu）

对话式 AI 代码生成平台(类 V0)。描述需求 → AI 生成可运行的前端项目 → 在浏览器里**实时预览**,可继续对话迭代、保存版本、分享成品。


## 特性

- **浏览器内运行**:用 [WebContainer](https://webcontainer.io) 在前端跑 Node/Vite,无需后端沙箱
- **构建式预览**:每轮改动整体 `vite build` 出 dist、用 `vite preview` 跑;编译/运行报错确定回传给 AI 自检自修(详见「预览与构建自检」)
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
│       工具: write/edit/read/list/check_build │
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
- **流式期间暂不构建预览**:避免闪半成品 / 浪费多次全量构建,等 AI 调 `check_build` 才整体揭晓 + 构建(详见「预览与构建自检」)
- **跨域隔离头走纯 ASGI 中间件**:`BaseHTTPMiddleware` 会缓冲流式响应,纯 ASGI 只在响应头阶段插手,对 SSE 透明
- **SSE 协议早定死**:前后端双份写(Pydantic + TS type),M2 前不动
- **整快照 + 回滚即新版**:回滚直接覆盖当前态并产生新版本,seq 单向递增,历史不变

## 预览与构建自检(check_build)

预览**不用 dev server / HMR**,改为每轮整体构建。AI 写完一组改动后调 `check_build` → 后端推 `preview_refresh` → 前端把暂存文件同步进 WebContainer、跑 `vite build` 出 dist、用 `vite preview` 起静态服务揭晓(**构建在用户浏览器里跑,和后端机器配置无关**)。这取代了旧的 `update_preview` + `get_browser_logs` 两个工具 + 日志轮询。

「报错怎么确定地回到 AI 手里」——**编译错 + 运行时错走同一条路**,都经 `build-result` 回报,后端 `check_build` 只需纯 `await`:

1. AI 调 `check_build` → `loop.py` 先 `build_store.arm()` 架好会合点、再推 `preview_refresh`。
2. 前端 `syncFiles`:写文件 → `vite build`。**编译失败**立刻回报 `{ok:false, runtime:false, errors}`;**编译成功**则重载 iframe,从其 `load` 事件起开一个**收集窗**(`REVEAL_COLLECT_MS`,默认 1.5s),把这期间 console 桥抓到的运行时报错收齐,再带着 `{ok, runtime, errors}` 回报。
3. 后端 `check_build` 用 **asyncio.Event**([build_store.py](server/app/build_store.py))挂着 `await` 等这个结果,前端一报回即被唤醒返回 —— **前端多快回就多快返回,不靠后端固定窗口猜**。据 `ok/runtime` 给三种文案:构建失败(编译没过)/ 构建通过但运行时报错 / 一切正常。

> 这套**取代**了旧的 `update_preview` + `get_browser_logs` 两个工具,以及后端 `log_store`「前端推日志→临存→轮询读」整套(已删)。运行时错误的「等多久」窗口现在落在**前端**、且从 iframe 真实 `load` 起算,比后端盲扫准。

> ⚠️ **排查:运行时报错漏报(check_build 报「一切正常」,但预览其实崩了)**
> 原因:慢机器 / 重应用上,收集窗内没等到「iframe 渲染 → 抛错 → console 桥回传父页面」。
> - 调窗口:[PreviewPane](web/src/components/WorkArea/PreviewPane/index.tsx) 顶部 `REVEAL_COLLECT_MS`(1.5s,从 iframe `load` 起算)和 `REVEAL_FALLBACK_MS`(6s,load 始终不来的兜底)。
> - 注意:运行时错误本质 best-effort(错误可能渲染后才异步抛、等不到永远);收集逻辑见 PreviewPane 的 `revealRef` / `finishReveal` / `handleIframeLoad`。
> - 另注:`vite build` **不跑 `tsc`**(AI 代码常有无害类型错,跑 tsc 会卡构建),所以**类型级**错误不在这条路覆盖内 —— 它和运行时检测互补、不是包含关系。

关键文件:[build_store.py](server/app/build_store.py) · [api/build_result.py](server/app/api/build_result.py) · [agents/tools.py](server/app/agents/tools.py)(`check_build`) · [agents/loop.py](server/app/agents/loop.py)(`arm` + 推 `preview_refresh`) · [PreviewPane](web/src/components/WorkArea/PreviewPane/index.tsx)(`revealRef` 收集 + 回报)

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

**全自动 CI/CD:你只需 `git push origin master`,剩下全自动。**

```
git push origin master
  → GitHub: xinnian999/xiaozhu (master 分支)
  → 阿里云 ACR「自动构建仓库」监听到代码变更，自动构建镜像（海外构建机 + 根目录 Dockerfile）
       产出 crpi-a7p27yxlrmekg1a3.cn-beijing.personal.cr.aliyuncs.com/elin/xiaozhu:latest（约 2 分钟）
  → 构建成功触发「触发器 xiaozhu_deploy」(全部触发)，回调服务器上的部署 webhook
       (http://xiaozhu.elin521.cn/<部署钩子>)
  → 服务器执行 docker compose pull && docker compose up -d（拉新 latest、重启容器）
  → 容器启动命令先 `alembic upgrade head` 自动迁移，再起 uvicorn
线上地址：https://xiaozhu.elin521.cn
```

**ACR 构建规则**（容器镜像服务 → 个人版实例 → elin/xiaozhu → 构建）：
- `branches:master` → 镜像 tag `latest`（日常发布走这条）
- `tags:release-v$version` → 镜像 tag `$version`（打版本 tag 时用）

**镜像构建细节**：`Dockerfile` 多阶段构建——前端 `bun run build` → 拷进 `server/static` 由后端托管(同源)；
顺带把 `deps-snapshot.bin` gzip 成 `.bin.gz` 供生产分发。`DATABASE_URL` 指向挂载的持久化目录。详见
[docker-compose.yml](docker-compose.yml)。

> ⚠️ **改了环境变量要手动同步到服务器**：镜像里**不含** `.env`（密钥/环境配置运行时由 docker 注入，
> 见 docker-compose 的 `env_file`）。所以**新增/修改环境变量**（如新接入支付渠道的 `AFDIAN_*`）必须先
> SSH 到服务器改那份 `.env`，否则自动部署拉的新镜像仍读到旧/空配置。只改代码不涉及新 env 时，push 即可。

**「服务器拉取」一环的实现**：ACR 触发器回调 `http://xiaozhu.elin521.cn/deploy/xiaozhu?token=***`
→ Caddy 把 `/deploy/xiaozhu*` 反代到宿主机 `:19001`（systemd 服务 `xiaozhu-deploy-webhook.service`，
脚本 `/opt/xiaozhu-deploy/server.py`，token 鉴权见 `token.txt` / `DEPLOY_TOKEN`）→ 校验通过后跑
`/opt/xiaozhu-deploy/deploy.sh`（`cd /www/server/panel/data/compose/xiaozhu && docker compose pull && up -d`）。
部署目录：`/www/server/panel/data/compose/xiaozhu/`（宝塔托管的 compose，`.env` 在此）。

> ⚠️ **坑（2026-06-27 已修）**：Caddy 站点配置 `/root/caddy/sites/xiaozhu.caddy` 把上游写成了
> **网关 IP `172.20.0.1`**；`xiaozhu_default` 网络重建后网段变成 `172.21.x`，Caddy 转发 502、部署请求
> 到不了脚本（而 ACR 把 502 也显示成「请求成功」，极具迷惑性）。已改为当前网关 `172.21.0.1` 并热重载。
> **若以后该 docker 网络又被重建、网段再变，需同步改这里**（更稳的做法：给 caddy compose 加
> `extra_hosts: ["host.docker.internal:host-gateway"]`，配置里用 `host.docker.internal:19001` 取代写死 IP）。

> 手动部署兜底（自动链路异常时用）：
> ```bash
> ssh root@8.141.0.39 'cd /www/server/panel/data/compose/xiaozhu/ && docker compose pull && docker compose up -d'
> ```

## 目录结构

```
web/                 前端
  src/lib/           webcontainer / depsCache / api(SSE) 等核心
  src/components/    ChatSidebar · WorkArea(预览/编辑器/终端) · TopBar …
  src/store/         zustand: session / auth / theme / ui / editor
  scripts/           gen-snapshot 工具(Playwright + 无头 WebContainer)
server/app/          后端
  api/chat.py        SSE 端点 + Agent loop(LLM 流式 + 工具闭包)
  api/               sessions · files · versions · share · users · messages · build-result
  build_store.py     check_build 的「构建结果」会合点(asyncio.Event)
  models/            ORM + Pydantic schema
  llm.py             模型白名单与 LLM 装配
  security.py deps.py  JWT / bcrypt / 依赖注入守卫
server/templates/    预置项目模板(vite-react)
server/alembic/      数据库迁移
```
