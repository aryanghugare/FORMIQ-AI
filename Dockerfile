FROM node:22.22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22.22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22.22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 FORMIQ_DATA_DIR=/app/data
RUN addgroup -S -g 1001 formiq && adduser -S -u 1001 -G formiq formiq && mkdir /app/data && chown formiq:formiq /app/data
COPY --from=builder --chown=formiq:formiq /app/.next/standalone ./
COPY --from=builder --chown=formiq:formiq /app/.next/static ./.next/static
COPY --from=builder --chown=formiq:formiq /app/public ./public
USER formiq
EXPOSE 3000
CMD ["node", "server.js"]
