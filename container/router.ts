/**
 * Entry worker inside the container. Receives raw-passthrough requests from the PoolNode DO
 * (`x-do-class` / `x-do-name` headers) and routes them to the right Durable Object.
 * Also exposes the node's admin surface (stats, flush, drain, evict) to the supervisor
 * and the PoolNode.
 */
import { CLASSES, isClassSlug, poolKey, poolRegistry, type ClassSlug } from "../objects";
import { writeSegment } from "../objects/ckpt-store";
import type { PoolEnv } from "../objects/portable";

export { CursorRoom, YDoc, Ticker } from "../objects";

interface Env extends PoolEnv {
  CURSORS: DurableObjectNamespace;
  DOC: DurableObjectNamespace;
  TICKER: DurableObjectNamespace;
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
let draining = false;
let requests = 0;

type PoolStub = {
  poolSnapshot(): Promise<ArrayBuffer>;
  poolClose(reason?: string): Promise<void>;
  poolRetire(): Promise<void>;
};

function stubFor(env: Env, key: string): PoolStub {
  const [cls, ...rest] = key.split("/");
  const ns = env[CLASSES[cls as ClassSlug].binding] as DurableObjectNamespace;
  return ns.get(ns.idFromName(rest.join("/"))) as unknown as PoolStub;
}

/**
 * Collect snapshots from `keys` (via `take`) and write them as one segment.
 * Objects whose snapshot couldn't be written are marked dirty again.
 */
/**
 * Move objects off this node: they're already fenced (410 for new requests), so close their
 * sockets, then snapshot them into one segment. Only once this returns may Placement point
 * the keys at another node.
 */
async function moveOut(env: Env, keys: string[], reason: string) {
  await Promise.all(keys.map((k) => stubFor(env, k).poolClose(reason).catch(() => {})));
  return checkpoint(env, keys, (s) => s.poolSnapshot());
}

async function checkpoint(env: Env, keys: string[], take: (stub: PoolStub) => Promise<ArrayBuffer>) {
  const t0 = Date.now();
  const items: { key: string; bytes: ArrayBuffer }[] = [];
  const errors: string[] = [];
  const queue = [...keys];
  await Promise.all(
    Array.from({ length: Math.min(16, queue.length) }, async () => {
      for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
        try {
          items.push({ key, bytes: await take(stubFor(env, key)) });
        } catch (e) {
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
  return { objects: items.length, seg, failed: errors.length, errors: errors.slice(0, 5), ms: Date.now() - t0 };
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
    checkpoints: poolRegistry.checkpoints,
    checkpointBytes: poolRegistry.checkpointBytes,
    segments: poolRegistry.segments,
    hydrations: poolRegistry.hydrations,
    ...proc,
  };
}

async function admin(url: URL, req: Request, env: Env): Promise<Response> {
  switch (url.pathname) {
    case "/__stats":
      return Response.json(await stats(env));
    case "/__flush":
      return Response.json(await checkpoint(env, [...poolRegistry.dirty], (s) => s.poolSnapshot()));
    case "/__drain": {
      draining = true;
      const keys = [...new Set([...liveKeys(), ...poolRegistry.dirty])];
      return Response.json({ keys: keys.length, ...(await moveOut(env, keys, "node draining")) });
    }
    case "/__undrain":
      draining = false;
      moved.clear();
      return Response.json({ draining });
    case "/__evict": {
      const items = (await req.json()) as { key: string; epoch: number }[];
      const keys = items.map((i) => i.key);
      for (const { key, epoch } of items) moved.set(key, epoch);
      const r = await moveOut(env, keys, "moved");
      if (r.failed && !r.seg) for (const k of keys) moved.delete(k); // nothing persisted: keep serving here
      else await Promise.all(keys.map((k) => stubFor(env, k).poolRetire().catch(() => {}))); // abort() rejects the call
      return Response.json({ evicted: r.seg ? keys.length : 0, ...r });
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    startedAt ||= Date.now();
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__")) return admin(url, req, env);
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
    if (req.headers.get("x-do-fresh") === "1") poolRegistry.fresh.add(key);
    const ns = env[CLASSES[cls].binding] as DurableObjectNamespace;
    return ns.get(ns.idFromName(name)).fetch(req);
  },
};
