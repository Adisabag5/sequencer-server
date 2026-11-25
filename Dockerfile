# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# sequencer-server — production image
#
# Two stages. The builder has the whole toolchain (TypeScript, the Nest CLI,
# every devDependency) and is thrown away; only `dist/` and the production
# node_modules are copied into the final image. That is the point of a
# multi-stage build: the thing you ship has no compiler in it to exploit, and
# it is a few hundred MB instead of a gigabyte.
#
# Base is Debian slim rather than Alpine: Alpine is musl, and native modules
# (bcrypt here) are a category of problem you do not want on a deploy box.
# `-slim` is already small, and the tag pins Node 24 to match .nvmrc.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS builder

# Corepack reads the "packageManager" field in package.json, so the image uses
# pnpm 10.33.0 — the exact version the lockfile was written by — without us
# repeating the number here and letting the two drift.
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# Manifest and lockfile first, on their own layer: Docker re-runs a step only
# when its inputs change, so editing a .ts file does not reinstall every
# dependency. Copying src/ first would throw that cache away on every commit.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# --frozen-lockfile makes the build fail if package.json and pnpm-lock.yaml
# disagree, instead of quietly resolving something newer than what was tested.

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

RUN pnpm build

# Re-resolve node_modules with devDependencies left out. The packages come from
# pnpm's store, already downloaded above, so this is a relink rather than a
# second download. --ignore-scripts is safe here: the one native dependency,
# bcrypt, ships prebuilt binaries and resolves them at require time.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# ── Stage 2: run ─────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runner

# Baked in rather than left to .env, because it is the single most consequential
# value in this app: `production` is what turns TypeORM's `synchronize` off and
# `migrationsRun` on, and what puts `Secure` on the refresh cookie. A container
# built from this file is a production container.
ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# The node image ships an unprivileged `node` user. Running as root inside a
# container is not a disaster on its own, but it means a code-execution bug and
# a container-escape bug are one step apart instead of two.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node

EXPOSE 3000

# Asks the app the same question an uptime check would. /api/health does a real
# `SELECT 1`, so an image that boots but cannot reach MySQL is reported
# unhealthy rather than "running". No curl in the image — Node 24 has fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>r.json()).then(h=>process.exit(h.status==='ok'?0:1)).catch(()=>process.exit(1))"

# Exec form, so node is PID 1 and receives SIGTERM directly. main.ts calls
# enableShutdownHooks(), which closes the DB pool and drains in-flight requests
# — the difference between a clean redeploy and dropped connections.
CMD ["node", "dist/main"]
