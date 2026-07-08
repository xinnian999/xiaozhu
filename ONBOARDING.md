# 小筑（Xiaozhu）— AI 快速上手手册

> 给接手本项目的新 AI 助手：读完这份，你应该能理解「它是什么、代码怎么组织、
> 哪些地方有坑、改动要走什么流程」。已知信息不重复 README，本文侧重**心智模型 +
> 踩坑记录**。README 侧重架构与部署，两份互补。

---

## 1. 一句话定位

对话式 AI 代码生成平台（类 V0）：用户描述需求 → AI 生成可运行的前端项目 →
**在用户自己的浏览器里实时预览**（不用后端沙箱）→ 可继续对话迭代、保存版本、一键分享。

盈利模式：三档订阅（free / pro / max），按「点数」计费，手动收款码 + 后台人工审核放行。

---

## 2. 仓库布局（monorepo，bun workspaces）

```
xiaozhu/
├── web/          C 端前端（React 19 + Vite + zustand + SCSS）        端口 9000
├── web-admin/    管理后台（React + antd + react-router）挂 /admin    端口 9100
├── server/       后端（FastAPI + SQLAlchemy async + Alembic）        端口 8000
├── package.json  根 workspace：bun run dev 并行起三个
├── Dockerfile    多阶段：前端 build → 塞进 server/static 同源托管
└── docker-compose.yml
```

- **包管理器**：前端 `bun`，后端 `uv`（Python 3.12+）。
- **一键起本地**：`bun run dev` → `predev-clean.sh` 清端口 → concurrently 起 web/admin/server。
- **数据库**：SQLite（aiosqlite）。表结构**只由 Alembic 管**，不用 `create_all`。

---

## 3. 三个前端/后端约定（CLAUDE.md 硬规则，必须遵守）

前端（web）：
- 图标只用 `lucide-react`；样式 SCSS，优先 `index.module.scss`；**禁止 Tailwind 工具类**（这是指
  *小筑自己的前端*，别和「AI 生成的用户项目用 Tailwind」搞混——见 §7）。
- 代码注释**必须中文**、多写。
- 必须同时兼容移动端；深浅双主题走 CSS 变量（`styles/_theme.scss` 按 `html[data-theme]` 切）。
- SCSS 嵌套严格对应 JSX DOM 层级，响应式样式写文件底部、与 PC 分离。
- 组件目录：`index.tsx` 作入口，样式同名 `index.module.scss`。

后端（server）：
- **改了 `app/models/*.py` 必须走 Alembic 迁移**（autogenerate → 人工 review → upgrade head），
  且新 model 要在 `alembic/env.py` 里 import，否则 autogenerate 看不到。
- SQLite ALTER 弱，`env.py` 已开 `render_as_batch=True`。
- `JWT_SECRET` 必填（`server/.env`），为空启动自检直接报错退出。生产用 `DATABASE_URL` 指向挂载目录。
- 生产**严禁手改线上表结构**；容器启动会自动 `alembic upgrade head`。

---

## 4. 核心数据流：一轮对话是怎么跑的

```
用户发消息
  → POST /api/chat（SSE 长连接，原生 fetch，非 axios）
  → app/api/chat.py → app/agents/loop.py: _consume()
       LangGraph agent.astream()（updates + messages 两种模式混合消费）
       模型流式吐字 → tool_calls → tools 节点执行 → 回到模型 → …
  → 事件经 sse() 编码成前端 SSEEvent，前端 ChatSidebar 消费
```

SSE 事件类型（前后端双份定死，见 [web/src/lib/api.ts](web/src/lib/api.ts) 的 `SSEEvent`）：
`message_delta`(增量文本) / `file_write` / `file_delete` / `preview_refresh` /
`plan_update` / `tool_call`(带 id) / `tool_result`(按 id 关联) / `version` / `error` /
`done` / `awaiting_answer`（ask_user 触发 interrupt 暂停时发）。

Agent 工具（[server/app/agents/tools.py](server/app/agents/tools.py)，闭包工厂 `build_tools`，
每请求构造、绑定 db/session_id/db_lock）：
`write_file` · `edit_file`(old_string→new_string 单点替换) · `read_files` · `list_files` ·
`check_build` · `ask_user`。

关键常量（[loop.py](server/app/agents/loop.py)）：`RECURSION_LIMIT = 75`、`TOOL_RESULT_CAP = 4000`。
LLM（[llm.py](server/app/llm.py)）：`max_tokens=16384`，`model_kwargs={"parallel_tool_calls": False}`，
`extra_body={"enable_thinking": False}`。

---

## 5. 预览与构建自检（check_build）— 本项目最精妙也最易踩的一环

