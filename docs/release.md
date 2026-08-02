# Tag-only 发版

小筑只通过 Git tag 触发生产镜像构建。推送 `master` 只更新源码，不再构建或覆盖
`latest` 镜像。

## 约定

- 发布标签：`release-v<版本>`
- ACR 镜像标签：`<版本>`
- `<版本>` 必须以数字开头，只允许字母、数字、点、下划线和短横线
- 示例：Git 标签 `release-v2026.07.27-1` 对应镜像
  `elin/xiaozhu:2026.07.27-1`
- 生产 Compose 必须显式设置 `XIAOZHU_IMAGE_TAG`，禁止使用 `latest`

ACR 只保留内置规则：

```text
tags: release-v$version
image: $version
```

## 发版

先把准备发布的提交合并并推送到 `master`，确认本地工作区干净，然后执行：

```bash
pnpm release:tag -- 2026.07.27-1
```

脚本会检查：

- 当前分支必须是 `master`
- 工作区必须干净
- 本地 `master` 必须与 `origin/master` 完全一致
- 同名发布标签不能已存在

标签推送后，ACR 完成构建并推送镜像，仓库触发器会向生产 webhook 发送镜像标签。
生产 webhook 仅接受以下回调：

- 仓库必须是 `elin/xiaozhu`
- 地域必须是 `cn-beijing`
- 镜像标签必须匹配 `^[0-9][0-9A-Za-z._-]*$`
- 回调必须携带正确的部署 Token

验证通过后，部署脚本会自动：

1. 把生产 `.env` 中的 `XIAOZHU_IMAGE_TAG` 原子更新为回调标签。
2. 拉取该不可变版本镜像并强制重建 `xiaozhu` 容器。
3. 等待容器进入 `healthy`，成功后才清理旧的无引用镜像。
4. 拉取、启动或健康检查失败时，先可靠停止失败候选，再用无网络、仅挂载沙箱
   缓存的短命容器恢复旧 Worker 权限，最后恢复上一个标签并重建旧版本。

部署日志位于生产服务器 `/var/log/xiaozhu-deploy.log`。只有健康状态为 `healthy`
且线上真实预览通过，才算发版完成。人工回滚时仍可把 `XIAOZHU_IMAGE_TAG` 改回
上一个已验证版本并重建容器，不需要移动或覆盖镜像标签。

## 生产 webhook

版本化实现位于 `deploy/webhook/`：

- `server.py`：鉴权、限制请求体、校验 ACR 仓库/地域/标签，再把部署任务串行排队
- `deploy.sh`：切换标签、拉取、重建、健康检查与失败回滚
- `test_server.py`：回调载荷校验的回归测试

ACR 触发器使用“表达式触发”，表达式与服务端保持一致：

```text
^[0-9][0-9A-Za-z._-]*$
```
