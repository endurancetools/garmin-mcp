# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json nx.json tsconfig.base.json ./
COPY packages packages
COPY apps apps
# better-sqlite3 ships prebuilt addons (prebuilds/linux-*.node) and loads them first;
# its implicit node-gyp step only needs Python, which node:22-slim lacks, so skip scripts.
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm nx run-many -t build \
 && pnpm --filter garmin-mcp-cli deploy --prod --legacy --ignore-scripts /out

FROM node:22-slim
ENV NODE_ENV=production \
    GARMIN_DATA_DIR=/data \
    GARMIN_MCP_TRANSPORT=stdio \
    GARMIN_MCP_HOST=0.0.0.0
RUN useradd --create-home --uid 10001 garmin && mkdir -p /data && chown garmin /data && chmod 700 /data
COPY --from=build /out /app
USER garmin
VOLUME ["/data"]
EXPOSE 8000
# stdio by default; set GARMIN_MCP_TRANSPORT=streamable-http and GARMIN_MCP_HTTP_TOKEN for HTTP.
ENTRYPOINT ["node", "/app/dist/main.js"]
CMD ["serve"]
