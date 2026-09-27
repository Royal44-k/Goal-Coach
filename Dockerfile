# Exact runtime versions; Linux pull/build still requires target-host acceptance.
FROM node:24.20.0-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 pnpm_config_verify_deps_before_run=false
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.19.0 --ignore-scripts
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
# 13.0.3 has no install script. Build ONLY its supplied build-release script
# with node-gyp bundled in this pinned Node image's npm. Keep all other scripts denied.
RUN sqlite_dir="$(dirname "$(node -p 'require.resolve("better-sqlite3/package.json")')")" \
    && PATH="/usr/local/lib/node_modules/npm/node_modules/node-gyp/bin:$PATH" npm --prefix "$sqlite_dir" run build-release \
    && cp "$sqlite_dir/build/Release/better_sqlite3.node" "$sqlite_dir/prebuilds/linux-$(node -p process.arch).node" \
    && node -e 'const DB=require("better-sqlite3"); const db=new DB(":memory:"); if(db.prepare("SELECT 1 AS ok").get().ok!==1) process.exit(1); db.close()'

FROM dependencies AS builder
COPY . .
ENV APP_MODE=local APP_ORIGIN=http://127.0.0.1:3000 MODEL_PROVIDER=mock \
    DASHSCOPE_API_KEY="" DASHSCOPE_BASE_URL="" DATABASE_PATH=/tmp/goal-coach-build.db
RUN pnpm build

FROM node:24.20.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
    APP_MODE=invite DATABASE_PATH=/app/data/goal-coach.db \
    pnpm_config_verify_deps_before_run=false
# Full locked dependencies deliberately retained: tsx/admin/migrate must work here.
COPY --from=dependencies /usr/local/lib/node_modules/pnpm /usr/local/lib/node_modules/pnpm
RUN ln -s /usr/local/lib/node_modules/pnpm/bin/pnpm.mjs /usr/local/bin/pnpm \
    && mkdir -p /app/data && chown node:node /app/data
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/drizzle ./drizzle
COPY --from=builder --chown=node:node /app/package.json /app/pnpm-workspace.yaml /app/tsconfig.json /app/next.config.ts ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node -e 'fetch("http://127.0.0.1:3000/api/health",{signal:AbortSignal.timeout(3000)}).then(async r=>{if(!r.ok||(await r.json()).ok!==true)process.exit(1)}).catch(()=>process.exit(1))'
CMD ["sh", "-c", "pnpm deployment:check && pnpm db:migrate && exec node node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port 3000 --keepAliveTimeout 65000"]
