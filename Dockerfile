# Build a real DWG decoder for the same libc/architecture as the runtime.
FROM node:22.22-alpine AS cad-converter
RUN apk add --no-cache build-base curl xz perl pkgconf
WORKDIR /build
RUN curl -fL --retry 3 https://github.com/LibreDWG/libredwg/releases/download/0.14/libredwg-0.14.tar.xz -o libredwg.tar.xz \
    && echo "62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275  libredwg.tar.xz" | sha256sum -c - \
    && tar -xJf libredwg.tar.xz
WORKDIR /build/libredwg-0.14
RUN ./configure --disable-bindings --disable-python --disable-docs --disable-shared --disable-write --disable-json --disable-werror --enable-release \
    && make -j2 -C src \
    && make -j2 -C programs dwg2dxf \
    && install -Dm755 programs/dwg2dxf /opt/cad/bin/dwg2dxf \
    && install -Dm644 COPYING /opt/cad/share/COPYING \
    && /opt/cad/bin/dwg2dxf --version

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
RUN apk add --no-cache su-exec && addgroup -S -g 1001 formiq && adduser -S -u 1001 -G formiq formiq && mkdir /app/data && chown formiq:formiq /app/data
COPY --from=cad-converter /opt/cad/bin/dwg2dxf /usr/local/bin/dwg2dxf
COPY --from=cad-converter /opt/cad/share/COPYING /usr/local/share/libredwg/COPYING
RUN dwg2dxf --version
COPY --from=builder --chown=formiq:formiq /app/.next/standalone ./
COPY --from=builder --chown=formiq:formiq /app/.next/static ./.next/static
COPY --from=builder --chown=formiq:formiq /app/public ./public
COPY --from=builder --chown=formiq:formiq /app/scripts/manage.mjs /app/scripts/manage-mongo.mjs ./scripts/
COPY --from=builder /app/scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
RUN chmod 755 scripts/docker-entrypoint.sh
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=12s --start-period=30s --retries=6 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
