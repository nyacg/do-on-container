import { CLASSES, isClassSlug, type ClassSlug } from "../objects";
import type { Env } from "./env";

export { CursorRoom, YDoc, Ticker } from "../objects";
export { ContainerProxy } from "@cloudflare/containers";
export { PoolNode } from "./pool-node";
export { Placement } from "./placement";

/**
 * Edge router.
 *
 *   /do/<class>/<name>/...    → a real Durable Object (control arm)
 *   /pool/<class>/<name>/...  → the same class running inside a pooled container
 *   /api/...                  → pool status + admin
 *   everything else           → static assets (web/public)
 */

// Placement lookups are cached per isolate; nodes answer 410 for objects they no longer own.
const placementCache = new Map<string, { node: string; epoch: number; exp: number }>();
const CACHE_MS = 30_000;

type Placed = { node: string; fresh: boolean; epoch: number };

async function resolveNode(env: Env, key: string, refresh = false): Promise<Placed> {
  const hit = placementCache.get(key);
  if (!refresh && hit && hit.exp > Date.now()) return { node: hit.node, epoch: hit.epoch, fresh: false };
  const r = await env.PLACEMENT.getByName("global").resolve(key);
  placementCache.set(key, { node: r.node, epoch: r.epoch, exp: Date.now() + CACHE_MS });
  return r;
}

function forPool(req: Request, cls: ClassSlug, name: string, { fresh, epoch }: Placed): Request {
  const headers = new Headers(req.headers);
  headers.set("x-do-class", cls);
  headers.set("x-do-name", name);
  headers.set("x-do-epoch", String(epoch));
  // Brand-new object: the node can skip looking for a checkpoint to hydrate from.
  if (fresh) headers.set("x-do-fresh", "1");
  else headers.delete("x-do-fresh");
  // Don't negotiate permessage-deflate with workerd: ~300KB of zlib state per socket.
  headers.delete("sec-websocket-extensions");
  return new Request(req, { headers });
}

async function toPool(req: Request, env: Env, cls: ClassSlug, name: string): Promise<Response> {
  const key = `${cls}/${name}`;
  let placed = await resolveNode(env, key);
  const t0 = Date.now();
  let res = await env.POOL.getByName(placed.node).fetch(forPool(req, cls, name, placed));
  if (res.status === 410 && res.headers.has("x-pool-moved") && (req.method === "GET" || req.method === "HEAD")) {
    placed = await resolveNode(env, key, true);
    res = await env.POOL.getByName(placed.node).fetch(forPool(req, cls, name, placed));
  }
  const node = placed.node;
  if (res.webSocket) return res;
  const out = new Response(res.body, res);
  out.headers.set("x-pool-node", node);
  out.headers.set("x-pool-ms", String(Date.now() - t0));
  return out;
}

function toRealDO(req: Request, env: Env, cls: ClassSlug, name: string): Promise<Response> {
  const ns = env[CLASSES[cls].binding] as DurableObjectNamespace;
  return ns.getByName(name).fetch(req);
}

function isAdmin(req: Request, env: Env & { ADMIN_TOKEN?: string }) {
  if (!env.ADMIN_TOKEN) return false;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? new URL(req.url).searchParams.get("token");
  return given === env.ADMIN_TOKEN;
}

async function api(req: Request, env: Env & { ADMIN_TOKEN?: string }, path: string[]): Promise<Response> {
  const placement = env.PLACEMENT.getByName("global");
  const url = new URL(req.url);
  if (path[0] === "status") return Response.json(await placement.status());
  if (path[0] === "node" && /^node-\d+$/.test(path[1] ?? "") && req.method === "GET") {
    return Response.json(await env.POOL.getByName(path[1]).nodeStats());
  }
  if (!isAdmin(req, env)) return new Response("admin token required", { status: 401 });
  switch (path[0]) {
    case "add-node":
      return Response.json({ node: await placement.addNode() });
    case "drain":
      await placement.drainNode(url.searchParams.get("node") ?? "");
      return Response.json({ ok: true });
    case "stop-node":
      // SIGTERM, exactly what a rollout does: the supervisor drains before exiting.
      await env.POOL.getByName(url.searchParams.get("node") ?? "").shutdown();
      return Response.json({ ok: true });
    case "kill-node":
      await env.POOL.getByName(url.searchParams.get("node") ?? "").kill();
      return Response.json({ ok: true });
    case "migrate":
      return Response.json({ node: await placement.migrate(url.searchParams.get("key") ?? "") });
    case "config": {
      const c: Record<string, number> = {};
      for (const k of ["minNodes", "maxNodes", "maxConns"]) if (url.searchParams.has(k)) c[k] = Number(url.searchParams.get(k));
      return Response.json(await placement.setConfig(c));
    }
    case "reset":
      await placement.reset();
      placementCache.clear();
      return Response.json({ ok: true });
  }
  return new Response("not found", { status: 404 });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const [backend, ...rest] = url.pathname.slice(1).split("/");
    if (backend === "api") return api(req, env, rest);
    if (backend === "do" || backend === "pool") {
      const [cls, name] = rest;
      if (!cls || !isClassSlug(cls) || !name) return new Response("usage: /{do|pool}/{cursors|doc|ticker}/{name}", { status: 400 });
      return backend === "do" ? toRealDO(req, env, cls, name) : toPool(req, env, cls, name);
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
