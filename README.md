# 小筑（Xiaozhu）

对话式 AI 前端代码生成平台。用户描述需求后，Agent 修改 React 项目文件，独立的
后端沙箱完成构建并通过 iframe 展示预览。

## 架构

```text
浏览器（React + Monaco）
  ├─ SSE 对话 / 文件编辑
  ├─ POST 当前文件快照到主 API
  └─ iframe 加载独立预览 Origin
            │
FastAPI 主服务（鉴权、Agent、SQLite）
            │ 内网 Bearer Token
sandbox-worker（固定依赖、单并发 Vite build、静态预览）
```

浏览器不运行 Node，不下载运行时或依赖快照。主服务也不持有 Docker Socket；
它只把已鉴权的文件快照转发给 Worker。

## 沙箱边界

- Worker 使用镜像内固定的 React/Vite/Tailwind 依赖，构建时不联网安装包。
- 客户端提交的 `package.json`、Vite、Tailwind、PostCSS、tsconfig、`.npmrc`
  和 `index.html` 会被可信模板覆盖。
- 单次最多 200 个文件、源码共 5MB、单文件 512KB，默认 60 秒超时。
- Worker 单并发，Compose 默认限制 1.5 CPU、1200MB 内存、128 PID。
- 预览从独立 Origin 提供，并通过 CSP `frame-ancestors` 限制嵌入来源。

详细说明见 [后端沙箱文档](docs/backend-sandbox.md)。

## 本地开发

前置：Bun、uv、Python 3.12+。先安装依赖并准备配置：

```bash
bun install
uv sync --directory server
cp server/.env.example server/.env
cp server/.env.example .env
```

本机源码开发填写 `server/.env`；Docker Compose 填写根目录 `.env`。两者至少包含：

```dotenv
JWT_SECRET=随机长密钥
SANDBOX_WORKER_TOKEN=另一个随机长密钥
SANDBOX_WORKER_URL=http://127.0.0.1:8010
SANDBOX_PUBLIC_BASE_URL=http://localhost:8010
SANDBOX_FRAME_ANCESTORS=http://localhost:9000
```

推荐用 Docker 启动完整环境：

```bash
docker compose up -d --build
```

若主应用在宿主机开发、Worker 用 Docker，运行：

```bash
docker compose up -d sandbox-worker
bun run dev
```

开发地址：前台 `http://localhost:9000`，管理后台
`http://localhost:9100/admin/`，API `http://localhost:8000`。

## 验证

```bash
bun run build
bun run build:admin
uv run --directory server ruff check app tests
uv run --directory server python -m unittest discover -s tests
docker compose config
```

## 部署

主应用与 Worker 是两个镜像：

- `elin/xiaozhu`：FastAPI 与前端静态资源；
- `elin/xiaozhu-sandbox`：固定模板依赖与构建 Worker。

不要在 2GB 生产机上现场构建 Worker 镜像；由 ACR 构建后让服务器直接拉取。
预览应配置独立域名，例如：

```text
preview.xiaozhu.elin521.cn -> sandbox-worker:8010
```

生产环境设置：

```dotenv
SANDBOX_WORKER_URL=http://sandbox-worker:8010
SANDBOX_WORKER_TOKEN=随机长密钥
SANDBOX_PUBLIC_BASE_URL=https://preview.xiaozhu.elin521.cn
SANDBOX_FRAME_ANCESTORS=https://xiaozhu.elin521.cn
```

## 目录

```text
web/                    主前端
web-admin/              管理后台
server/app/             FastAPI、Agent、数据模型
server/templates/       Worker 使用的可信项目模板
sandbox-worker/         构建与独立预览服务
server/alembic/         数据库迁移
```
