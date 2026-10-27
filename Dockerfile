# 语法版本固定：避免不同 Docker 版本对 COPY/ARG 的解析差异
# 构建上下文是仓库根目录（镜像里的 /app 对应仓库的 app/）
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production
# prisma 的查询引擎需要 openssl；ca-certificates 用于连 SMTP/IMAP 的 TLS
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

# ---------- 依赖 ----------
FROM base AS deps
# 构建阶段必须有 devDependencies（tsc、prisma CLI），否则构建直接失败
ENV NODE_ENV=development
WORKDIR /app
COPY app/pnpm-lock.yaml app/pnpm-workspace.yaml app/package.json ./
COPY app/apps/api/package.json apps/api/package.json
COPY app/apps/web/package.json apps/web/package.json
# 需要 devDependencies 才能跑 tsc，运行期镜像里再裁掉
RUN pnpm install --frozen-lockfile

# ---------- 构建 ----------
FROM deps AS build
WORKDIR /app
COPY app/ ./
RUN pnpm --filter @mailer/api exec prisma generate \
 && pnpm --filter @mailer/api build

# ---------- 运行 ----------
FROM base AS runtime
WORKDIR /app
# 只带生产依赖：pnpm 的软链结构要求保留根 node_modules 与 apps/api/node_modules
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /data/uploads /data/tmp \
 && chown -R node:node /data /app

USER node
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
# worker 服务在本镜像上覆盖成 node apps/api/dist/worker.js
CMD ["node", "apps/api/dist/main.js"]
