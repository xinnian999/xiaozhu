# 后端预览沙箱

## 请求链路

1. Agent 写完一轮文件后调用 `check_build`。
2. FastAPI 把数据库文件与同批工具 overlay 合成完整快照，再用内网 Token 提交给 Worker。
   浏览器也可以调用鉴权后的 `POST /api/sessions/{session_id}/sandbox-build` 刷新交互预览，
   但不参与 Agent 验收。
3. Worker 把源码写入临时任务目录，用可信模板覆盖构建配置，链接镜像内固定
   `node_modules`，串行执行 `vite build --base=./`。
4. 成功产物移动到持久化预览目录。只有 Agent 的 `check_build` 请求会在同一单并发临界区
   随后启动 Playwright Chromium，只从 Worker 的临时 loopback 静态服务器加载本次产物，
   采集运行时错误和固定画布截图，完成后立即关闭 Browser；普通交互预览刷新不启动浏览器。
5. Worker 返回 `build_id`、截图与可选运行时错误。
   `build_id` 由可信模板和源码内容生成；相同内容已有完整产物时直接复用，不重复执行
   Vite，但仍重新执行真实浏览器截图。
6. FastAPI 用只存在于主 API 的独立密钥为本次产物签发不可猜的 capability，并返回
   预览 Origin 下的 URL：
   `{SANDBOX_PREVIEW_ORIGIN}/api/sandbox-preview/{capability}/...`。
7. iframe 请求该 URL 时，FastAPI 校验 capability，再从共享预览目录直接返回
   HTML、JS、CSS 和图片；不是重定向，也不再请求 Worker。
8. FastAPI 严格校验 Worker 图片的 Base64、文件签名、真实尺寸和 2MiB 上限，落盘后把
   轻量截图引用附到 `check_build` ToolMessage，视觉模型无需等待用户浏览器即可检查。
9. iframe 只通过很小的 `postMessage` bridge 回传导航状态和在线运行时诊断；前端
   `build-result` 是交互预览的兼容增强，不再决定 Agent 是否继续。

capability 是临时 Bearer 凭证。iframe 导航和静态资源请求不会携带前端保存在
`localStorage` 中的 API Token，因此 capability 必须包含在 URL 路径中，让相对资源
继续落在同一个受保护的路径前缀下。拿到该 URL 的人可在产物被回收前访问预览，不要
把 capability 发送给不应访问该预览的第三方。

## 配置

主服务：

```dotenv
SANDBOX_WORKER_URL=http://127.0.0.1:8010
SANDBOX_WORKER_TOKEN=随机长密钥
SANDBOX_CAPABILITY_SECRET=另一个仅主 API 持有的随机长密钥
SANDBOX_PREVIEW_DIR=/app/sandbox-data/previews
SANDBOX_BUILD_TIMEOUT_S=100
SANDBOX_PREVIEW_ORIGIN=https://preview.example.com
SANDBOX_FRAME_ANCESTORS=https://app.example.com
```

同一容器内的 Worker 进程：

```dotenv
SANDBOX_PORT=8010
SANDBOX_HOST=127.0.0.1
SANDBOX_DATA_DIR=/app/sandbox-data
SANDBOX_TEMPLATE_DIR=/app/templates/vite-react
SANDBOX_WORKER_TOKEN=与主服务一致
SANDBOX_BUILD_TIMEOUT_MS=60000
SANDBOX_CAPTURE_TIMEOUT_MS=12000
```

Worker 不生成浏览器 URL，也不提供静态预览接口，因此不需要
`SANDBOX_PUBLIC_BASE_URL`。生产入口脚本在同一个容器内启动 FastAPI 和 Node Worker；
宿主的 `sandbox-worker` 子目录独立挂载到 `/app/sandbox-data`，主服务与 Worker
在这里共享产物；数据库卷根目录继续保持 `0700 root`，UID 10001 无需也不能穿越它。
主服务只通过 `127.0.0.1:8010` 发起构建。
Compose 不发布 8010，公网入口只连接主应用的 8000。
容器先 `cap_drop: ALL`，再只保留 `CHOWN/SETGID/SETUID/KILL`：前三项用于交接
沙箱目录并降权，`KILL` 只让 root 入口监管不同 UID 的 Worker 子进程；生产不得启用
host PID namespace。

从旧版 root Worker 过渡时，可在新镜像首次稳定运行前临时设置
`SANDBOX_FORCE_STORAGE_REPAIR=1`。它会忽略权限 marker，完整复核旧 Worker
可能新增的深层缓存；当 UID 10001 版本已成为回滚基线后应移除，恢复快速启动。

