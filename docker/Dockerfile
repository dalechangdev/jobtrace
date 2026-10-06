# syntax=docker/dockerfile:1
# JobTrace server: web UI, HTTP API, worker and scheduler, with headless Chromium.
# Built on the official Playwright image, whose version must match the
# `playwright` package in pnpm-lock.yaml (browsers and library ship together).
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CI=1
RUN npm install --global pnpm@8.15.5
WORKDIR /app

# Build the web UI with the full set of dependencies.
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:web

# The image that runs: sources (Node runs the TypeScript directly), production
# dependencies only, and the built UI.
FROM base AS runtime
COPY . .
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/apps/web/dist apps/web/dist

# Inside a container the server has to listen on all interfaces to be reachable
# through a published port. ALLOWED_HOSTS keeps it answering to localhost names
# only, which is right as long as the port is published on 127.0.0.1 (as the
# compose file does). To expose it further, set API_TOKEN and ALLOWED_HOSTS yourself.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=4317 \
    ALLOWED_HOSTS=localhost,127.0.0.1 \
    HEADLESS_ONLY=true
RUN mkdir -p /data && chown pwuser:pwuser /data
USER pwuser
VOLUME /data
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4317) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "apps/cli/bin/jobtrace.js", "serve"]
