# 后端预览沙箱

## 请求链路

1. Agent 写入一轮文件并发出 `preview_refresh`。
2. 前端将当前完整文件快照提交到
   `POST /api/sessions/{session_id}/sandbox-build`。
3. FastAPI 校验登录态与会话归属，再用内网 Token 转发给 Worker。
4. Worker 把源码写入临时任务目录，用可信模板覆盖构建配置，链接镜像内固定
   `node_modules`，串行执行 `vite build --base=./`。
5. 成功产物移动到持久化预览目录，Worker 返回独立 Origin URL。
6. 前端 iframe 加载该 URL，通过很小的 `postMessage` 桥回传导航状态和运行时错误。
7. 前端把编译/运行结果回报 `build-result`，唤醒 Agent 的 `check_build`。

## 配置

主服务：

```dotenv
SANDBOX_WORKER_URL=http://sandbox-worker:8010
SANDBOX_WORKER_TOKEN=随机长密钥
SANDBOX_BUILD_TIMEOUT_S=75
```

Worker：

```dotenv
SANDBOX_PORT=8010
SANDBOX_DATA_DIR=/data
SANDBOX_WORKER_TOKEN=与主服务一致
SANDBOX_PUBLIC_BASE_URL=https://preview.example.com
SANDBOX_FRAME_ANCESTORS=https://app.example.com
```

`SANDBOX_PUBLIC_BASE_URL` 必须是浏览器可访问的地址，不能填写仅容器内可解析的服务名。
生产环境必须与主站不同源，避免生成页面读取主站 `localStorage`。

## 2C2G 试跑建议

- 保持 Worker 单并发。
- 先使用 Compose 中的 1200MB 内存与 1.5 CPU 限额。
- Worker 镜像由 CI/ACR 构建，生产机只拉镜像。
- 观察 `docker stats` 与宿主机 OOM 日志；若峰值长期接近 2GB，再升级内存。

## 当前边界

- 只支持固定 React/Vite/Tailwind 模板，不是任意依赖或任意命令执行平台。
- 运行时错误仍由预览 iframe 回传；服务端 Playwright 截图尚未接入。
- 每个会话只保留最近 3 份 Worker 预览，分享链接不是永久存档。