`SANDBOX_WORKER_TOKEN` 只负责主 API → Worker 的内部鉴权；
`SANDBOX_CAPABILITY_SECRET` 只负责浏览器预览 capability 的签名，绝不能把后者注入
Worker。留空时主 API 会兼容性回退到 `JWT_SECRET`，生产环境建议显式使用独立密钥。
生产入口使用 `env -i` 启动 Worker，并固定 60 秒构建与 12 秒完整截图生命周期；主 API
的 100 秒超时覆盖这两段与有界清理、响应传输和截图落盘余量，部署 `.env` 不能把 Worker
单独放宽到超过 API 的等待预算。

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

本地 `pnpm dev` 会把 `SANDBOX_FRAME_ANCESTORS` 默认设为 `*`，服务据此省略
`frame-ancestors` 指令，兼容 Chrome 扩展、桌面 WebView 和 HMR 可能附加的 opaque
调试祖先；响应级 CSP sandbox 与 iframe sandbox 仍然保留。该宽松值只用于 loopback
开发；生产部署必须显式配置真实主站 Origin，不能沿用 `*`。

若 `SANDBOX_PREVIEW_ORIGIN` 留空，构建 API 返回主站相对 URL。前端会自动去掉
`allow-same-origin`，浏览器把交互预览文档放进 opaque origin；这种回退更容易部署，
但生成应用不能使用 `localStorage`。服务端 Playwright 截图不经过这个 iframe，因而不受
用户浏览器的 opaque origin、刷新或后台状态影响。

因此：

- 生成代码不能读取父页面 DOM、Cookie 或主站 `localStorage`；
- 父页面也不能直接读取 iframe DOM；
- `postMessage` 必须同时校验 `event.source === iframe.contentWindow` 与配置的独立
  Origin；opaque 回退模式则要求 `event.origin === "null"`；
- Playwright 每次只访问本次 loopback 预览，默认阻断其它 HTTP(S)、WebSocket 与文件
  URL；每次新建隔离 Context，截图后关闭 Browser。交互 iframe 和父页面都不参与截图；
- 服务端截图中的图片、字体和数据必须来自构建产物或 `data:`/`blob:`，不能依赖公网 URL。
  这是阻止生成页面借 Chromium 访问容器内网的安全边界，因此交互 iframe 若加载了公网
  资源，视觉上可能与模型看到的服务端截图不同。

把 `allow-scripts` 与 `allow-same-origin` 同时授予主站同源预览会破坏隔离边界；
前端只会在 URL 的 Origin 与主站不同时加入 `allow-same-origin`。

## 单容器与 2C2G 试跑建议

- 保持 Worker 单并发。
- Compose 对 API 与 Worker 的整个容器限制 1800MB 内存与 2 CPU。
- Vite 构建进程退出后才能启动 Chromium；每次只截一个 1280×720 桌面画布或
  390×844 H5 画布，截图结束立即回收浏览器进程。
- Chromium 使用独立 `/dev/shm`，截图失败只降级为无图，不能推翻已经可信的编译结论。
- 公开预览刷新不启动 Chromium；只有 `check_build` 会请求真实截图。
- 单一应用镜像由 CI/ACR 构建，生产机只拉镜像。
- Worker 只监听容器内 `127.0.0.1:8010`，Compose 不映射该端口。
- 观察 `docker stats` 与宿主机 OOM 日志；若峰值长期接近 2GB，再升级内存。

## 当前边界

- 只支持固定 React/Vite/Tailwind 模板，不是任意依赖或任意命令执行平台。
- 当前 Worker 适用于项目作者自己的面试演示和可信低并发场景，不是面对恶意租户的
  OS 级安全边界。源码路径、可信配置和 CSS 图检查属于纵深防御，不能替代每任务独立
  容器/微 VM、网络策略、任务 UID 和 cgroup。
- 单容器意味着 API、Vite 与 Chromium 共用同一个 cgroup；1800MB 是整个容器的上限，
  无法再给 Chromium 单独设硬内存限制。失控页面仍可能触发整个容器 OOM，这属于接受的
  可信低并发部署边界。
- 运行时错误和模型截图由同容器 Worker 的 Playwright 采集；交互 iframe 只补充用户当前
  标签页的导航与诊断状态。
- 每个会话只保留最近 3 份 Worker 预览，分享链接不是永久存档。
