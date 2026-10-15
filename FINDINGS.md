# Phase 1 spike findings

Spike code lives in `spike/`. It contains:
- a workerd config and a SQLite DO
- a container image with a stats supervisor
- `spike/cf`, a Worker deployed to `do-pool-spike.do-pool-lab.workers.dev`

## Verdict
**Feasible, and cheaper in a specific (but common) regime.** The win is "many DOs that are *awake* but not busy". It is not "high message throughput": Cloudflare containers charge CPU per frame, while real DOs send outgoing WebSocket frames for free.

## What works
| Thing | Result |
|---|---|
| workerd SQLite DOs (`enableSql`, `localDisk`) | ✅ Works. Each DO is a `<id>.sqlite` file. `sqlite_master` is readable, which makes a generic checkpoint dump possible. `_cf_*` tables are hidden. |
| Alarms in workerd | ✅ Fire as expected. |
| Hibernation WS API (`ctx.acceptWebSocket`) | ✅ API works. |
| workerd eviction | ✅ Idle DOs are evicted after about 10s, or 70s after the last client leaves. 10k DOs: RSS 2.1 GB → 48 MB after 85s idle. Waking 2000 evicted DOs took 1.4s. |
| Container → Worker bindings (`outboundByHost`) | ✅ Container→Worker→response in about 6ms. ⚠️ **Footgun:** `static outboundByHost = {...}` as a class field silently shadows the library's static setter, and every call returns 520 "Origin is disallowed". You must *assign* it: `PoolNode.outboundByHost = {...}`. |
| Container cold start | About 1.3s with the image cached. 8–11s for the first start after a new image. |
| Rollouts | `--containers-rollout=immediate` still takes **about 3–5 min** before the new image actually serves traffic. During the immediate rollout we saw the instance restart twice. |

## Numbers
**Memory (workerd, Linux):**
- Resident SQLite DO: **about 200 KB**. 9k pinned DOs = 1.87 GB.
- WebSocket: **about 77 KB** without permessage-deflate. **About 370 KB with deflate**. Browsers always offer deflate, so we strip `Sec-WebSocket-Extensions` and set `no_web_socket_compression`.
- Baseline: workerd RSS about 18–50 MB.

**CPU (on Cloudflare):**
- A Cloudflare vCPU is about **4x slower** than an M-series core on a tight JS loop: `cpubench` 4.7s vs 1.14s.
- workerd is **single-threaded** for request work. A 4-vCPU box only uses 1 core per process, so we shard processes.
- Instance vCPU fractions are enforced under *sustained* load:
  - `lite` bursts to a full core for about 1s, then is throttled hard (54 msgs/s).
  - `basic` gives about ¼ core.
  - `standard-1` gives about ½ core.
  - `standard-2` gives 1 core.
- Naive broadcast Room (one `send` per peer, JSON) gets **about 11k WS frames/s per Cloudflare vCPU** (2.45k in + 8.5k out on `standard-2`). Real DOs spread across 50 objects did 22k/s out with lower latency, because each DO gets its own thread.

## Platform limits / gotchas discovered
1. **Hard limit: 4096 concurrent inbound connections per container**: "There are more than 4096 concurrent connections inbound to the container, surpassing the limit". Every proxied WebSocket is one TCP connection, so it's ≤4096 sockets per container unless we multiplex. This pushes toward many *small* instances (`basic`), not one big one.
2. **`@cloudflare/containers` proxies WebSockets in JavaScript inside the fronting DO** (`accept()` both ends, plus `renewActivityTimeout()` per message).
   - It caps at about 1k msgs/s while the container sits idle.
   - It is billed: every container→client frame shows up as an *inbound* WS message on the PoolNode DO (987k in analytics).
   - **Fix:** raw passthrough. `return this.ctx.container.getTcpPort(8080).fetch(url, req)` hands the socket to the runtime and keeps JS off the per-message path.
3. With raw passthrough, long-lived sockets don't renew `sleepAfter`, so the node must renew its own activity based on connection count.
4. The container VM has no cgroup files. Read stats from `/proc/stat` and `/proc/meminfo`. The `standard-1` VM shows 4 GB and `nproc=1`.

## Cost sanity check (list prices)
- Always-awake real DO: 0.125 GB × 2.592M s × $12.50/M GB-s ≈ **$4.05/month** each.
- `basic` container (¼ vCPU, 1 GiB, 4 GB disk) idle: memory $6.48 + disk $0.73 ≈ **$7.2/month**. Add CPU at $0.00002/vCPU-s of *active* use (≤$13/month at 100% of ¼ vCPU). Add the fronting PoolNode DO, awake 24/7 (≈ $4.05).
- 1000 awake-but-quiet DOs: real ≈ **$4,050/month**. Pool: 1000 × 200 KB fits in one `basic`, about **$12–25/month**. That's 150–300x.
- Chatty broadcast rooms (50 rooms × 10 users × 5 msg/s):
  - Real DO ≈ $202 duration + $48 requests ≈ $250/month.
  - Pool needs about 2 `standard-2` to keep latency sane, ≈ $190/month.
  - **About break-even.** Hibernation and free outbound frames make real DOs hard to beat here.
