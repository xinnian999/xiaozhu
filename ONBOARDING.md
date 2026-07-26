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
sandbox-worker/     单并发构建 Worker 进程
```

## 一轮生成

1. `POST /api/chat` 建立 SSE。
2. Agent 通过文件工具修改当前工作副本。
3. `check_build` 先在 `build_store` 建立会合点，再发送 `preview_refresh`。
4. 前端提交完整文件快照到主 API，主 API 转发给 Worker。
5. Worker 用固定配置执行 `vite build`，返回 `build_id`。
6. 主 API 签发 `/api/sandbox-preview/...` capability URL，并从共享目录直接读取产物。
7. iframe 在独立预览 Origin（未配置时为 opaque origin）中运行并回传运行时错误和
   受限截图；前端调用 `build-result`，Agent 被唤醒后根据真实报错与截图决定结束或修复。

不要把 `check_build` 改成固定 sleep 或日志轮询；会合点必须先 `arm()` 再发事件，
否则快速返回会丢结果。

## 沙箱硬约束

- 浏览器不运行 Node；不得重新引入浏览器运行时或依赖快照。
- 主 FastAPI 进程不直接执行生成项目，也不接触 Docker Socket。
- Worker 构建时不得安装客户端声明的依赖。
- `package.json`、构建配置和 `index.html` 始终由可信模板覆盖。
- Worker 只监听容器 loopback，不得发布公网端口；浏览器只能通过主站 capability
  字节代理读取预览。
- 只有当 `SANDBOX_PREVIEW_ORIGIN` 与主站 Origin 确实不同时，预览 iframe 才能授予
  `allow-same-origin`；同源回退模式必须保持 opaque origin。
- Worker 保持单并发、文件/体积/时间/内存/PID 限额。

不要把字节代理改成 302 到 Worker：重定向会重新暴露 Worker 地址。无论使用独立或
opaque origin，父页面都不直接读 iframe DOM；截图走 iframe bridge 或服务端浏览器。
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
SANDBOX_WORKER_TOKEN=config-check-placeholder docker compose config --no-env-resolution
```

本地要求 Node.js 22，并通过 Corepack 使用仓库锁定的 pnpm 版本。

本地端口：前台 9000、管理后台 9100、API 8000。Worker 使用 8010；Compose 只把它
绑定到宿主机 `127.0.0.1`，不会暴露到公网网卡。

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
