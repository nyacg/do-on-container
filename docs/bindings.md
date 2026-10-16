# Bindings: KV, R2, AI, other Workers and other Durable Objects from a pooled object

A pooled object uses bindings exactly like a real Durable Object:

```ts
export class BindingsDemo extends PortableDurableObject<BindingsEnv> {
  static slug = "bind";

  async fetch(req: Request) {
    await this.env.KV.put("k", "v");                                   // Workers KV
    const obj = await this.env.FILES.get("report.txt");                // R2
    const out = await this.env.AI.run("@cf/meta/llama-3.2-1b-instruct", { prompt: "hi" });
    const hello = await this.env.ECHO.greet("you");                    // another Worker (JS RPC)
    const res = await this.env.ECHO.fetch("https://echo/x");           // another Worker (HTTP)
    const peer = await this.env.BIND.getByName("other").ping("me", "hi"); // another Durable Object
    // ...
  }
}
```

Same class, same code, two backends. On Cloudflare (`/do/bind/<name>`) those are native bindings.
In the pool (`/pool/bind/<name>`) they're proxies that run each call in the control Worker.
`test/bindings.test.ts` runs identical assertions against both.

## Adding a binding

1. Declare it in `wrangler.jsonc` **under `env.control`**, the Worker that holds the real
   bindings for the pool. Use the same name under `env.preview` too, so the real-DO arm of each
   class sees the same `env`:

   ```jsonc
   "kv_namespaces": [{ "binding": "KV", "id": "…" }],
   "r2_buckets":    [{ "binding": "FILES", "bucket_name": "…" }],
   "ai":            { "binding": "AI" },
   "services":      [{ "binding": "ECHO", "service": "do-pool-v2-echo" }],
   "vars":          { "GREETING": "hello" }
   ```

2. `npm run build`. `scripts/gen-bindings.mjs` reads `env.control` and writes the list of names a
   pooled object sees (`objects/generated/bindings.ts`). Durable Object classes that run in the
   pool (`objects/index.ts` → `CLASSES`) are added automatically as pooled bindings.
3. Deploy control (`npm run deploy:control`) and the edge (`npm run deploy:preview`).

There's nothing to add inside the container: no workerd config, no tokens.

## How it works

```
 pooled object                container                    control Worker                 Cloudflare
 ─────────────                ─────────                    ──────────────                 ──────────
 env.FILES.put(k, v) ──▶ proxy records the call chain
                         [get put, call(k, v)]
                         POST http://bridge.internal/rpc ─▶ Bridge entrypoint (intercepted
                                                            outbound, ctx.exports.Bridge)
                                                            checks the manifest, replays
                                                            env.FILES.put(k, v) ───────────▶ R2
                         ◀── { ok: <R2Object, tagged> } ◀── encodes the result
 ◀── R2Object (+ .text(), .json(), …)
```

- **The client** (`objects/remote-bindings.ts`): `PortableDurableObject` wraps `this.env` when
  pooled. Each declared name becomes a proxy that records property reads and calls. Nothing is
  sent until the chain is awaited, so `env.BIND.getByName(x).ping(y)` is **one round trip**, as
  with Workers RPC pipelining. `idFromName` / `newUniqueId` / `idFromString` are local and
  synchronous, as on Cloudflare.
- **The wire** (`objects/rpc-wire.ts`) is JSON plus tags for what JSON can't carry: bytes,
  `ArrayBuffer`, `Date`, `undefined`, errors, `Request`/`Response` (with bodies), R2 objects (with
  their body methods) and Durable Object ids.
- **The server** (`src/rpc-server.ts`, `POST /rpc` on the bridge) only serves names in the
  generated manifest. Internal bindings (`POOL`, `PLACEMENT`, `CHECKPOINTS`) aren't reachable.
  Errors come back with their `name` and `message` and are re-thrown in the object.

### Durable Object → Durable Object

The interesting case is one pooled object calling another (`env.BIND.getByName("b").ping()`).
There's no Cloudflare binding to replay that on, because the target lives in *some* container. So
the bridge does what the edge Worker does for a browser request:

