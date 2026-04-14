FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/ ./src/
ENV CLAUDE_NET_PORT=4815
EXPOSE 4815
CMD ["bun", "run", "src/hub/index.ts"]
