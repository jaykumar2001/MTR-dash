# ---- Stage 1: build mtr from source (latest tag) ----
FROM debian:bookworm-slim AS mtr-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates build-essential autoconf automake libtool pkg-config \
      libjansson-dev libcap-dev gettext \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone https://github.com/traviscross/mtr.git . \
    && LATEST_TAG=$(git tag -l 'v*' | sort -V | tail -n1) \
    && git checkout "$LATEST_TAG"
RUN ./bootstrap.sh \
    && ./configure --without-gtk --without-ncurses --without-ncursesw \
    && make -j"$(nproc)" \
    && make install DESTDIR=/opt/mtr-install

# ---- Stage 2: build the frontend ----
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Stage 3: build the backend ----
FROM node:20-bookworm-slim AS backend-builder
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build
# Fetches ipdeny.com's country IP-block lists (IPv4 + IPv6) and converts
# them into compact JSON range arrays using this project's own tested
# ipMath conversion logic (dist/geoip/ipMath.js, just built above) — the
# runtime image ends up with no network dependency on ipdeny.com at all.
RUN node scripts/build-geoip-data.mjs /app/backend/geoip-data

# ---- Stage 4: runtime ----
FROM node:20-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      libjansson4 libcap2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=mtr-builder /opt/mtr-install/usr/local /usr/local
# mtr's `make install` places binaries in /usr/local/sbin; symlink into
# /usr/local/bin so MTR_BIN=/usr/local/bin/mtr (below) resolves correctly.
RUN ln -s /usr/local/sbin/mtr /usr/local/bin/mtr \
    && ln -s /usr/local/sbin/mtr-packet /usr/local/bin/mtr-packet

WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=backend-builder /app/backend/dist ./dist
COPY --from=backend-builder /app/backend/geoip-data ./geoip
COPY --from=frontend-builder /app/frontend/dist ./public

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/mtr-dash.sqlite3 \
    MTR_BIN=/usr/local/bin/mtr \
    STATIC_DIR=/app/public \
    GEOIP_DATA_DIR=/app/geoip

VOLUME /data
EXPOSE 3000
CMD ["node", "dist/index.js"]
