# cra-agent collector. Build context = repo root.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/accounting/package.json packages/accounting/
COPY packages/collector/package.json packages/collector/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npx tsc -b packages/accounting packages/collector

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/accounting/package.json packages/accounting/
COPY --from=build /app/packages/collector/package.json packages/collector/
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/packages/accounting/dist packages/accounting/dist
COPY --from=build /app/packages/collector/dist packages/collector/dist
COPY --from=build /app/packages/collector/sql packages/collector/sql
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8790/health >/dev/null || exit 1
CMD ["node", "packages/collector/dist/main.js"]
