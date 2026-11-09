# The Bassapps sign-in service as one container: the service, serving the pages it builds here.
# tools/ship-pi.sh builds it for a Raspberry Pi; deploy/pi/account.compose.yml runs it there.

# The pages, built once on the machine doing the building (they're the same on every platform)
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS pages
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.ts tsconfig.json ./
COPY pages/ pages/
RUN npm run build

# The service, serving them
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY service/ service/
COPY --from=pages /src/dist dist/
# Its data: door.sqlite, door.key and internal.key (back them up together). /run/bassapps can
# hold internal.key apart, shared with the apps (DOOR_SECRET_FILE; compose.yml)
RUN mkdir -p /data /run/bassapps && chown node:node /data /run/bassapps
ENV DOOR_DATA_DIR=/data DOOR_HOST=0.0.0.0 DOOR_PORT=3102 DOOR_STATIC=/app/dist
USER node
EXPOSE 3102
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3102/door-api/status').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "service/bin/door.ts"]