预览**不用 dev server / HMR**，改为**每轮整体 `vite build`**，构建在**用户浏览器**里跑（和后端机器配置无关）。

会合点机制（[server/app/build_store.py](server/app/build_store.py)，基于 `asyncio.Event`）：

1. AI 调 `check_build` → loop.py 先 `build_store.arm(session_id)` 架好会合点，再推 `preview_refresh`。
2. 前端收到 `preview_refresh` → `syncFiles`：写文件进 WebContainer → `vite build`。
   编译失败立刻回报 `{ok:false, runtime:false, errors}`；编译成功则重载 iframe，从 `load` 事件起开
   一个收集窗（`REVEAL_COLLECT_MS` 默认 1.5s，兜底 `REVEAL_FALLBACK_MS` 6s），收 console 桥抓到的
   运行时报错，再带 `{ok, runtime, errors}` 回报 `POST /api/sessions/{id}/build-result`。
3. 后端 `check_build` 用 `build_store.wait(session_id, timeout=90.0)` 挂着 await，前端一回报即被唤醒。
   **前端多快回就多快返回**；90s 超时兜底返回「构建超时」。

> ⚠️ **注意**：`vite build` **不跑 tsc**（AI 代码常有无害类型错，跑 tsc 会卡构建）。所以**类型级错误
> 不在自检覆盖内**——它和运行时检测互补、不是包含关系。

### 🔴 已修复的核心 bug：check_build 误报「构建通过」（并行工具调用竞态）

- **现象**：某 session 生成的 Home.tsx 有语法错（模板字符串被过度转义：反引号写成 `\``、`${` 写成
  `\${`，DB 里字节是 `5C60`/`5C24`），vite 报 `Syntax error` at Home.tsx:20:28，但 check_build 却报「构建通过」。
- **根因**：Gemini 把 8 个 write_file + check_build 放进**同一批并行 tool_calls**（DB 里入库时间戳全同一秒）。
  LangGraph 的 **tools 节点是屏障**，要等批次内所有工具（含阻塞 90s 的 check_build）都跑完才产出 file_write
  事件；而 check_build 的 `arm()`+`preview_refresh` 是在 **model 节点**里立即发的。结果前端收到的真实顺序是
  `preview_refresh` 先到 → check_build 阻塞 → file_write 后到。前端一收到 preview_refresh 就构建，此刻
  新文件还没到，构建的是**旧模板文件**，旧文件构建通过 → 误报 ok。
  （`parallel_tool_calls: False` 对多数模型有效，但 code0.ai 中转对 Gemini 会**吞掉这个参数**，见 §8。）
- **修复**（loop.py）：加 `_early_file_write()` helper——在 model 节点处理 check_build 时，**提前**把同批次里
  其他 write_file/edit_file 的 tool_call 用其自身 args 转成 file_write 事件先发出去（write_file 取 args 的
  path+content；edit_file 读 DB 内容做单点替换，count==1 才可靠，否则返回 None 放弃提前）；用 `early_written`
  集合记账，tools 节点里对已提前发过的 id 跳过重发。这样 preview_refresh 到达前，新文件已经进了前端。

---

## 6. 版本 / 分享 / 计费

- **版本**（[server/app/versioning.py](server/app/versioning.py)）：整快照 + 单线递增，回滚即新版（覆盖当前态
  再产生新版本，`seq` 单向递增不分叉）。`snapshot_current_files` 被「生成结束自动快照」和「回滚」共用。
- **分享**：前端本地 `vite build` 出 dist 上传后端，访客走静态站点 `/shared/{token}/` 秒开、**不碰 WebContainer**。
  （所以 AI 生成的项目**必须用 HashRouter**，BrowserRouter 在子路径下会 404——见 prompts.py。）
- **计费**（[server/app/billing.py](server/app/billing.py)）：
  - 三档 free / pro / max，每天固定「点数」额度，隔天重置、不累积。价格 pro `9.90` / max `19.90`（元）。
  - 一轮扣「模型倍率」点（llm 里每模型的 `cost`：普通 1、贵的 2）。**一轮干净跑完**（正常到 done、没报错/
    没截断/没被中断）才 `+= cost`。
  - `effective_tier`：付费档过了 `tier_expires_at` 自动按 free 算。`TIER_RANK` free<pro<max，只能升级。
  - 下单 → 展示收款码（微信/支付宝 data URI）→ 用户「我已支付」转待审核 → 后台人工 approve/reject 放行。

---

## 7. AI 生成的用户项目（模板）

- 模板在 [server/templates/vite-react/](server/templates/)：一个真实 Vite + React 19 + TS 项目，
  `load_template()` 读它当每个新 session 的初始文件。
