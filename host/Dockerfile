# Build from the repo root, for Akash (amd64):
#   docker buildx build --platform linux/amd64 -f host/Dockerfile -t ghcr.io/<you>/share-me-host:0.1.0 --push .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY host/package.json host/tsconfig.json host/
COPY mcp/package.json mcp/
RUN npm ci --ignore-scripts
COPY host/src host/src
RUN npx tsc -p host

# Production dependencies of the host only (hoisted to /app/node_modules by the workspace install).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY host/package.json host/
COPY mcp/package.json mcp/
RUN npm ci --omit=dev --ignore-scripts --workspace host && rm -f node_modules/share-me-host node_modules/share-me-mcp

FROM node:22-alpine
# su-exec lets the entrypoint fix ownership of Akash's root-owned persistent volume, then drop to the node user.
RUN apk add --no-cache su-exec
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
WORKDIR /app
COPY host/package.json ./package.json
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/host/dist ./dist
COPY site/index.html site/imprint.html site/privacy.html ./site/
COPY site/fonts ./site/fonts
RUN mkdir -p /data && chown node:node /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# Non-recursive: only the volume root needs fixing; everything inside is created by the node user.
CMD ["sh", "-c", "chown node:node \"$DATA_DIR\" && exec su-exec node node dist/index.js"]
