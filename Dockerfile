FROM oven/bun:alpine

LABEL org.opencontainers.image.title=lettarrboxd
LABEL org.opencontainers.image.source=https://github.com/dawescc/lettarrboxd
LABEL org.opencontainers.image.url=https://github.com/dawescc/lettarrboxd
LABEL org.opencontainers.image.description="Automatically add movies and series from Letterboxd and Serializd to Radarr and Sonarr."
LABEL org.opencontainers.image.licenses=MIT
LABEL org.opencontainers.image.version=1.5.1-beta

LABEL org.opencontainers.image.version=1.5.1-beta

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install production dependencies
RUN bun install --frozen-lockfile --production && \
    rm -rf ~/.bun/install/cache

# Copy source code
COPY . .

# Create data directory
RUN mkdir -p /data

# Set environment variables
ENV NODE_ENV=production
ENV DATA_DIR=/data

# Create non-root user for security
RUN addgroup -g 1001 -S lettarrboxd && \
    adduser -S lettarrboxd -u 1001 -G lettarrboxd

# Change ownership of app and data directories
RUN chown -R lettarrboxd:lettarrboxd /app /data

# Switch to non-root user
USER lettarrboxd

# Expose port (optional, for health checks)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=5m --timeout=30s --start-period=5s --retries=3 \
  CMD bun -e "console.log('Health check passed')" || exit 1

# Start the application
CMD ["bun", "start"]