FROM node:22-bookworm-slim AS fetch
ARG TARGETARCH
WORKDIR /w
RUN PKG=$([ "$TARGETARCH" = "arm64" ] && echo linux-arm64 || echo linux-64) && \
    npm pack @cloudflare/workerd-$PKG@1.20261014.1 && tar xzf cloudflare-workerd-*.tgz && cp package/bin/workerd /workerd

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini curl procps bubblewrap libcap2-bin util-linux && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /workerd /usr/local/bin/workerd
WORKDIR /app
COPY worker.js config.docker.capnp supervisor.sh probe.sh ./
RUN mkdir -p /data
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/supervisor.sh"]
