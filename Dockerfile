FROM oven/bun:1.4.2

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bunx prisma generate && bun run build

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

USER bun
EXPOSE 3000

CMD ["bun", "run", "start"]
