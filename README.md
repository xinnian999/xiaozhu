# 小筑（Xiaozhu）

对话式 AI 前端代码生成平台。用户描述需求后，Agent 修改 React 项目文件，受限的
后端 Worker 进程完成构建并通过 iframe 展示预览。

## 架构

```text
浏览器（React + Monaco）
  ├─ SSE 对话 / 文件编辑
  ├─ POST 当前文件快照到主 API
  └─ iframe 加载 preview origin 下的 /api/sandbox-preview/{capability}/...
                         │ 主 API 直接读取共享静态产物
FastAPI 主服务（鉴权、Agent、SQLite、预览 capability、静态预览）
                         │ 容器 loopback + Bearer Token（只发构建请求）
sandbox-worker（固定依赖、单并发 Vite build）
                         │ 写入共享预览目录
```

浏览器不运行 Node，不下载运行时或依赖快照。主服务也不持有 Docker Socket；
它把已鉴权的文件快照转发给 Worker。Worker 按源码内容缓存构建，相同版本直接复用
已有产物；新版本构建一次并把静态产物写入共享目录，
主服务通过带不可猜 capability 的路径直接返回产物。生产环境中 API 与 Worker 是
同一容器内的两个进程，Worker 只监听 `127.0.0.1:8010`；浏览器和容器外部都不能
直接连接 Worker。

## 沙箱边界

- Worker 使用镜像内固定的 React/Vite/Tailwind 依赖，构建时不联网安装包。
- 客户端提交的 `package.json`、Vite、Tailwind、PostCSS、tsconfig、`.npmrc`
  和 `index.html` 会被可信模板覆盖。
- 单次最多 200 个文件、源码共 5MB、单文件 512KB，默认 60 秒超时。
- Worker 单并发；Compose 对 API 与 Worker 所在的整个容器设置 2 CPU、1800MB
  内存和 256 PID 上限。
- 推荐把 capability 路由暴露到独立预览 Origin。iframe 可使用该 Origin 自己的
  `localStorage`，但不能读取小筑主站 DOM、Cookie 或登录存储。
- 若未配置独立 Origin，则回退到主站相对 URL，同时移除 `allow-same-origin`，让页面
  运行在 opaque origin 中。
- capability URL 等同临时访问凭证；每个会话只保留最近 3 份构建，旧产物会被回收。

这套实现面向当前的个人演示和可信低并发使用：它是固定模板的受限构建 Worker，
不是允许陌生用户执行任意依赖、命令或服务端代码的多租户 VM/容器平台。若以后开放
给不可信公网用户，仍需为每次构建增加独立容器/微 VM、只读根文件系统、网络策略和
任务级 UID/cgroup 隔离，不能只依赖路径校验与 Vite 插件。

详细说明见 [后端沙箱文档](docs/backend-sandbox.md)。

## 本地开发

前置：Bun、uv、Python 3.12+。宿主机开发先安装依赖并准备后端配置：

```bash
bun install
uv sync --directory server
cp server/.env.example server/.env
```

`server/.env` 至少包含：

```dotenv
JWT_SECRET=随机长密钥
SANDBOX_WORKER_TOKEN=另一个随机长密钥
SANDBOX_CAPABILITY_SECRET=第三个随机长密钥
SANDBOX_WORKER_URL=http://127.0.0.1:8010
SANDBOX_PREVIEW_DIR=../data/sandbox-worker-dev/previews
SANDBOX_PREVIEW_ORIGIN=http://preview.localhost:9000
SANDBOX_FRAME_ANCESTORS=http://localhost:9000
```

本地开发直接执行：

```bash
bun run dev
```

该命令会同时启动前台、管理后台、FastAPI 和沙箱 Worker；首次运行会自动安装固定预览模板依赖，不要求启动 Docker。

开发地址：前台 `http://localhost:9000`，管理后台
`http://localhost:9100/admin/`，API `http://localhost:8000`。

完整 Compose 部署使用根目录 `.env`：

```dotenv
SANDBOX_WORKER_URL=http://127.0.0.1:8010
SANDBOX_PREVIEW_DIR=/app/data/sandbox-worker/previews
SANDBOX_CAPABILITY_SECRET=只注入主应用的随机长密钥
SANDBOX_PREVIEW_ORIGIN=http://preview.localhost:8000
SANDBOX_FRAME_ANCESTORS=http://localhost:8000
```

可先执行 `cp server/.env.example .env` 再修改预览域名和密钥，然后执行
`docker compose up -d`。容器入口会先迁移数据库，再启动 loopback Worker 与 API；
任一进程异常退出都会结束容器并由 Compose 统一重启。

## 验证

```bash
bun run build
bun run build:admin
uv run --directory server ruff check app tests
uv run --directory server python -m unittest discover -s tests
SANDBOX_WORKER_TOKEN=config-check-placeholder docker compose config --no-env-resolution
```

## 部署

生产只需要 `elin/xiaozhu` 一个镜像和一个容器。镜像内包含 FastAPI、Bun Worker、
固定模板依赖以及前后台静态资源；不要在 2GB 生产机上现场构建镜像，由 ACR 构建后
直接拉取。主站域名与预览域名都反向代理到该容器的 `8000` 端口；预览域名只承载
`/api/sandbox-preview/...`。`8010` 不映射到宿主机。

生产环境设置：

```dotenv
SANDBOX_WORKER_URL=http://127.0.0.1:8010
SANDBOX_PREVIEW_DIR=/app/data/sandbox-worker/previews
SANDBOX_WORKER_TOKEN=随机长密钥
SANDBOX_CAPABILITY_SECRET=另一个仅主应用持有的随机长密钥
SANDBOX_PREVIEW_ORIGIN=https://preview.xiaozhu.elin521.cn
SANDBOX_FRAME_ANCESTORS=https://xiaozhu.elin521.cn
```

反向代理必须把浏览器访问的域名原样放进上游 `Host`（Nginx 可用
`proxy_set_header Host $host`），让主 API 能识别独立预览 Origin 并下发正确的 CSP；
当前实现不会把客户端可伪造的 `X-Forwarded-Host` 当成隔离依据。
`SANDBOX_CAPABILITY_SECRET` 不得注入 Worker。

独立预览 Origin 是隔离边界。浏览器截图仍应由 iframe 内的受控 bridge 生成后通过
`postMessage` 回传，或由服务端浏览器完成；父页面不直接读取预览 DOM。

## 目录

```text
web/                    主前端
web-admin/              管理后台
server/app/             FastAPI、Agent、数据模型
server/templates/       Worker 使用的可信项目模板
sandbox-worker/         容器内独立构建 Worker 进程
server/alembic/         数据库迁移
```
