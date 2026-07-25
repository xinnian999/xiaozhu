# 后端预览沙箱

## 请求链路

1. Agent 写入一轮文件并发出 `preview_refresh`。
2. 前端将当前完整文件快照提交到
   `POST /api/sessions/{session_id}/sandbox-build`。
3. FastAPI 校验登录态与会话归属，再用内网 Token 转发给 Worker。
4. Worker 把源码写入临时任务目录，用可信模板覆盖构建配置，链接镜像内固定
   `node_modules`，串行执行 `vite build --base=./`。
5. 成功产物移动到持久化预览目录，Worker 返回 `build_id`。
6. FastAPI 用只存在于主 API 的独立密钥为本次产物签发不可猜的 capability，并返回
   预览 Origin 下的 URL：
   `{SANDBOX_PREVIEW_ORIGIN}/api/sandbox-preview/{capability}/...`。
7. iframe 请求该 URL 时，FastAPI 校验 capability，再从 Docker 内网 Worker 读取
   HTML、JS、CSS 和图片并逐字节返回；不是重定向。
8. iframe 通过很小的 `postMessage` bridge 回传导航状态、运行时错误和基础布局问题；
   `check_build` 时还会在 iframe 内生成限尺寸截图并回传二进制。
9. 前端上传截图并把编译/运行/布局结果回报 `build-result`，唤醒 Agent 的
   `check_build`。

capability 是临时 Bearer 凭证。iframe 导航和静态资源请求不会携带前端保存在
`localStorage` 中的 API Token，因此 capability 必须包含在 URL 路径中，让相对资源
继续落在同一个受保护的路径前缀下。拿到该 URL 的人可在产物被回收前访问预览，不要
把 capability 发送给不应访问该预览的第三方。

## 配置

主服务：

```dotenv
SANDBOX_WORKER_URL=http://sandbox-worker:8010
SANDBOX_WORKER_TOKEN=随机长密钥
SANDBOX_CAPABILITY_SECRET=另一个仅主 API 持有的随机长密钥
SANDBOX_BUILD_TIMEOUT_S=75
SANDBOX_PREVIEW_ORIGIN=https://preview.example.com
SANDBOX_FRAME_ANCESTORS=https://app.example.com
```

Worker：

```dotenv
SANDBOX_PORT=8010
SANDBOX_DATA_DIR=/data
SANDBOX_WORKER_TOKEN=与主服务一致
```

Worker 不再生成浏览器 URL，因此不需要 `SANDBOX_PUBLIC_BASE_URL`。生产 Compose
通过服务名 `sandbox-worker:8010` 访问 Worker；宿主机端口只绑定
`127.0.0.1:8010` 方便源码开发，公网入口只连接主应用。

`SANDBOX_WORKER_TOKEN` 只负责主 API → Worker 的内部鉴权；
`SANDBOX_CAPABILITY_SECRET` 只负责浏览器预览 capability 的签名，绝不能把后者注入
Worker。留空时主 API 会兼容性回退到 `JWT_SECRET`，生产环境建议显式使用独立密钥。

## 浏览器隔离与截图

推荐把 `/api/sandbox-preview/...` 这个主 API 路由同时暴露到独立预览域名；该域名
仍反代到主 API，不直接连接 Worker。iframe 可在独立 Origin 下使用
`sandbox="allow-scripts allow-same-origin ..."`，让生成应用拥有自己的 storage，
同时不能读取小筑主站。

反向代理需要把浏览器访问的域名原样写入上游 `Host`（例如 Nginx 的
`proxy_set_header Host $host`）。主 API 不信任客户端可伪造的
`X-Forwarded-Host`，而是按实际请求 Host 决定 CSP 是否允许预览自己的
same-origin；若 Host 被错误改成主站或内部域名，它会自动降级为 opaque sandbox，
避免把主站权限交给生成页面。

若 `SANDBOX_PREVIEW_ORIGIN` 留空，构建 API 返回主站相对 URL。前端会自动去掉
`allow-same-origin`，浏览器把预览文档放进 opaque origin；这种回退更容易部署，但
生成应用不能使用 `localStorage`。由于 html2canvas 的克隆文档也会继承 opaque
sandbox，这个回退模式只做运行时和布局检查，不保证自动截图；正式演示应配置独立
预览 Origin。

因此：

- 生成代码不能读取父页面 DOM、Cookie 或主站 `localStorage`；
- 父页面也不能直接读取 iframe DOM；
- `postMessage` 必须同时校验 `event.source === iframe.contentWindow` 与配置的独立
  Origin；opaque 回退模式则要求 `event.origin === "null"`；
- 截图由可信 `index.html` 注入的 bridge 在 iframe 内生成，通过带 `documentId` 的
  请求/响应回传；父页面不会读取预览 DOM。回传结果还有尺寸、类型和字节上限。

把 `allow-scripts` 与 `allow-same-origin` 同时授予主站同源预览会破坏隔离边界；
前端只会在 URL 的 Origin 与主站不同时加入 `allow-same-origin`。

## 2C2G 试跑建议

- 保持 Worker 单并发。
- 先使用 Compose 中的 1200MB 内存与 1.5 CPU 限额。
- Worker 镜像由 CI/ACR 构建，生产机只拉镜像。
- Worker 的宿主机端口仅绑定 `127.0.0.1:8010`，不发布到公网网卡。
- 观察 `docker stats` 与宿主机 OOM 日志；若峰值长期接近 2GB，再升级内存。

## 当前边界

- 只支持固定 React/Vite/Tailwind 模板，不是任意依赖或任意命令执行平台。
- 当前 Worker 适用于项目作者自己的面试演示和可信低并发场景，不是面对恶意租户的
  OS 级安全边界。源码路径、可信配置和 CSS 图检查属于纵深防御，不能替代每任务独立
  容器/微 VM、网络策略、任务 UID 和 cgroup。
- 运行时错误、布局检查和截图由预览 iframe bridge 回传；服务端 Playwright 截图
  尚未接入。
- 每个会话只保留最近 3 份 Worker 预览，分享链接不是永久存档。
