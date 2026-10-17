# Durable Objects pool node: workerd + a tiny shell supervisor.
FROM node:22-bookworm-slim AS workerd
ARG TARGETARCH
ARG WORKERD_VERSION=1.20261014.1
WORKDIR /w
RUN PKG=$([ "$TARGETARCH" = "arm64" ] && echo linux-arm64 || echo linux-64) && \
    npm pack @cloudflare/workerd-$PKG@$WORKERD_VERSION && tar xzf cloudflare-workerd-*.tgz && cp package/bin/workerd /workerd

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini curl bubblewrap util-linux && rm -rf /var/lib/apt/lists/*
COPY --from=workerd /workerd /usr/local/bin/workerd
WORKDIR /app
COPY supervisor.sh spawner.sh ./
COPY dist/ ./dist/
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/supervisor.sh"]
