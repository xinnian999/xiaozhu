# 小筑快速上手

## 定位

小筑是对话式 AI 前端代码生成平台。前端负责对话、编辑与展示；FastAPI 负责
Agent、鉴权和持久化；独立 `sandbox-worker` 用固定模板依赖构建并提供预览。

## 仓库

```text
web/                用户前端
web-admin/          管理后台
server/app/         FastAPI、Agent 与模型
server/templates/   可信 React/Vite/Tailwind 模板
sandbox-worker/     单并发构建与预览服务
```

## 一轮生成

1. `POST /api/chat` 建立 SSE。
2. Agent 通过文件工具修改当前工作副本。
3. `check_build` 先在 `build_store` 建立会合点，再发送 `preview_refresh`。
4. 前端提交完整文件快照到主 API，主 API 转发给 Worker。
5. Worker 用固定配置执行 `vite build`，返回独立预览 URL。
6. iframe 回传运行时错误，前端调用 `build-result`，Agent 被唤醒后决定结束或修复。

不要把 `check_build` 改成固定 sleep 或日志轮询；会合点必须先 `arm()` 再发事件，
否则快速返回会丢结果。

## 沙箱硬约束

- 浏览器不运行 Node；不得重新引入浏览器运行时或依赖快照。
- 主 FastAPI 不直接执行生成项目，也不接触 Docker Socket。
- Worker 构建时不得安装客户端声明的依赖。
- `package.json`、构建配置和 `index.html` 始终由可信模板覆盖。
- 预览必须独立 Origin，并限制 `frame-ancestors`。
- Worker 保持单并发、文件/体积/时间/内存/PID 限额。

详见 [docs/backend-sandbox.md](docs/backend-sandbox.md)。

## 数据与版本

- `files` 是当前工作副本。
- 每轮完成后生成不可变的完整版本快照。
- 回滚会把旧快照覆盖成新的当前版本，版本号继续递增。
- 流式生成期间的前端暂存文件仍以本轮完整快照为准，不能在 Worker 侧改成只读数据库，
  否则并行工具提交会产生竞态。

## LLM 中转约束

模型请求走项目既有 OpenAI 兼容中转和分组配置。不要擅自切换 SDK、绕过
`model_providers.py`，或把密钥下发前端。

## 常用命令

```bash
bun install
bun run dev
bun run build
bun run build:admin
uv run --directory server alembic upgrade head
uv run --directory server ruff check app tests
uv run --directory server python -m unittest discover -s tests
docker compose up -d --build
docker compose config
```

本地端口：前台 9000、管理后台 9100、API 8000、Worker 8010。

## 修改检查

- 前后端 SSE 事件类型保持同步。
- 新配置同步更新 `server/.env.example`。
- 模型变更必须生成并审查 Alembic 迁移。
- 不提交 `.env`、真实密钥、数据库或预览产物。
- 前端、管理后台、后端测试和 Compose 配置均需通过。