- **用户项目用 Tailwind 工具类写样式**（prompts.py 明确要求）；深浅色用 `darkMode: 'class'` 已预置。
  ⚠️ 别和「小筑自己的前端禁用 Tailwind」搞混，两码事。
- 骨架文件（package.json / vite.config.ts / tsconfig.json / index.html / .npmrc）**AI 不许改**。
- 多页面用 react-router v6「组件式 API」（`<Routes>`/`<Route>`），**禁止** createBrowserRouter/RouterProvider/
  loader/action；全项目只能有一个 `<HashRouter>`（在 main.tsx）。
- **依赖秒开三级缓存**（模板固定 → node_modules 恒定，按 depsKey=依赖集合 SHA-256 缓存）：
  IndexedDB（秒开）→ 页面预热 → 预置静态快照 `deps-snapshot.bin`（走自家 CDN，~3-5s）→ npm install（兜底 30-60s）。
  实现见 [web/src/lib/depsCache.ts](web/src/lib/depsCache.ts) / [webcontainer.ts](web/src/lib/webcontainer.ts)。
  **改了模板依赖必须重跑 `bun run gen-snapshot`**（Playwright 开无头 Chromium 跑真实 WebContainer 装依赖导出），
  否则 depsKey 变、旧快照失效。

---

## 8. WebContainer 与预览（务必理解其约束）

- 预览用 **WebContainer**（StackBlitz）：浏览器内 Node 运行时，从境外 `stackblitz.com/headless?version=1.6.4`
  iframe 加载运行时（`@webcontainer/api` 版本 1.6.4）。
- **闭源、不可自托管**：boot 逻辑写死在闭源 iframe 里，运行时字节带版本校验/鉴权 token，放自己服务器让用户拉
  这条路走不通（试过，三个卡点：字节非自包含、加载逻辑改不到、有鉴权/版本握手且违反 ToS）。
- **一个页面只能 boot 一次**（单实例）。切会话要销毁旧容器重 boot（FS/终端全重来）。
- **不能用服务端沙箱替代**：现在 2c2g 服务器能撑住，正是因为构建计算全甩给了用户浏览器；服务端沙箱会让 2c2g OOM。
- **esbuild-wasm / Sandpack 平替的最大拦路虎是 Tailwind**：用户项目重度依赖 Tailwind 工具类，而 esbuild 不处理
  Tailwind（它跑在 PostCSS 里扫 className 生成 CSS），一换就全裸奔。迁移=连 Tailwind 方案一起换，是大改动。

### code0.ai 中转（🔒 严禁改动）

- LLM 经 `https://code0.ai/v1`（new-api 中转）接入，base_url/api_key 存库、管理后台配。
- Gemini 走「Google Gemini」渠道类型，OpenAI→Gemini 格式转换会**丢掉不认识的字段**：探测确认
  `parallel_tool_calls` / `enable_thinking` / `reasoning_*` / `thinking_config` 等**全被吞**，所以 Gemini 仍会
  批量调工具、仍会思考。它的两个渠道开关「透传请求体」「思考内容转换」都关着（后者会把 reasoning_content 转成
  `<think>` 拼进内容）。
- **🔒 硬约束（用户原话）**：「这是公司真实盈利的中转站，我不敢动」——**绝不修改任何 code0.ai 渠道设置**。
  这两个开关是全局渠道级的，一动影响所有付费用户。

### 「首字慢」体感优化（不是修 bug，是改体感）

Gemini 会先思考几十秒才吐第一个字，中转又不回传思维链，界面只有 shimmer 像卡死。
[MessageList](web/src/components/ChatSidebar/MessageList/index.tsx) 加了 `SLOW_GEN_HINT_AFTER = 6`：
「正在生成」等满 6s 还没出字时，显示「模型正在思考，已等待 {genSeconds}s…」+ 实时计时，证明它还活着。

---

## 9. 统一失败监控（boot_failures 表）

- 预览 boot 从境外来，偶发失败（**是 StackBlitz 那端抽风，不是本地网络**——同机同梯子，boot 有时 1.3 分钟
  有时 1.74 秒，差 40 倍；只要能科学上网进到页面，大概率能成，只是慢）。
- 前端 [webcontainer.ts](web/src/lib/webcontainer.ts)：`BOOT_TIMEOUT_MS = 180000`（3 分钟，因为 1.3 分钟的
  boot 仍会成功，40s 会误杀）。`BootError` 类带 `kind`('timeout'|'error') + `elapsedMs`（因 `erasableSyntaxOnly`
  不能用构造函数参数属性，字段要显式声明再在构造体里赋值）。失败经 `reportBootFailure()`（原生 fetch、静默失败）
  上报 `POST /api/boot-failure`（要登录态，message 截 2000、UA 截 500，user_id 从登录态取）。
