# Optional multi-stage Node image for non-Nix local dev (Neo uses packages.neo-autofix).
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV OPS_DB_PATH=/data/ops.sqlite
RUN addgroup -S autofix && adduser -S autofix -G autofix \
  && mkdir -p /data && chown -R autofix:autofix /data
COPY --from=deps /app/node_modules ./node_modules
COPY app/ ./
USER autofix
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
