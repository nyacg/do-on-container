# syntax=docker/dockerfile:1.7
# celld (https://github.com/denoland/celld) single-node benchmark arm.
#
#   docker buildx build --platform linux/amd64 -t celld-bench bench/celld   # Cloudflare Containers
#   docker buildx build --platform linux/arm64 -t celld-bench bench/celld   # Apple Silicon, local
#
# Runs `celld dev`, which is one real celld node (same serving/LTX/ownership code
# paths as a fleet node) backed by celld's built-in local SQLite object store
# instead of S3/GCS/Azure. No MinIO, no network bucket.
FROM debian:bookworm-slim

ARG TARGETARCH
ARG CELLD_VERSION=v0.6.2
ARG ESBUILD_VERSION=0.28.2

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# celld release binary + esbuild (celld shells out to esbuild to bundle the Worker at startup).
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) CELLD_ARCH=x86_64;  ESBUILD_ARCH=x64 ;; \
      arm64) CELLD_ARCH=aarch64; ESBUILD_ARCH=arm64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/denoland/celld/releases/download/${CELLD_VERSION}/celld-${CELLD_ARCH}-unknown-linux-gnu.gz" \
      | gunzip > /usr/local/bin/celld; \
    chmod 755 /usr/local/bin/celld; \
    curl -fsSL "https://registry.npmjs.org/@esbuild/linux-${ESBUILD_ARCH}/-/linux-${ESBUILD_ARCH}-${ESBUILD_VERSION}.tgz" \
      | tar -xz -C /tmp; \
    install -m 755 /tmp/package/bin/esbuild /usr/local/bin/esbuild; \
    rm -rf /tmp/package; \
    celld --version; esbuild --version

WORKDIR /app
COPY app/ /app/

ENV NO_COLOR=1
EXPOSE 8080

# --clean: Cloudflare Container disk is ephemeral anyway; start from empty state.
# --no-watch: no file watcher / rebuild loop.
# State (SQLite cell DBs + the local object store) lives in /app/.celld/dev.
ENTRYPOINT ["celld", "dev", "/app", "--host", "0.0.0.0", "--port", "8080", "--no-watch", "--clean"]
