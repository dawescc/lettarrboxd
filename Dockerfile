FROM oven/bun:alpine

LABEL org.opencontainers.image.title="Lettarrboxd"
LABEL org.opencontainers.image.description="Sync your Letterboxd and Serializd watchlists to Radarr and Sonarr."
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://forgejo.dawes.cc/ryan/lettarrboxd"

HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=3 \
  CMD sh -c 'ts=$(cat /tmp/lettarrboxd.health 2>/dev/null); case "$ts" in ""| *[!0-9]*) exit 1;; esac; [ "$ts" -gt "$(date +%s)000" ]'

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production && rm -rf ~/.bun/install/cache

COPY src ./src

ENTRYPOINT ["bun", "src/index.ts"]
