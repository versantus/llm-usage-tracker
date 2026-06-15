FROM oven/bun:1.3.6-slim

WORKDIR /app

# Copy package files
COPY package.json bun.lockb ./
RUN bun install

# Copy source
COPY shared ./shared
COPY server ./server
COPY client ./client
COPY cli ./cli

EXPOSE 4317

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e "import('http').then(http => http.request('http://localhost:4317/api/health', {method:'GET'}, r => process.exit(r.statusCode===200?0:1)).end())" || exit 1

CMD ["bun", "run", "server/index.ts"]
