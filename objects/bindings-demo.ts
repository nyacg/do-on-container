import { PortableDurableObject, type PoolEnv } from "./portable";

/**
 * Uses every kind of binding, written exactly as for a real Durable Object. On Cloudflare the
 * bindings are native; in the pool they're the remote proxies from remote-bindings.ts. The
 * parity test runs the same requests against both and compares.
 *
 *   GET /var             a wrangler var
 *   GET /kv?v=           Workers KV: put, get, get json, getWithMetadata, list, delete
 *   GET /r2?v=           R2: put, head, get (text + metadata), list, delete
 *   GET /ai?q=           Workers AI: one small text-generation call
 *   GET /svc             another Worker: fetch() and JS RPC (greet, sum, shape)
 *   GET /do?to=&msg=     another Durable Object of this class: RPC (ping) and fetch
 *   GET /count           this object's ping counter (what /do on another object increments)
 *   GET /latency?n=      median ms per call: KV get, service RPC, DO RPC (sequential calls)
 */
export interface BindingsEnv extends PoolEnv {
  GREETING: string;
  KV: KVNamespace;
  FILES: R2Bucket;
  AI: Ai;
  ECHO: Fetcher & {
    greet(name: string): Promise<string>;
    sum(...xs: number[]): Promise<number>;
    shape(): Promise<{ when: Date; bytes: Uint8Array; nested: { ok: boolean } }>;
  };
  BIND: DurableObjectNamespace<BindingsDemo>;
}

export class BindingsDemo extends PortableDurableObject<BindingsEnv> {
  static slug = "bind";

  protected onStart() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pings (id INTEGER PRIMARY KEY, sender TEXT, msg TEXT, at INTEGER)");
  }

  /** Called by other objects through `env.BIND.getByName(name).ping(...)`. */
  async ping(from: string, msg: string) {
    this.ctx.storage.sql.exec("INSERT INTO pings (sender, msg, at) VALUES (?, ?, ?)", from, msg, Date.now());
    return { me: this.doName, pooled: this.pooled, from, msg, count: this.count(), at: new Date() };
  }

  private count() {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pings").one().n;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const op = url.pathname.split("/").filter(Boolean).at(-1);
    const q = url.searchParams;
    const env = this.env;
    const me = this.doName;
    try {
      switch (op) {
        case "var":
          return Response.json({ greeting: env.GREETING, pooled: this.pooled });
        case "count":
          return Response.json({ me, count: this.count() });
        case "ping":
          return Response.json({ me, via: "fetch", method: req.method, body: await req.text() });
        case "kv": {
          const k = `demo/${me}`;
          const v = q.get("v") ?? "hello";
          await env.KV.put(k, JSON.stringify({ v }), { metadata: { by: me } });
          const text = await env.KV.get(k);
          const json = await env.KV.get<{ v: string }>(k, "json");
          const withMeta = await env.KV.getWithMetadata<{ by: string }>(k);
          const list = await env.KV.list({ prefix: k });
          await env.KV.delete(k);
          const gone = await env.KV.get(k);
          return Response.json({ text, json, metadata: withMeta.metadata, listed: list.keys.map((x) => x.name), gone });
        }
        case "r2": {
          const k = `demo/${me}.txt`;
          const v = q.get("v") ?? "hello";
          const put = await env.FILES.put(k, v, { httpMetadata: { contentType: "text/plain" }, customMetadata: { by: me } });
          const head = await env.FILES.head(k);
          const obj = await env.FILES.get(k);
          const text = await obj!.text();
          const list = await env.FILES.list({ prefix: k });
          await env.FILES.delete(k);
          const gone = await env.FILES.get(k);
          return Response.json({
            size: put!.size,
            etagMatches: put!.etag === head!.etag,
            uploadedIsDate: head!.uploaded instanceof Date,
            contentType: obj!.httpMetadata?.contentType,
            customMetadata: obj!.customMetadata,
            text,
            listed: list.objects.map((o) => o.key),
            gone,
          });
        }
        case "ai": {
          const t0 = Date.now();
          const out = (await env.AI.run("@cf/meta/llama-3.2-1b-instruct", {
            messages: [{ role: "user", content: q.get("q") ?? "Say hi in three words." }],
            max_tokens: 24,
          })) as { response?: string };
          return Response.json({ response: out.response, ms: Date.now() - t0 });
        }
        case "svc": {
          const res = await env.ECHO.fetch("https://echo/hello", { method: "POST", body: `from ${me}` });
          const shape = await env.ECHO.shape();
          return Response.json({
            fetched: await res.json(),
            status: res.status,
            greet: await env.ECHO.greet(me),
            sum: await env.ECHO.sum(1, 2, 3),
            shape: { when: shape.when.toISOString(), bytes: [...shape.bytes], nested: shape.nested },
          });
        }
        case "latency": {
          const n = Math.min(Number(q.get("n") ?? 15), 50);
          const median = async (f: () => Promise<unknown>) => {
            const ms: number[] = [];
            for (let i = 0; i < n; i++) {
              const t0 = performance.now();
              await f();
              ms.push(performance.now() - t0);
            }
            // Timers only advance across I/O in Workers, which every call here does.
            return Math.round(ms.sort((x, y) => x - y)[n >> 1] * 10) / 10;
          };
          const peer = env.BIND.getByName(`${me}-peer`);
          return Response.json({
            n,
            kvGet: await median(() => env.KV.get("demo/none")),
            serviceRpc: await median(() => env.ECHO.greet(me)),
            doRpc: await median(() => peer.ping(me, "lat")),
          });
        }
        case "do": {
          const to = q.get("to") ?? `${me}-peer`;
          const stub = env.BIND.getByName(to);
          const rpc = await stub.ping(me, q.get("msg") ?? "hi");
          const viaId = await env.BIND.get(env.BIND.idFromName(to)).ping(me, "again");
          const res = await stub.fetch("https://peer/ping", { method: "POST", body: `fetch from ${me}` });
          return Response.json({
            rpc: { ...rpc, at: rpc.at instanceof Date },
            viaId: viaId.count,
            fetched: await res.json(),
          });
        }
      }
      return new Response("unknown op", { status: 404 });
    } catch (e) {
      return Response.json({ error: `${(e as Error).name}: ${(e as Error).message}` }, { status: 500 });
    }
  }
}