- 表 `boot_failures`（[server/app/models/boot_failure.py](server/app/models/boot_failure.py)，迁移 revision
  `7b9d371d4a69`）：id / session_id / user_id / stage / kind / message / cross_origin_isolated / elapsed_ms /
  user_agent / created_at。
- 管理后台监控页 [web-admin/src/pages/BootFailures/](web-admin/src/pages/BootFailures/)：导航「预览监控」（Activity
  图标），顶部「累计失败」「近 24 小时」两张统计卡 + 明细表。
- **失败处理策略（用户最终决定）**：**不做自动重试**。理由：只要能进页面 + 科学上网，大概率能成、只是慢；偶发
  失败给个**手动重试按钮**让用户自己点即可。（此前一度加过 error 型自动重试、timeout 型不重试的逻辑，已被否决——
  timeout 时底层 boot 其实还在后台跑，再 boot 会撞单实例限制。）

> 用户曾表达想把监控**统一成一张表**同时覆盖 boot 失败和 **agent 失败/报错**（按类型区分）。目前仅 boot 落表；
> 若后续要做，是把 boot_failures 泛化成通用 failures/events 表加 type 判别，并接入 agent 侧失败源（SSE error 事件、
> 截断、GraphRecursionError、LLM 构建失败等）。**这是待办、尚未实现，动手前先和用户确认表设计**。

---

## 10. 其他值得知道的设计

- **消息分 kind**：`text`(普通对话) / `tool`(工具卡) / `version`(版本卡)。喂 LLM 上下文只取 text（工具行已体现在
  文件现状，重放会误导）。
- **NoBluffMiddleware**（[middleware.py](server/app/agents/middleware.py)）：拦截「零工具调用却宣称已完成修改」
  的嘴炮回复，靠一次轻量模型调用做语义判断（复用本轮的裸 LLM，不另配裁判模型），最多纠正 `MAX_CORRECTIONS = 2`
  次；判断失败兜底放行。
- **ask_user → LangGraph interrupt()**：ask_user 触发 `interrupt()` 暂停本轮，原 /api/chat 流正常结束并发
  `awaiting_answer`；用户答完走 `POST /api/sessions/{id}/ask-result` 开新 SSE 流 `Command(resume=answer)` 续接
  （形状和 streamChat 对齐，前端同样消费）。checkpointer 用 `AsyncSqliteSaver`，每轮独立 thread_id。
- **跨域隔离头**（COOP: same-origin / COEP: require-corp，WebContainer 要求）走**纯 ASGI 中间件**而非
  `@app.middleware("http")`——后者会缓冲 SSE 流式响应，纯 ASGI 只在响应头阶段插手、对 SSE 透明。
- **web-admin**：antd，`basename="/admin"`，`colorPrimary: '#e11d48'`，靠 `get_current_admin`（JWT）守卫；
  页面 Users / Orders / Sessions / EmailCodes / Settings / Models / BootFailures。

---

## 11. 常用命令速查

```bash
bun run dev          # 本地并行起 web(9000)/admin(9100)/server(8000)
bun run build:prod   # 前端 build → 拷进 server/static(-admin)
bun run gen-snapshot # 改了模板依赖后重做依赖快照（Playwright + 无头 WebContainer）

# 后端迁移（改了 models/*.py 后）
uv run --directory server alembic revision --autogenerate -m "描述"   # 生成后人工 review
uv run --directory server alembic upgrade head

# 部署：git push origin master → 阿里云 ACR 自动构建 → webhook 触发服务器 pull & up -d
#   改环境变量必须手动 SSH 同步服务器上的 .env（镜像不含 .env）
```

---

## 12. 改动本项目时的注意清单

1. 前端遵守 CLAUDE.md 硬规则（lucide-react、SCSS module、中文注释、移动端、双主题、禁 Tailwind）。
2. 改后端 model → 必走 Alembic 迁移 + 在 `alembic/env.py` import 新 model。
3. 碰 SSE 协议 → 前后端两份同步改（Pydantic + TS type）。
4. 碰 check_build / 预览 → 记住 model 节点 vs tools 节点屏障的时序（§5 那个竞态），别再让 preview_refresh 抢在
   file_write 前面。
5. 🔒 **绝不动 code0.ai 中转的任何渠道设置**。
6. 涉及 boot 失败/重试 → 记住「不自动重试、给手动按钮」的最终决策，和「timeout 不能再 boot」的单实例约束。
