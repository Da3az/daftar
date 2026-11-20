# Daftar API — multi-stage, non-root, with the heap limit set explicitly.
#
# ## Why `--max-old-space-size` is not left to the default
#
# Node derives a default heap limit from the machine's total memory, and a
# container memory limit set by cgroups is not total machine memory from the
# runtime's point of view on every kernel and runtime combination. A container
# capped at 512 MB can therefore run with a V8 heap limit sized for the host's
# 30 GB, which means V8 never feels pressure, never collects aggressively, and
# the OOM killer arrives before the garbage collector does.
#
# The failure looks nothing like a memory problem: the process is killed with no
# stack, no log line, and exit code 137. Setting the limit explicitly makes V8
# collect under pressure and, if it genuinely cannot fit, throw a heap-allocation
# error that names the problem.
#
# 384 MB against a 512 MB container cap — roughly 70%, leaving room for the
# non-heap allocations the heap limit does not cover: the pg driver's buffers,
# `external` memory, thread stacks, and the runtime itself.
#
# `--max-semi-space-size=16` accompanies a *lowered* heap limit. The default
# young-generation size scales with the heap, and a small heap gives a small
# semi-space, which makes scavenges frequent enough to cost measurable
# throughput on an allocation-heavy request path.
#
# ## Stage layout
#
# One `deps` stage for the full install (needed to build), one `build` stage,
# and a runtime stage that installs production dependencies only. Copying
# `node_modules` from the build stage would ship typescript, vitest, eslint and
# the whole toolchain into the runtime image.

# ---------------------------------------------------------------- base
# Pinned to the minor, matching .node-version. `-slim` not `-alpine`: the
# project's own PostgreSQL work is unaffected either way, but musl's allocator
# behaves differently under the fragmentation this workload produces, and every
# memory number in docs/ was measured against glibc.
FROM node:26.13.1-slim AS base
ENV NODE_ENV=production
WORKDIR /app

# ---------------------------------------------------------------- deps
FROM base AS deps

# Lockfile-only copy first, so a source change does not invalidate the install
# layer. The workspace manifests have to come too — `npm ci` resolves the
# workspace graph from them and fails without them.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/money/package.json ./packages/money/

# `npm ci` with dev dependencies: the build needs tsc. `--ignore-scripts` is
# deliberate — no dependency here has a legitimate install script this image
# needs, and running arbitrary postinstall code during an image build is a
# supply-chain surface for no benefit.
RUN npm ci --include=dev --ignore-scripts

# ---------------------------------------------------------------- build
FROM deps AS build

COPY tsconfig.base.json ./
COPY packages/money ./packages/money
COPY apps/api ./apps/api

# The workspace package must be built before the API compiles against it: Node
# refuses to strip types under node_modules, and npm workspaces symlink there.
RUN npm run build --workspace @daftar/money \
 && npm run build --workspace @daftar/api

# ------------------------------------------------------- production deps
FROM base AS prod-deps

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/money/package.json ./packages/money/

# `--omit=dev`, and `--workspace` to avoid installing the web app's React tree
# into an image that serves no frontend.
RUN npm ci --omit=dev --ignore-scripts --workspace @daftar/api --include-workspace-root

# ---------------------------------------------------------------- runtime
FROM base AS runtime

# `tini` as PID 1. Node does not reap zombies and does not forward signals to
# children, so without an init a `docker stop` can leave the graceful-shutdown
# path in server.ts unrun — which means closing the pool mid-transaction
# instead of draining first.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json

# ## The nested workspace `node_modules` is not optional
#
# npm hoists a workspace's dependencies to the root tree **only when there is no
# version conflict**. There is one here: `@opentelemetry/sdk-trace-node@2.12.0`
# peers on `@opentelemetry/api >=1.0.0 <1.10.0` while other OTel packages pull
# 1.10.0, so npm nests `sdk-trace-node` and its pinned peers under
# `apps/api/node_modules` instead. (Same skew as the one documented in
# `src/observability/tracing.ts`.)
#
# Copying only the root tree built an image that passed every build step and
# then died at startup with
# `ERR_MODULE_NOT_FOUND: Cannot find package '@opentelemetry/sdk-trace-node'`.
# Nothing about the build output hinted at it.
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules

COPY --from=build /app/packages/money/dist ./packages/money/dist
COPY --from=build /app/packages/money/package.json ./packages/money/package.json

COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json

# Migrations are copied as SQL, not run at build time and not run on boot.
# `drizzle-kit generate` → review the diff → `migrate` as a separate step; an
# app that migrates on startup turns a rolling deploy into N concurrent
# migration attempts against one database.
COPY apps/api/drizzle ./apps/api/drizzle
COPY apps/api/src/reports ./apps/api/src/reports

# The `node` user ships with the image as uid 1000. Used rather than created,
# and the application directory is left owned by root: the process needs to
# read its code, never to write it.
USER node

EXPOSE 3000

# Container-local, so the healthcheck does not depend on the network being
# reachable from outside. `/health/live` is exempt from the rate limiter —
# rate-limiting a liveness probe converts a traffic spike into an outage.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]

# Flags in the command, not in NODE_OPTIONS. NODE_OPTIONS is inherited by every
# child `node` process — including a `node` invoked by a migration or a one-off
# script — and a heap limit sized for the server is the wrong limit for those.
CMD ["node", "--max-old-space-size=384", "--max-semi-space-size=16", "apps/api/dist/server.js"]
