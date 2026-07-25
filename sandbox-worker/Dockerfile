# syntax=docker/dockerfile:1
#
# 固定模板的后端构建 Worker。依赖在 ACR 构建镜像时一次性安装，线上每个任务只写源码
# 并执行 vite build，绝不在 2G 服务器上临时 npm install。
FROM crpi-a7p27yxlrmekg1a3.cn-beijing.personal.cr.aliyuncs.com/elin-common/bun:1

WORKDIR /opt/template

COPY server/templates/vite-react/package.json ./
RUN bun install

# 骨架配置由镜像持有，用户提交同名文件时也会被这里的可信版本覆盖。
COPY server/templates/vite-react/.npmrc ./
COPY server/templates/vite-react/index.html ./
COPY server/templates/vite-react/postcss.config.js ./
COPY server/templates/vite-react/tailwind.config.js ./
COPY server/templates/vite-react/tsconfig.json ./
COPY server/templates/vite-react/vite.config.ts ./

WORKDIR /app
COPY sandbox-worker/package.json ./
COPY sandbox-worker/index.ts ./

RUN mkdir -p /data/jobs /data/previews && chown -R bun:bun /data

USER bun

ENV SANDBOX_PORT=8010
ENV SANDBOX_DATA_DIR=/data
EXPOSE 8010

CMD ["bun", "run", "index.ts"]
