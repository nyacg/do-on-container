/**
 * Entry worker inside the container. Receives raw-passthrough requests from the PoolNode DO
 * (`x-do-class` / `x-do-name` headers) and routes them to the right Durable Object.
 * Also exposes the node's admin surface (stats, flush, drain, evict) to the supervisor
 * and the PoolNode.
 */
import { CLASSES, isClassSlug, poolKey, poolRegistry, type ClassSlug } from "../objects";
import { writeSegment } from "../objects/ckpt-store";
import { applyChain, encode, type Step } from "../objects/rpc-wire";
import { confirmedEvictions, type EvictionResult } from "../objects/pool-protocol";
import type { PoolEnv } from "../objects/portable";
import { appOfKey, byTenant, fanOut, fromTenantKey, tenantFetch, tenantFetcher, tenants, toTenantKey, type TenantEnv } from "./tenants";

export { TenantBridge } from "./tenants";

export { CursorRoom, YDoc, Ticker, Conformance, FacetHost, FacetCtl, BindingsDemo, AiRoom, Lobby } from "../objects";

interface Env extends PoolEnv, TenantEnv {
  CURSORS: DurableObjectNamespace;
  DOC: DurableObjectNamespace;
  TICKER: DurableObjectNamespace;
  CONF: DurableObjectNamespace;
  BIND: DurableObjectNamespace;
  ROOMS: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  APPS: DurableObjectNamespace;
  STATS: Fetcher;
  NODE_NAME: string;
}

declare const __BUILD__: string;
let startedAt = 0; // Date.now() is frozen at 0 in global scope; set on first request
/**
 * Fenced objects (handed off to another node) → the assignment epoch they were evicted under.
 * Requests carrying that epoch or older get 410; a newer epoch means Placement has assigned
 * the object back to this node, which lifts the fence.
 */
const moved = new Map<string, number>();
// Include RPC response encoding: a handoff must wait for the entire call to finish.
const inflight = new Map<string, number>();
let draining = false;
let requests = 0;

type PoolStub = {
  poolSnapshot(): Promise<{ bytes: ArrayBuffer; alarm: number | null }>;
  poolClose(reason?: string): Promise<void>;
  poolRetire(): Promise<void>;
  poolWake(): Promise<{ alarm: number | null }>;
  poolUnfreeze(): Promise<void>;
  poolSockets(): Promise<number>;
};

function stubFor(env: Env, key: string): PoolStub {
  const [cls, ...rest] = key.split("/");
  const ns = env[CLASSES[cls as ClassSlug].binding] as DurableObjectNamespace;
  return ns.get(ns.idFromName(rest.join("/"))) as unknown as PoolStub;
}

/**
 * Move objects off this node: they're already fenced (410 for new requests), so close their
 * sockets, then snapshot them into one segment. Only once this returns may Placement point
 * the keys at another node.
 */
async function moveOut(env: Env, keys: string[], reason: string) {
  return checkpoint(env, keys, async (s, key) => {
    for (let waited = 0; inflight.has(key) && waited < 10_000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (inflight.has(key)) throw new Error("object still has in-flight requests");
    await s.poolClose(reason);
    return s.poolSnapshot();
  });
}

async function checkpoint(
  env: Env,
  keys: string[],
  take: (stub: PoolStub, key: string) => Promise<{ bytes: ArrayBuffer; alarm: number | null }>,
) {
  const t0 = Date.now();
  const items: { key: string; bytes: ArrayBuffer; alarm: number | null }[] = [];
  const errors: string[] = [];
  const queue = [...keys];
  await Promise.all(
    Array.from({ length: Math.min(16, queue.length) }, async () => {
      for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
        try {
          items.push({ key, ...(await take(stubFor(env, key), key)) });
        } catch (e) {
          poolRegistry.dirty.add(key);
          errors.push(`${key}: ${String(e).slice(0, 160)}`);
        }
      }
    }),
  );
  let seg: string | null = null;
  if (items.length) {
    try {
      const r = await writeSegment(env, env.NODE_NAME, items);
      seg = r.seg;
      poolRegistry.segments++;
      poolRegistry.checkpoints += items.length;
      poolRegistry.checkpointBytes += r.bytes;
    } catch (e) {
      for (const { key } of items) poolRegistry.dirty.add(key);
      errors.push(`segment: ${String(e).slice(0, 200)}`);
    }
  }
  // Pending alarms of the checkpointed objects: Placement's registry takes these over when the
  // objects leave this node (drain, evict, sleep), so they still fire on time.
  const persistedKeys = seg ? items.map((i) => i.key) : [];
  const alarms = seg ? items.filter((i) => i.alarm).map((i) => ({ key: i.key, at: i.alarm as number })) : [];
  return { objects: items.length, seg, persistedKeys, alarms, failed: errors.length, errors: errors.slice(0, 5), ms: Date.now() - t0 };
}

function liveKeys() {
  const keys: string[] = [];
  for (const [k, ref] of poolRegistry.live) {
    if (ref.deref()) keys.push(k);
    else poolRegistry.live.delete(k);
  }
  return keys;
}

