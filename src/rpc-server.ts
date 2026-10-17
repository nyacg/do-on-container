/**
 * Server half of transparent bindings (client: objects/remote-bindings.ts). A pooled object's
 * `env.KV.get("k")` arrives here as `{ binding: "KV", chain: [get get, call(["k"])] }` and is
 * replayed on the control Worker's real `env.KV`. The result goes back in the rpc-wire format.
 *
 * `pool:<slug>` bindings (one pooled object calling another, e.g. `env.CONF.getByName(x).ping()`)
 * don't have a Cloudflare binding to replay on: they're resolved through Placement and sent to
 * the owning node like an edge request, with `x-do-call` asking its router to replay the rest
 * of the chain on the local stub.
 */
import { BINDINGS } from "../objects/generated/bindings";
import { applyChain, decode, encode, type Step } from "../objects/rpc-wire";
import type { Env } from "./env";

const idResolver = (ns: DurableObjectNamespace) => (doid: { name: string }) => ns.idFromName(doid.name);

export async function rpc(req: Request, env: Env): Promise<Response> {
  const { binding, chain } = (await req.json()) as { binding: string; chain: Step[] };
  const decl = Object.hasOwn(BINDINGS, binding) ? BINDINGS[binding] : undefined;
  try {
    if (!decl || decl.kind === "var") throw new Error(`no binding ${binding} (declare it in wrangler.jsonc env.control)`);
    if (decl.kind.startsWith("pool:")) return await toPooled(env, decl.kind.slice("pool:".length), chain);
    const target = (env as unknown as Record<string, any>)[binding];
    if (!target) throw new Error(`binding ${binding} is in the manifest but not bound to the control Worker`);
    const result = await applyChain(target, chain, decl.kind === "do" ? idResolver(target) : (d) => d);
    return Response.json({ ok: await encode(result) });
  } catch (e) {
    return Response.json({ error: errorOf(e) });
  }
}

const errorOf = (e: unknown) => ({ name: (e as Error)?.name ?? "Error", message: (e as Error)?.message ?? String(e) });

// Placement lookups, cached per isolate like the edge Worker's; nodes answer 410 when stale.
const placed = new Map<string, { node: string; epoch: number; fresh: boolean; exp: number }>();

async function resolve(env: Env, key: string, refresh: boolean) {
  const hit = placed.get(key);
  if (!refresh && hit && hit.exp > Date.now()) return { ...hit, fresh: false };
  const r = await env.PLACEMENT.getByName("global").resolve(key);
  placed.set(key, { ...r, exp: Date.now() + 30_000 });
  return r;
}

/** First step names the object: getByName(name) or get(id-from-idFromName/newUniqueId). */
function objectName(first: Step | undefined): string {
  if (first && "call" in first) {
    const [arg] = decode(first.args) as any[];
    if (first.call === "getByName" && typeof arg === "string") return arg;
    if (first.call === "get" && arg?.$doid) return arg.$doid.name;
  }
  throw new TypeError("pooled bindings support getByName(name) and get(idFromName(name)) stubs");
}

async function toPooled(env: Env, slug: string, chain: Step[]): Promise<Response> {
  const name = objectName(chain[0]);
  const rest = chain.slice(1);
  const key = `${slug}/${name}`;
  const last = rest[0];
  // stub.fetch(request): forwarded as-is; anything else is an RPC the node's router replays.
  const isFetch = rest.length === 1 && "call" in last! && last.call === "fetch";
  const original = isFetch ? (decode((last as { args: unknown }).args) as Request[])[0] : null;
  for (let attempt = 0; ; attempt++) {
    const p = await resolve(env, key, attempt > 0);
    const headers = new Headers(original?.headers);
    headers.set("x-do-class", slug);
    headers.set("x-do-name", name);
    headers.set("x-do-epoch", String(p.epoch));
    if (p.fresh) headers.set("x-do-fresh", "1");
    else headers.delete("x-do-fresh");
    const init: RequestInit = original
      ? { method: original.method, headers, body: original.body ? await original.clone().arrayBuffer() : null }
      : { method: "POST", headers: (headers.set("x-do-call", "1"), headers), body: JSON.stringify({ chain: rest }) };
    const res = await env.POOL.getByName(p.node).fetch(original?.url ?? "http://pool/rpc", init);
    // Moved, or the node is mid-move (fenced): re-resolve and retry; nothing ran on the object.
    if (res.status === 410 && res.headers.has("x-pool-moved") && attempt < 4) {
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      continue;
    }
    if (original) return Response.json({ ok: await encode(res) });
    return res; // the router already answered { ok } / { error }
  }
}
