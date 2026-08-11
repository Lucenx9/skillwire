# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

FROM ${NODE_IMAGE} AS toolchain
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
WORKDIR /app

FROM toolchain AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store-dev,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

FROM dependencies AS build
COPY tsconfig.json vitest.config.ts eslint.config.mjs .prettierrc.json ./
COPY src ./src
RUN pnpm build

FROM dependencies AS test
COPY . .
RUN pnpm build && chmod -R a+rX /app
CMD ["pnpm", "test"]

FROM toolchain AS production-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store-prod,target=/pnpm/store,sharing=locked \
    pnpm install --prod --frozen-lockfile

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --gid 10001 skillwire \
    && useradd --uid 10001 --gid skillwire --no-create-home --shell /usr/sbin/nologin skillwire
COPY --from=production-dependencies --chown=skillwire:skillwire /app/node_modules ./node_modules
COPY --from=build --chown=skillwire:skillwire /app/dist/src ./dist/src
COPY --chown=skillwire:skillwire package.json ./package.json
COPY --chown=skillwire:skillwire catalog ./catalog
COPY --chown=skillwire:skillwire migrations ./migrations
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/src/main.js"]