async function stats(env: Env) {
  let proc: Record<string, unknown> = {};
  try {
    proc = await (await env.STATS.fetch("http://stats/proc.json")).json();
  } catch {}
  return {
    node: env.NODE_NAME,
    build: __BUILD__,
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    draining,
    requests,
    liveObjects: liveKeys().length,
    dirtyObjects: poolRegistry.dirty.size,
    alarmedObjects: poolRegistry.alarmed.size,
    checkpoints: poolRegistry.checkpoints,
    checkpointBytes: poolRegistry.checkpointBytes,
    segments: poolRegistry.segments,
    hydrations: poolRegistry.hydrations,
    tenants: tenants(),
    ...proc,
  };
}

type Alarm = { key: string; at: number };
const mapAlarms = (alarms: Alarm[] | undefined) => (alarms ?? []).map((a) => ({ ...a, key: fromTenantKey(a.key) }));

async function admin(url: URL, req: Request, env: Env): Promise<Response> {
  switch (url.pathname) {
    case "/__stats":
      return Response.json(await stats(env));
    case "/__flush": {
      const local = await checkpoint(env, [...poolRegistry.dirty], (s) => s.poolSnapshot());
      const t = await fanOut(env, "/__flush", { method: "POST" });
      return Response.json({ ...local, failed: local.failed + t.filter((x) => !x.ok || x.body.failed).length, tenants: t.length });
    }
    case "/__drain": {
      draining = true;
      const keys = [...new Set([...liveKeys(), ...poolRegistry.dirty, ...poolRegistry.alarmed])];
      const local = await moveOut(env, keys, "node draining");
      const t = await fanOut(env, "/__drain", { method: "POST" });
      const alarms = [...local.alarms, ...t.flatMap((x) => mapAlarms(x.body.alarms))];
      const failed = local.failed + t.filter((x) => !x.ok || x.body.failed).length;
      return Response.json({ keys: keys.length, ...local, failed, alarms, tenants: t.length });
    }
    case "/__undrain":
      draining = false;
      moved.clear();
      return Response.json({ draining });
    case "/__evict": {
      const items = (await req.json()) as { key: string; epoch: number }[];
      for (const { key, epoch } of items) moved.set(key, epoch);
      const keys = items.filter((i) => !i.key.startsWith("sapp/")).map((i) => i.key);
      const evictedKeys: string[] = [];
      let seg: string | null = null;
      const alarms: Alarm[] = [];
      const errors: string[] = [];
      if (keys.length) {
        const r = await moveOut(env, keys, "moved");
        const persisted = new Set(r.persistedKeys);
        const failed = keys.filter((k) => !persisted.has(k));
        for (const k of failed) moved.delete(k);
        await Promise.all(failed.map((k) => stubFor(env, k).poolUnfreeze().catch(() => {})));
        await Promise.all(r.persistedKeys.map((k) => stubFor(env, k).poolRetire().catch(() => {}))); // abort() rejects the call
        evictedKeys.push(...r.persistedKeys);
        seg = r.seg;
        alarms.push(...r.alarms);
        errors.push(...r.errors);
      }
      for (const [app, group] of byTenant(items)) {
        try {
          const res = await (await tenantFetcher(env, app)).fetch("http://tenant/__evict", {
            method: "POST",
            body: JSON.stringify(group.map((g) => ({ ...g, key: toTenantKey(g.key) }))),
          });
          if (!res.ok) throw new Error(`tenant eviction: HTTP ${res.status}`);
          const r = (await res.json()) as EvictionResult;
          const confirmed = confirmedEvictions(r, group.map((g) => toTenantKey(g.key))).map(fromTenantKey);
          for (const g of group) if (!confirmed.includes(g.key)) moved.delete(g.key);
          evictedKeys.push(...confirmed);
          alarms.push(...mapAlarms(r.alarms).filter((a) => confirmed.includes(a.key)));
          errors.push(...(r.errors ?? []));
        } catch (e) {
          // The tenant may have persisted before its reply was lost. Keep its fence until a
          // retry establishes the outcome; still return other tenants' confirmed handoffs.
          errors.push(`${app}: ${String(e).slice(0, 160)}`);
        }
      }
      return Response.json({ evicted: evictedKeys.length, evictedKeys, seg, alarms, errors });
    }
    case "/__wake": {
      // Alarm registry: construct (hydrate + re-arm) these objects so their alarms fire here.
      const items = (await req.json()) as { key: string; epoch: number }[];
      const woke: string[] = [];
      const errors: string[] = [];
      await Promise.all(
        items
          .filter((i) => !i.key.startsWith("sapp/"))
          .map(async ({ key, epoch }) => {
            try {
              poolRegistry.epochs.set(key, epoch);
              await stubFor(env, key).poolWake();
              woke.push(key);
            } catch (e) {
              errors.push(`${key}: ${String(e).slice(0, 120)}`);
            }
          }),
      );
      for (const [app, group] of byTenant(items)) {
        try {
          const res = await (await tenantFetcher(env, app)).fetch("http://tenant/__wake", {
            method: "POST",
            body: JSON.stringify(group.map((g) => ({ ...g, key: toTenantKey(g.key) }))),
          });
          const r = (await res.json()) as { woke: string[]; errors: string[] };
          woke.push(...r.woke.map(fromTenantKey));
          errors.push(...r.errors);
        } catch (e) {
          errors.push(`${app}: ${String(e).slice(0, 120)}`);
        }
      }
      return Response.json({ woke, errors });
    }
    case "/__alarms": {
      // Pending alarms of every object with one (for Placement's registry when the node sleeps).
      const out: Alarm[] = [];
      await Promise.all(
        [...poolRegistry.alarmed].map(async (key) => {
          const { alarm } = await stubFor(env, key).poolWake().catch(() => ({ alarm: null }));
          if (alarm) out.push({ key, at: alarm });
          else poolRegistry.alarmed.delete(key);
        }),
      );
      for (const t of await fanOut(env, "/__alarms")) if (Array.isArray(t.body)) out.push(...mapAlarms(t.body));
      return Response.json(out);
    }
    case "/__sockets": {
      // WebSockets actually held by objects (TCP conns include the runtime's keep-alives).
      const counts = await Promise.all(liveKeys().map((k) => stubFor(env, k).poolSockets().catch(() => 0)));
      const t = await fanOut(env, "/__sockets");
      return Response.json({ sockets: counts.reduce((a, b) => a + b, 0) + t.reduce((a, x) => a + (x.body.sockets ?? 0), 0) });
    }
    case "/__probe": {
      // Isolation self-test: run a shell probe inside an app's sandbox (see spawner.sh).
      const app = url.searchParams.get("app") ?? "";
      await tenantFetcher(env, app); // ensure it has a slot
      const slot = tenants().find((t) => t.app === app)!.slot;
      await env.SPAWNQ.fetch(`http://q/${slot}`, { method: "PUT", body: `probe:${app}` }); // (no nonce)
      for (let t = 0; t < 15_000; t += 100) {
        const r = await env.SLOTS.fetch(`http://s/${slot}/probe.txt`);
        if (r.ok) {
          const text = await r.text();
          return new Response(text);
        }
        await new Promise((res) => setTimeout(res, 100));
      }
      return new Response("probe timed out", { status: 504 });
    }
    case "/__cpubench": {
      const t0 = Date.now();
      let x = 0;
      for (let i = 0; i < 2e8; i++) x = (x + i * 2654435761) % 4294967296;
      return Response.json({ ms: Date.now() - t0, x });
    }
  }
  return new Response("unknown admin path", { status: 404 });
}

