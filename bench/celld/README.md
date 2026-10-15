# celld benchmark arm

This directory runs [celld](https://github.com/denoland/celld) v0.6.2, Deno's
self-hosted Durable Objects runtime, as a single node in one Docker container,
so it can be compared with the workerd arm in `spike/`.

- `app/` holds a Workers project (`wrangler.jsonc` and `worker.js`). Its
  `Room` class is a byte-for-byte copy of the one in `spike/worker.js`. The
  router keeps `/r/:name/*`, `/bulk` and `/__cpubench`, and drops `/__stats`,
  `/__pushlog` and `/bridge`.
- `Dockerfile` downloads the celld release binary and esbuild for
  `TARGETARCH` (amd64 or arm64), copies `app/` in, and runs `celld dev`
  on port 8080.
- `smoke.mjs` checks that `/touch` counts upward and that WebSocket ping,
  `echo:` and broadcast all work.

## Build and run

```sh
# Cloudflare Containers (linux/amd64)
docker buildx build --platform linux/amd64 --load -t celld-bench:amd64 bench/celld

# Apple Silicon, local
docker buildx build --platform linux/arm64 --load -t celld-bench:arm64 bench/celld
docker run -d --name celld-bench --cpus=1 -m 1g -p 8090:8080 celld-bench:arm64

node bench/celld/smoke.mjs http://localhost:8090
node spike/ws-load.mjs ws://localhost:8090 100 10 10 10
docker rm -f celld-bench
```

The container runs this command:

```
celld dev /app --host 0.0.0.0 --port 8080 --no-watch --clean
```

The node becomes ready about 1 to 2 seconds after start, because esbuild
bundles the Worker at startup. Startup prints `ready  http://0.0.0.0:8080`.
To see the node's info and warn logs, add `--logs`.

## Bucket situation: no S3 or MinIO needed

A production celld node (`celld --bucket s3://… | gs://… | az://…`) needs an
object store. The fleet nodes accept only cloud buckets. There is no `file://`
option for them, and `dev://` is rejected on purpose.

`celld dev`, however, runs one real celld node as a child process, with the
same serving, ownership, LTX replication and output-gate code. That node is
backed by a built-in local object store, a SQLite database under
`/app/.celld/dev` (see `crates/celld/local_store.rs` and `dev.rs` upstream).
So this arm uses `celld dev` and needs no MinIO. Using it has these
consequences:

- **Process tree.** A small `celld dev` supervisor process (about 24 MB anon
  RSS) spawns the node as
  `celld --no-control-plane --bucket celld-dev --listen 0.0.0.0:8080 --internal-listen 127.0.0.1:0`
  with `CELLD_INTERNAL_DEV_STORE=…`. The supervisor's memory is overhead that
  a production node would not have. Subtract about 24 MB if you want the
  node alone.
- **Durability proof.** A single node has no followers, so every write
  waits for its "bucket" before the response leaves the output gate. Here
  the bucket is a local SQLite commit, so the wait is cheap. Against real
  R2 or S3, each acknowledged write costs one object-store round trip
  (upstream measured about 90 ms region-local).
- **Esbuild.** `celld dev` (and `celld deploy`) shells out to esbuild, so the
  image includes the esbuild binary (`CELLD_ESBUILD` can override the path).
  esbuild only runs at startup.

If a bucket-backed variant is ever needed, the options are R2 over its S3 API
(`--bucket s3://bucket/prefix --endpoint https://ACCOUNT.r2.cloudflarestorage.com --region auto`,
plus a separate `celld deploy` step), or MinIO in the same container. Neither
was needed or built here.

## celld architecture and Cloudflare Container constraints

- **Node and fleet model.** One `celld` process is a node. Nodes that share
  a bucket form a fleet. Cell ownership is decided by conditional writes
  to the bucket (lease and epoch fencing). Nodes talk to each other over
  signed peer HTTP on `--internal-listen`/`--advertise`, which they use to
  forward requests to a cell's owner and to replicate writes to 1 or 2
  followers (the "ensemble").
- **No inbound peer networking between Cloudflare Containers.** Container
  instances cannot reach each other's internal port, so two containers
  cannot form a fleet. Pointing them at the same bucket would be worse than
  useless: a node would try to forward to an unreachable owner. Each
  container must be its own one-node fleet with its own bucket or prefix.
  That rules out the ensemble's fast write path, and every write takes the
  single-node "wait for the bucket" path.
- **Ephemeral disk.** With `celld dev` the whole state (cell SQLite files
  plus the local object store) lives on the container disk and disappears
  when the container stops. That is acceptable for a throughput and memory
  benchmark, not for durability. Real durability needs R2 or S3, at one
  round trip per acknowledged write.
- **One application per fleet.** A node loads `deploy/current.json` from the
  bucket. `celld dev` performs the deploy into its local store at startup.
- **Wrangler config.** Only `wrangler.jsonc` and `wrangler.json` are
  accepted, not toml. Unknown top-level keys (for example `routes`) stop
  the deploy. A migration accepts `new_sqlite_classes` only.
- **DO API support.** `ctx.storage.sql.exec`, KV storage, alarms,
  `ctx.acceptWebSocket` with `webSocketMessage`/`webSocketClose`, and
  `getWebSockets()` all work as on Cloudflare, and all were exercised here.
  The `cloudflare:workers` `DurableObject` base class works.
- **Hibernation.** A hibernated cell keeps its WebSocket clients on the
  node. By default idle cells are never evicted; only memory pressure or the
  `CELLD_MAX_RESIDENT_CELLS` cap evicts them. Set `CELLD_IDLE_EVICT_S` to
  evict idle cells, as workerd does.
- **Memory guardrails.** Pressure shedding starts at 80% of the cgroup
  limit (`CELLD_MAX_RSS_MB`), with a hard cap at 95%. Each isolate's V8 heap
  is limited to 128 MB (`CELLD_V8_HEAP_LIMIT_MB`). Each Durable Object admits
  at most 64 concurrent fetches (`CELLD_MAX_CELL_REQUESTS`) and returns 503
  above that.
- **Clocks.** `Date.now()` and `performance.now()` freeze during JS
  execution, so `/__cpubench` reports `ms: 0`. Time it from the client
  (`curl -w %{time_total}`) instead.
- **Internal tables.** `sqlite_master` (shown by `/dump`) also lists celld's
  internal tables (`_cf_KV`, `_cf_ALARM`, `_cf_WAKE`, `_litestream_*`, …).

## Measured numbers

These are for celld v0.6.2 on an Apple M4 Pro, with Docker 28.5.1 running
linux/arm64 natively and the container limited by `--cpus=1 -m 1g`.

**Functional checks.** All passed: `smoke.mjs` printed OK, `/r/a/touch`
returned `{"n":1}`, `{"n":2}`, `{"n":3}`, `/dump`, `/alarm` and `/alarmed`
behaved as expected, and a WebSocket received `pong`, `echo:hello` and a
broadcast to a peer. The amd64 image also builds, and under QEMU emulation
it returns increasing `/touch` counts.

**Memory** (`docker stats --no-stream`):

| state | container mem | notes |
| --- | --- | --- |
| fresh, idle, after startup | **76.8 MiB** | supervisor 24 MB anon, node 50 MB anon |
| after 3 touches | 82.8 MiB | |
| during load test (1000 WS, 100 rooms) | 317 to 330 MiB | |
| after load, clients closed | 326 MiB | 100 cells stay resident (no idle eviction); node anon RSS 252 MB |
| 1000 idle WS reopened on the same 100 rooms | 340 MiB | |
| plus 500 more touched cells (`/bulk`) | 506 MiB | about 0.35 MB per resident touched cell |
| plus 1000 more touched cells | 680 MiB | |

**Latency.** A `/touch` on a warm cell takes about 5 ms end to end with
curl. The first touch of a fresh node takes about 36 ms. `/__cpubench`
(2e8 loop iterations) takes about 1.04 s from the client.

**Cold activations.** `/bulk` activated and touched 500 new cells in about
2.6 to 3.1 s, about 160 to 190 per second on one CPU.

**`node spike/ws-load.mjs ws://localhost:8090 100 10 10 10`** gave this
output:

```
{"opened":1000,"errors":0,"connectMs":1054}
{"idleRttP50":"3.02","idleRttP99":"4.44"}
{"sentPerSec":9900,"recvPerSec":67912,"loadedRttP50":"1566.0","loadedRttP99":"3070.7"}
```

CPU was pinned at about 100% of the 1 vCPU for the whole run. Perfect
broadcast fan-out would deliver 9900 × 9 ≈ 89,100 messages per second, but
only 67.9k per second arrived (about 76%). The loaded RTT of 1.5 s at p50
and 3 s at p99 shows that queues were building. At this load one vCPU is
saturated, so the knee is below 10k inbound messages per second
(about 68k outbound per second) per core.
