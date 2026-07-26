# Tag-only 发版

小筑只通过 Git tag 触发生产镜像构建。推送 `master` 只更新源码，不再构建或覆盖
`latest` 镜像。

## 约定

- 发布标签：`release-v<版本>`
- ACR 镜像标签：`<版本>`
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

标签推送后，等待 ACR 构建成功。随后在生产部署目录的 `.env` 中设置：

```dotenv
XIAOZHU_IMAGE_TAG=2026.07.27-1
```

再拉取并重建应用容器：

```bash
docker compose pull xiaozhu
docker compose up -d --force-recreate xiaozhu
docker inspect xiaozhu --format '{{.State.Health.Status}}'
```

只有健康状态为 `healthy` 且线上真实预览通过，才算发版完成。回滚时把
`XIAOZHU_IMAGE_TAG` 改回上一个已验证版本并重建容器，不需要移动或覆盖镜像标签。
