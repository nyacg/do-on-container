# Sandbox spike: production-like image (bookworm-slim + workerd) plus sandboxing tools.
FROM node:22-bookworm-slim AS workerd
ARG TARGETARCH
ARG WORKERD_VERSION=1.20261014.1
WORKDIR /w
RUN PKG=$([ "$TARGETARCH" = "arm64" ] && echo linux-arm64 || echo linux-64) && \
    npm pack @cloudflare/workerd-$PKG@$WORKERD_VERSION && tar xzf cloudflare-workerd-*.tgz && cp package/bin/workerd /workerd

# nsjail is not packaged for bookworm -> build from source.
FROM debian:bookworm-slim AS nsjail
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git make g++ pkg-config \
      autoconf bison flex libtool libprotobuf-dev protobuf-compiler libnl-route-3-dev
RUN git clone --depth 1 --branch 3.4 https://github.com/google/nsjail /nsjail && make -C /nsjail -j8

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tini curl procps util-linux libcap2-bin bubblewrap jq libprotobuf32 libnl-route-3-200 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=workerd /workerd /usr/local/bin/workerd
COPY --from=nsjail /nsjail/nsjail /usr/local/bin/nsjail
# setuid copy of bwrap for the 'bwrap-suid' variant (Debian ships bwrap non-setuid).
RUN cp /usr/bin/bwrap /usr/local/bin/bwrap-suid && chmod 4755 /usr/local/bin/bwrap-suid && mkdir -p /mnt/keep && chmod 777 /mnt/keep
# Unprivileged tenant users (uid 10001.., no shell, no home).
RUN for i in 1 2 3 4 5; do useradd -M -s /usr/sbin/nologin -u 1000$i t$i; done
WORKDIR /sb
COPY worker.js tenant.capnp.tmpl parent.capnp lib.sh probe.sh run-tests.sh measure.sh ./
RUN chmod +x /sb/*.sh
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