/**
 * Another pooled object's RPC to this one (`env.CONF.getByName(x).ping()` elsewhere in the
 * pool, sent here by the bridge after Placement resolved the owner): replay the method chain
 * on the local stub, like Workers RPC.
 */
async function call(stub: DurableObjectStub, req: Request): Promise<Response> {
  const { chain } = (await req.json()) as { chain: Step[] };
  try {
    return Response.json({ ok: await encode(await applyChain(stub, chain, (doid) => ({ $doid: doid }))) });
  } catch (e) {
    return Response.json({ error: { name: (e as Error)?.name ?? "Error", message: (e as Error)?.message ?? String(e) } });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    startedAt ||= Date.now();
    const url = new URL(req.url);
    // Admin paths only for the node's own callers (PoolNode, supervisor): object traffic always
    // carries x-do-class, and an object's path (e.g. stub.fetch("http://x/__drain") from another
    // pooled object, via the bridge) must reach the object, not the node.
    if (url.pathname.startsWith("/__") && !req.headers.has("x-do-class")) return admin(url, req, env);
    const cls = req.headers.get("x-do-class") ?? "";
    const name = req.headers.get("x-do-name") ?? "";
    if (!isClassSlug(cls) || !name) return new Response(`do-pool node ${env.NODE_NAME} ok`);
    const key = poolKey(cls, name);
    const epoch = Number(req.headers.get("x-do-epoch") ?? 0);
    const fence = moved.get(key);
    if (fence !== undefined && epoch > fence) moved.delete(key);
    if (draining || (fence !== undefined && epoch <= fence)) {
      return new Response("object moved", { status: 410, headers: { "x-pool-moved": env.NODE_NAME } });
    }
    requests++;
    inflight.set(key, (inflight.get(key) ?? 0) + 1);
    try {
      if (cls === "sapp") {
        // Sandboxed app: hand the request to the app's own process, where it's a plain FacetHost.
        const headers = new Headers(req.headers);
        headers.set("x-do-class", "app");
        return await tenantFetch(env, appOfKey(key), new Request(req, { headers }));
      }
      if (req.headers.get("x-do-fresh") === "1") poolRegistry.fresh.add(key);
      poolRegistry.epochs.set(key, epoch);
      const ns = env[CLASSES[cls].binding] as DurableObjectNamespace;
      const stub = ns.get(ns.idFromName(name));
      if (req.headers.get("x-do-call") === "1") return await call(stub, req);
      return await stub.fetch(req);
    } finally {
      const remaining = inflight.get(key)! - 1;
      if (remaining) inflight.set(key, remaining);
      else inflight.delete(key);
    }
  },
};