1. ask **Placement** which node owns `bind/b` (cached for 30 s), placing it if it's new
2. send the call to that node's PoolNode with the usual `x-do-class` / `x-do-name` /
   `x-do-epoch` headers
   - `stub.fetch(req)` is forwarded as a request
   - anything else carries `x-do-call: 1`, and the node's router replays the method chain on its
     local stub (`container/router.ts` → `call()`)
3. on `410 moved` (the target is mid-move or was moved), re-resolve and retry. Nothing ran on the
   object in that case: both fences reject before the object sees the call. The lifecycle test
   `bindings-follow-move` migrates B while A calls it in a loop. Every call lands exactly once,
   and B answers from its new node.

This works across nodes and also on the same node; it's the same path either way. Calls from a pooled object to a **real** Durable Object
namespace (a `durable_objects` binding in `env.control` that isn't a pooled class) are replayed on
the real namespace.

## Measured

Median per call, 21 sequential calls, from `GET /<backend>/bind/<name>/latency` (2026-10-16, both
objects in `wnam`, two runs each):

| | real DO | pooled DO |
|---|---|---|
| KV `get` (miss) | 5 ms | 19–30 ms |
| Service binding JS RPC | ~0 ms¹ | 16–23 ms |
| DO → DO RPC | 36–37 ms | 31–33 ms |

¹ The target Worker runs in the same thread, and Workers clocks only advance on I/O, so this
reads as 0.

The pool pays an extra hop for every call: container → its PoolNode's location → the control
Worker. DO→DO calls also pay a Placement lookup on a cache miss and the hop into the target's
container.

## Differences from native bindings (honest list)

- **Latency**: see above. Batch where you can. A chain like `getByName(x).method()` is one trip,
  but each `await` is a separate one.
- **Bodies are buffered**, not streamed: R2 `get` / `put`, `fetch` request and response bodies,
  and AI responses travel whole (base64 in JSON). That's fine for KBs to low MBs; for large
  objects use presigned R2 URLs or keep them out of the object's hot path.
- **No WebSockets over bindings** (`stub.fetch()` with `Upgrade: websocket`), and no streaming AI
  responses (`stream: true`).
- **Values, not stubs**: RPC arguments and results must be data (the types above, plain objects
  and arrays). Functions, callbacks and returned RPC stubs don't cross. Durable Object ids made
  with `idFromName` / `newUniqueId` do.
- **DO ids are names.** `newUniqueId()` makes a random name; `idFromString(s)` treats `s` as a
  name. No jurisdictions. `getByName(name)` and `get(idFromName(name))` reach the same object, as
  on Cloudflare.
- **Bindings need a redeploy of control** (`env.control` holds them), which restarts the nodes.
  That's zero-loss (they drain on SIGTERM; see the lifecycle tests), but not instant.
- **Sandboxed tenants and dynamic apps get no bindings.** `TenantBridge` refuses `/rpc`, and
  facet apps only get `env.__HOST`. Untrusted code shouldn't hold your KV namespace. A per-app
  allowlist on `TenantBridge` would be the way to grant a scoped binding.
- **Billing**: each call is a request handled by the control Worker (the `Bridge` entrypoint). We
  haven't measured how Cloudflare bills intercepted container egress.

## Developer experience, overall

What's the same as writing a normal Durable Object:

- `extends PortableDurableObject` instead of `DurableObject`, and put setup in `onStart()` (it runs after hydration)
- `ctx.storage` (SQL and KV), alarms, the WebSocket hibernation API, and now `env.*` bindings
- addressing: the edge Worker routes `/pool/<class>/<name>` the way `getByName(name)` would

What's different:

- **Where config lives**: a new class is registered in `objects/index.ts` (slug → binding), the
  container's `workerd.capnp`, and the edge's `durable_objects` + migration in wrangler.jsonc.
  Bindings go in `env.control`. A generator could fold all of this into one step.
- **Deploys**: edge-only changes are instant. Class code runs in the container image, so changing
  it means a control deploy, which rolls the nodes. Dynamic apps (facets) avoid that: publish new
  code and objects pick it up on their next request.
- **Local dev**: `npm run dev:node` builds the image. workerd runs the same classes locally, and
  bindings work locally only if something answers `bridge.internal` (not wired up yet).
