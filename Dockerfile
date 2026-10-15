# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS deps

WORKDIR /app

ARG NPM_VERSION=11.19.0

COPY package.json package-lock.json ./
RUN npm install -g npm@${NPM_VERSION} && npm ci

FROM deps AS build

ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_PUBLIC_APP_URL
# Sentry (opcional). Sem VITE_SENTRY_DSN o front-end nao inicializa o Sentry.
ARG VITE_SENTRY_DSN=
ARG VITE_SENTRY_TRACES_SAMPLE_RATE=
# Upload de source maps (opcional): so roda com SENTRY_ORG + SENTRY_PROJECT +
# o secret de build "sentry_auth_token". Sem eles o build fica identico.
ARG SENTRY_ORG=
ARG SENTRY_PROJECT=
ARG SENTRY_RELEASE=

ENV NODE_ENV=production
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_PUBLIC_APP_URL=$VITE_PUBLIC_APP_URL
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ENV VITE_SENTRY_TRACES_SAMPLE_RATE=$VITE_SENTRY_TRACES_SAMPLE_RATE

COPY . .
# The auth token comes from an optional BuildKit secret so it never lands in
# image layers or `docker history`.
RUN --mount=type=secret,id=sentry_auth_token,required=false \
  SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" \
  SENTRY_ORG="$SENTRY_ORG" SENTRY_PROJECT="$SENTRY_PROJECT" SENTRY_RELEASE="$SENTRY_RELEASE" \
  npm run build \
  && find .output -name '*.map' -path '*/public/*' -delete

# Nitro bundles the app into .output, but instrument.mjs runs before the app
# and imports @sentry/node from /app/node_modules. Install exactly the version
# pinned in package.json (it must match the @sentry/core bundled in .output).
FROM node:22-bookworm-slim AS sentry-runtime

WORKDIR /sentry

COPY package.json /tmp/package.json
RUN SENTRY_NODE_VERSION="$(node -p "require('/tmp/package.json').dependencies['@sentry/node']")" \
  && echo '{"name":"sentry-runtime","private":true}' > package.json \
  && npm install --omit=dev --no-audit --no-fund --save-exact "@sentry/node@${SENTRY_NODE_VERSION}"

FROM node:22-bookworm-slim AS runner

WORKDIR /app

ARG SENTRY_RELEASE=

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
# Pode ser sobrescrito pelo .env / environment do compose.
ENV SENTRY_RELEASE=$SENTRY_RELEASE

COPY --from=sentry-runtime --chown=node:node /sentry/node_modules ./node_modules
COPY --from=build --chown=node:node /app/instrument.mjs ./instrument.mjs
COPY --from=build --chown=node:node /app/.output ./.output

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const port=process.env.PORT||3000; fetch('http://127.0.0.1:'+port+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "./instrument.mjs", ".output/server/index.mjs"]
