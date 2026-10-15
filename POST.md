# I bin-packed 1,000 Durable Objects into a $22/month container

*Draft. Every number below comes from runs on a real Cloudflare account in October 2026. Raw
data is in `bench/results`.*

Durable Objects are my favourite thing on Cloudflare: one single-threaded actor per thing, with
its own SQLite database, addressable by name from anywhere. The pricing has one sharp edge,
though. **An awake Durable Object is billed as if it were using 128 MB of RAM for every second
it's awake**, whatever it's actually doing. That's $12.50 per million GB-seconds, which works out
to **$4.05 a month per always-awake object**.

Hibernation makes that fine for most apps. A chat room with idle WebSockets costs nothing. But a
lot of objects can't hibernate:

- anything with a timer: game ticks, presence sweeps, polling an upstream
- anything holding an outbound connection: a market-data feed, an LLM stream
- **AI agents**, which are DOs that spend most of their life awake, waiting on a model

A thousand of those is $4,050 a month for objects that are mostly idle.

Cloudflare also sells [Containers](https://developers.cloudflare.com/containers/), billed on
*provisioned memory* plus *CPU you actually use*. And Cloudflare's runtime,
[workerd](https://github.com/cloudflare/workerd), is open source and runs SQLite-backed Durable
Objects locally. So: **what if you ran the DOs inside the container?**

## The result

![cost crossover](docs/cost-crossover.png)

| awake objects (1 Hz loop, 1 client each) | real Durable Objects | do-pool | |
|---|---|---|---|
| 100 | $405/mo | $13/mo | 31× |
| 1,000 | $4,050/mo | $22/mo | **180×** |
| 10,000 | $40,500/mo | $188/mo | 215× |

The pool is cheaper as soon as objects are awake more than about **0.3% of the time (roughly 2
hours a month)**. For objects that truly hibernate, real DOs win and you should keep using them.

How these were measured:
- One `basic` container (¼ vCPU, 1 GiB) held **1,000 awake objects, each ticking once a second
  with a WebSocket client**.
- Cloudflare's billing analytics showed **~0.2 vCPU** of billed CPU for that.
- The same 1,000 objects as real DOs billed 24,831 GB-s in 3.3 minutes, exactly the $4.05 per
  object per month the pricing page predicts.

## What I built

[`do-pool`](README.md) runs the same Durable Object classes either way, behind one Worker:

```
/do/cursors/lobby    → a real Durable Object
/pool/cursors/lobby  → the same class, in workerd, in a container
```

There are four parts:

1. **A placement DO** (the "load balancer"). It assigns each object to a container, scales
   containers up when they get hot and down when they go cold, and live-migrates batches of
   objects off hot nodes.
2. **One `PoolNode` DO per container.** Containers on Cloudflare are always fronted by a DO.
3. **workerd inside the container.** It runs every pooled object with its own SQLite file. A
   tiny shell supervisor pushes stats, flushes checkpoints and drains on SIGTERM.
4. **A bindings bridge.** Code in the container makes HTTP calls to `http://bridge.internal`.
   The container's outbound handler intercepts them and runs them in the Worker with real
   bindings (R2, the placement DO, anything else).

There are two demos, each with a "switch backend" button: live cursors (click to drop persisted
stamps) and a Yjs + CodeMirror collaborative editor. Both work on both backends from the same
class.

## Things that surprised me

**1. The official container library proxies WebSockets in JavaScript and bills you for it.**
`Container.fetch()` from `@cloudflare/containers` accepts both ends of the socket inside the
fronting DO and re-sends every frame in JS. With it, a container topped out around 1,000 msg/s
while its CPU sat idle. Analytics showed 987k *inbound* WebSocket messages on the DO: every frame
the container sent to a client was billed (at 1/20 of a request) as if a client had sent it.

The fix is one line:
`return this.ctx.container.getTcpPort(8080).fetch(url, request)`. That hands the socket to the
runtime. Throughput went up by the container's whole CPU budget, the fronting DO billed **0**
WebSocket messages, and it billed only 92 GB-s of wall-clock across 5 nodes in 18 minutes. Raw
passthrough doesn't keep the DO "awake".

**2. A container accepts at most 4,096 inbound connections.** The error is literally
"There are more than 4096 concurrent connections inbound to the container". Every WebSocket is
one connection, so the pool uses lots of small `basic` instances (¼ vCPU), not a few big ones.

**3. The pricing model inverts for chatty rooms.** Outgoing WebSocket frames are *free* on
Durable Objects. In a container, every frame is CPU you pay for, and a Cloudflare vCPU pushes
about 11k frames per second through workerd. (It's about 4× slower than my M4 on tight JS, and
hosts vary by 1.7×.) For 50 rooms × 10 users × 5 msg/s, the two come out roughly even ($251 vs
$124 with batching). The pool's win is **awake-but-quiet**, not high fan-out.

**4. Durability is the actual hard part.** Container disks are ephemeral, and Container
snapshots are tied to an image version, so they don't survive deploys. I checkpoint to R2. The
naive approach, one R2 object per DO per flush, costs $4.50 per million writes: for 1,000 busy
objects flushed every 5 minutes, that's **$39/month, more than the container**. So each flush
writes *one segment* with every dirty object, plus a per-node manifest. That's 2 PUTs per 30s
no matter how many objects changed: $0.78 per node per month.

Measured:
- **Rollout / scale-down / idle sleep (SIGTERM):** the supervisor drains before exiting.
  **10/10 writes survived**, including 5 made after the last periodic flush. The room was back
  in 4.8s.
- **Host failure (SIGKILL):** **5/10 survived.** Anything since the last 30s flush is gone.
  That's the honest trade: real DOs acknowledge a write only once it's replicated; this doesn't.
- **Live migration under continuous writes:** 8 round-trip moves, **0 acknowledged writes
  lost**, 0.6–1.2s client reconnect gaps.

Getting that last zero took three bugs:
- **Re-pointing before the snapshot was durable.** Placement moved the assignment before the old
  node's snapshot was written. Fix: fence, then close sockets, then snapshot, then persist, and
  only then re-point.
- **Stale fences.** A node refused an object that had been moved back to it. Fix: per-assignment
  epochs.
- **Stale local copies.** When an object returned to a node it had lived on before, the node
  trusted its old local SQLite file. Fix: retire it with `deleteAll()` and `ctx.abort()`, and
  only hydrate from a manifest load that started *after* the hydration began.

**5. Containers boot wherever there's room.** From California, our pool nodes landed in LAX,
SJC, IAD, **Paris** and **Osaka**. Real DOs are created near their first caller. Pool RTT in the
browser was ~80ms vs ~20ms for the real DO. If latency matters, this is the real cost.

**6. A saturated container can't save itself.** At 100% CPU (under `nice`, even), uploads to
R2 time out, so the node can neither checkpoint nor shed objects to a new node. The autoscaler
has to act at ~60% load, not 90%.

**7. Small things:**
- `static outboundByHost = {}` silently doesn't register: the class field shadows the library's
  setter.
- `Date.now()` is 0 at module scope in workerd.
- Busy DOs run the *old* code for about 5 minutes after a deploy.
- Worker-only deploys don't restart containers; image rollouts take 1.5–5 minutes.

## Isn't this just celld?

Ryan Dahl's [celld](https://github.com/denoland/celld) (August 2026) is self-hosted Durable
Objects on your own VMs, with SQLite replicated to S3 and zero RPO. It's great, and it got the
"$415 vs $49" headline (Cloudflare's reply was that hibernating objects cost $20).

do-pool goes the other way: **stay on Cloudflare**, keeping anycast ingress, TLS, Workers and
bindings, and swap only the per-object billing for a container you fill up. I benchmarked celld
in the same containers with the identical class. Once normalised for host speed it's within a
few percent of workerd on CPU. It used ~350 KB per resident object against workerd's ~200 KB.
Its multi-node replication can't run between Cloudflare containers anyway, because there's no
container-to-container networking.

## Should you use this?

- **Yes, probably:** lots of objects that must stay awake (agents, loops, feeds), where you can
  live with tens of milliseconds of extra latency and a 30-second RPO on hardware failure. You
  also need to be fine operating a placement layer.
- **No:** objects that hibernate, latency-critical objects that need to be near users, or any
  write you can't afford to lose.
- **Honestly:** the most useful thing here might be the number. Measure how many hours a month
  your DOs are awake, multiply by $0.0056, and see if you care.

Code: `do-pool` (link TBD). Built in a day with Claude, wrangler, and too many `wrangler tail`s.
