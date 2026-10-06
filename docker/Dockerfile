# syntax=docker/dockerfile:1
# ============================================================
# MarkFlow 生产镜像：多阶段构建
#   1) build 阶段：pnpm install + 前端 vite build + 服务端 esbuild bundle
#   2) runtime 阶段：Debian slim + 系统 Chromium + Noto CJK 中文字体
# 容器内 PDF 导出使用系统 Chromium（PUPPETEER_EXECUTABLE_PATH），
# 避免在容器里下载 Chrome 与字体缺失问题（PRD：依赖隔离测试）。
# ============================================================

FROM node:22-bookworm-slim AS build
WORKDIR /repo

# corepack 启用 lockfile 中声明的 pnpm 版本
RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY server/package.json server/
COPY shared/package.json shared/
COPY web/package.json web/

# 构建阶段不下载 Chrome（运行时用系统 Chromium）
ENV PUPPETEER_SKIP_DOWNLOAD=1
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @markflow/web build \
  && pnpm --filter @markflow/server build \
  && pnpm --filter @markflow/server --prod deploy /out

# ---------------- runtime ----------------
FROM node:22-bookworm-slim AS runtime

# Chromium 运行依赖 + 中文字体 + emoji（Puppeteer PDF 中文渲染必需）
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium fonts-noto-cjk fonts-noto-color-emoji ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=1

WORKDIR /app

# pnpm deploy 产物：服务端 bundle + 生产依赖（含 @markflow/shared）
COPY --from=build /out /app
# 前端构建产物（Express 静态托管 + 导出页）
COPY --from=build /repo/web/dist /app/web/dist
# 首次启动播种数据（示例笔记 + 内置 Typora 主题）
COPY seeds /app/seeds

ENV NOTES_DIR=/data/notes \
    THEMES_DIR=/data/themes \
    WEB_DIST=/app/web/dist \
    PORT=8080 \
    HOST=::

RUN mkdir -p /data/notes /data/themes \
  && chown -R node:node /app /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
