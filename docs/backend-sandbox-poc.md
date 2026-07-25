# 后端预览沙箱 PoC

这个分支把“预览运行时”抽成部署级开关：

- `PREVIEW_RUNTIME=webcontainer`：完整保留原实现，也是默认值。
- `PREVIEW_RUNTIME=server`：浏览器把当前完整文件快照提交给主 API，再由独立
  `sandbox-worker` 构建并从独立 Origin 提供预览。

第一阶段只迁移构建和预览，运行时错误通过一个很小的 `postMessage` 桥回传。
现有 html2canvas 截图链路不再用于 server 模式；Playwright 截图留到下一阶段。

## 为什么 2C2G 能先跑

Worker 镜像在 ACR 构建时已经装好固定模板依赖。线上任务不执行 `npm install`，
只执行单次 `vite build`，并且：

- 同时最多一个任务；
- Worker 内存限制 1200MB、内存+swap 上限 1800MB；
- CPU 1.5 核；
- PID 上限 128；
- 构建默认 60 秒超时；
- 最多 200 个文件、源码总计 5MB、单文件 512KB；
- 只保留每个会话最近 3 份预览。

## 本地试跑

先生成一个只用于 Worker 内网鉴权的随机密钥：

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

在部署目录 `.env` 增加：

```dotenv
PREVIEW_RUNTIME=server
SANDBOX_WORKER_URL=http://sandbox-worker:8010
SANDBOX_WORKER_TOKEN=替换为上面生成的随机值
SANDBOX_PUBLIC_BASE_URL=http://localhost:8010
SANDBOX_FRAME_ANCESTORS=http://localhost:5173
```

本地构建并启动：

```bash
docker compose --profile sandbox up -d --build
```

健康检查：

```bash
curl http://127.0.0.1:8010/health
curl http://127.0.0.1:8000/api/preview-runtime
```

观察 2G 机器的真实峰值：

```bash
docker stats xiaozhu xiaozhu-sandbox-worker
free -h
journalctl -k | grep -i -E 'oom|killed process'
```

## 生产部署

不要在 2G 服务器上构建 Worker 镜像。新增一个 ACR 仓库
`elin/xiaozhu-sandbox`，构建上下文选仓库根目录，Dockerfile 选
`sandbox-worker/Dockerfile`，由 ACR 构建并推送 `latest`。

建议增加独立域名：

```text
preview.xiaozhu.elin521.cn -> 宿主机 8010
```

相应环境变量：

```dotenv
SANDBOX_PUBLIC_BASE_URL=https://preview.xiaozhu.elin521.cn
SANDBOX_FRAME_ANCESTORS=https://xiaozhu.elin521.cn
```

预览必须使用独立 Origin，不能挂到主站同源路径。当前主站 JWT 位于 localStorage，
同源生成页面可以直接读取登录凭证。

## 当前边界

- 这是固定 React/Vite/Tailwind 模板的隔离构建器，不是通用代码执行平台。
- Worker 忽略客户端提交的 `package.json`、Vite、Tailwind、PostCSS、tsconfig、
  `.npmrc` 和 `index.html`，始终使用镜像中的可信骨架。
- server 模式暂时没有可靠截图，因此 `check_build` 仍能收到编译与运行时错误，
  但 Agent 不会获得视觉截图。
- 下一阶段是在 Worker 中串行启动 Playwright：收集 `console/pageerror`、执行布局检查、
  直接 `page.screenshot()`，随后完全删除 server 模式的浏览器运行时桥。
