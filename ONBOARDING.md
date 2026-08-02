# 小筑快速上手

## 定位

小筑是对话式 AI 前端代码生成平台。前端负责对话、编辑与展示；FastAPI 负责
Agent、鉴权和持久化；独立 Worker 进程用固定模板依赖构建并提供预览。生产部署时
FastAPI 与 Worker 运行在同一个容器内，本地开发仍由启动脚本分别监管。

## 仓库

```text
web/                用户前端
web-admin/          管理后台
server/app/         FastAPI、Agent 与模型
server/templates/   可信 React/Vite/Tailwind 模板
sandbox-worker/     单并发构建 + Playwright 截图 Worker 进程
```

## 一轮生成

1. `POST /api/chat` 建立 SSE。
2. Agent 通过文件工具修改当前工作副本。
3. `check_build` 从数据库与同批文件 overlay 组成完整快照，直接提交给 Worker。
4. Worker 用固定配置串行执行 `vite build`；成功后才启动 Playwright Chromium，加载本次
   静态产物并采集运行时错误和当前画布截图，截图完成后立即关闭浏览器。
5. 主 API 校验并保存 Worker 截图，为 `build_id` 签发 `/api/sandbox-preview/...`
   capability URL，再把编译、运行时和截图结果一并交给 Agent。
6. 前端收到 `preview_refresh` 后只加载交互 iframe；用户刷新、切后台或关闭页面都不会
   中断服务端构建与截图。iframe 回传的运行时信息只作为在线预览补充诊断。

不要把 `check_build` 改回依赖前端 `build-result` 的等待流程，也不要让 Vite 与 Chromium
并行；2C2G 的资源边界依赖 Worker 的整段单并发。

## 沙箱硬约束

- 浏览器不运行 Node；不得重新引入浏览器运行时或依赖快照。
- 主 FastAPI 进程不直接执行生成项目，也不接触 Docker Socket。
- Worker 构建时不得安装客户端声明的依赖。
- `package.json`、构建配置和 `index.html` 始终由可信模板覆盖。
- Worker 只监听容器 loopback，不得发布公网端口；浏览器只能通过主站 capability
  字节代理读取预览。
- 只有当 `SANDBOX_PREVIEW_ORIGIN` 与主站 Origin 确实不同时，预览 iframe 才能授予
  `allow-same-origin`；同源回退模式必须保持 opaque origin。
- Worker 保持单并发，Vite 退出后才能启动 Chromium；截图结束必须关闭 Browser，继续遵守
  文件、体积、时间、内存与 PID 限额。
- Playwright 只允许访问本次 Worker loopback 静态预览以及 `data:`/`blob:` 资源，禁止让
  生成页面借服务端浏览器访问主 API、容器内网或任意公网地址。

不要把字节代理改成 302 到 Worker：重定向会重新暴露 Worker 地址。无论使用独立或
opaque origin，父页面都不直接读 iframe DOM；模型截图统一由 Worker 内的 Playwright
完成，交互 iframe 不参与截图。
当前 Worker 只面向可信个人演示，不是恶意多租户 VM；若对公网开放任意用户生成，
必须再增加每任务独立容器/微 VM 与网络、UID、cgroup 隔离。

详见 [docs/backend-sandbox.md](docs/backend-sandbox.md)。

## 数据与版本

- `files` 是当前工作副本。
- 每轮完成后生成不可变的完整版本快照。
- Agent 为每个新快照生成简短版本名；v1 同时生成项目名，之后不再自动覆盖项目标题。
- 回滚会把旧快照覆盖成新的当前版本，版本号继续递增。
- 流式生成期间的前端暂存文件仍以本轮完整快照为准，不能在 Worker 侧改成只读数据库，
  否则并行工具提交会产生竞态。

## LLM 中转约束

模型请求走项目既有 OpenAI 兼容中转和分组配置。不要擅自切换 SDK、绕过
`model_providers.py`，或把密钥下发前端。

## 常用命令

```bash
corepack enable
pnpm install
pnpm run dev
pnpm run build
pnpm run build:admin
uv run --directory server alembic upgrade head
uv run --directory server ruff check app tests
uv run --directory server python -m unittest discover -s tests
docker compose up -d --build
XIAOZHU_IMAGE_TAG=config-check SANDBOX_WORKER_TOKEN=config-check-placeholder \
  docker compose config --no-env-resolution
```

本地要求 Node.js 22，并通过 Corepack 使用仓库锁定的 pnpm 版本。

本地开发端口：前台 7300、管理后台 7100、API 7200、Worker 7010。生产容器内 Worker
使用 8010；Compose 不会把它暴露到公网网卡。

## 发布

生产镜像只由 `release-v<版本>` Git tag 触发构建，普通 `master` push 不发版，也
不再维护可变的 `latest`。使用 `pnpm release:tag -- <版本>` 创建发布标签，完整流程见
[docs/release.md](docs/release.md)。

## 修改检查

- 前后端 SSE 事件类型保持同步。
- 新配置同步更新 `server/.env.example`。
- 模型变更必须生成并审查 Alembic 迁移。
- 不提交 `.env`、真实密钥、数据库或预览产物。
- 前端、管理后台、后端测试和 Compose 配置均需通过。
