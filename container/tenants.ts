/**
 * Sandboxed tenants ("sapp" objects): each app runs in its own workerd process, started by
 * spawner.sh inside bwrap as its own uid, with private user/mount/pid/net namespaces, only its
 * own data directory, and no network. The router (this module, in the trusted process):
 *
 *  - assigns each app a slot and asks the spawner to start it (via the spawn-queue directory)
 *  - forwards `sapp/<app>:<name>` requests to the app's process over its unix socket, where
 *    the object is an ordinary pooled FacetHost (`app/<app>:<name>`)
 *  - fans the node's admin operations (flush, drain, evict, wake, alarms) out to tenants
 *  - is each tenant's only egress (`TenantBridge`): app code, plus checkpoint segments and
 *    manifests named for *that* tenant — nothing else
 */
import { WorkerEntrypoint } from "cloudflare:workers";

export const TENANT_SLOTS = 32;
const SUFFIX = (app: string) => `--t--${app}`;

export interface TenantEnv {
  NODE_NAME: string;
  SPAWNQ: Fetcher;
  SLOTS: Fetcher;
  [slot: `SLOT${number}`]: Fetcher;
}

const slotOf = new Map<string, number>();
const tenantOf = new Map<number, string>();
const starting = new Map<string, number>(); // app → start time (plain data; no shared promises)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function tenants() {
  return [...slotOf].map(([app, slot]) => ({ app, slot }));
}

export function appOfKey(key: string) {
  // sapp/<app>:<name>
  return key.slice("sapp/".length).split(":")[0];
}

/** Map router keys (sapp/…) to the tenant process's keys (app/…) and back. */
export const toTenantKey = (key: string) => "app/" + key.slice("sapp/".length);
export const fromTenantKey = (key: string) => "sapp/" + key.slice("app/".length);

/** The tenant's process, starting it if needed. */
export async function tenantFetcher(env: TenantEnv, app: string): Promise<Fetcher> {
  if (!/^[a-z0-9-]{1,40}$/.test(app)) throw new Error(`bad app id ${app}`);
  let slot = slotOf.get(app);
  if (slot === undefined) {
    if (!starting.has(app)) {
      const free = [...Array(TENANT_SLOTS).keys()].find((i) => !tenantOf.has(i));
      if (free === undefined) throw new Error("no free tenant slots on this node");
      tenantOf.set(free, app);
      starting.set(app, Date.now());
      await spawn(env, free, app);
      starting.delete(app);
      slotOf.set(app, free);
    } else {
      while (starting.has(app)) await sleep(25); // another request is starting it
    }
    slot = slotOf.get(app);
    if (slot === undefined) throw new Error(`tenant ${app} failed to start`);
  }
  return env[`SLOT${slot}`];
}

/** Ask the spawner to (re)start `app` on `slot` and wait for this spawn's ready marker. */
async function spawn(env: TenantEnv, slot: number, app: string) {
  const nonce = crypto.randomUUID();
  await env.SPAWNQ.fetch(`http://q/${slot}`, { method: "PUT", body: `${app} ${nonce}` });
  for (let t = 0; t < 10_000; t += 25) {
    const r = await env.SLOTS.fetch(`http://s/${slot}/ready`);
    if (r.ok && (await r.text()).trim() === nonce) return;
    await sleep(25);
  }
  throw new Error(`tenant ${app} did not start on slot ${slot}`);
}

/**
 * Forward to the tenant's process; if its socket is dead (process gone), restart it once.
 * Only retried for requests without a body (WebSocket upgrades, GETs).
 */
export async function tenantFetch(env: TenantEnv, app: string, req: Request): Promise<Response> {
  const retryable = req.method === "GET" || req.method === "HEAD";
  try {
    return await (await tenantFetcher(env, app)).fetch(retryable ? req.clone() : req);
  } catch (e) {
    const slot = slotOf.get(app);
    if (!retryable || slot === undefined) throw e;
    await spawn(env, slot, app);
    return (await tenantFetcher(env, app)).fetch(req);
  }
}

/** Run an admin operation on every running tenant process. */
export async function fanOut(env: TenantEnv, path: string, init?: RequestInit) {
  return Promise.all(
    tenants().map(async ({ app, slot }) => {
      try {
        const res = await env[`SLOT${slot}`].fetch(`http://tenant${path}`, init);
        return { app, ok: res.ok, body: (await res.json()) as any };
      } catch (e) {
        return { app, ok: false, body: { error: String(e) } };
      }
    }),
  );
}

/** Group router keys by tenant app (only sapp/ keys). */
export function byTenant<T extends { key: string }>(items: T[]) {
  const m = new Map<string, T[]>();
  for (const it of items) {
    if (!it.key.startsWith("sapp/")) continue;
    const app = appOfKey(it.key);
    m.set(app, [...(m.get(app) ?? []), it]);
  }
  return m;
}

/**
 * A tenant process's only egress. Allows: its app code; checkpoint segments/manifests whose
 * node name carries its tenant suffix; manifest listing filtered to its own manifests.
 */
export class TenantBridge extends WorkerEntrypoint<TenantEnv, { slot: number }> {
  override async fetch(req: Request): Promise<Response> {
    const app = tenantOf.get(this.ctx.props.slot);
    if (!app) return new Response("no tenant on this slot", { status: 403 });
    const url = new URL(req.url);
    const p = url.pathname;
    const own = (node: string) => node.endsWith(SUFFIX(app));
    const forward = () => fetch(new Request(`http://bridge.internal${p}${url.search}`, req));
    if (p.startsWith("/blob/code/") && req.method === "GET") return forward();
    if (p.startsWith("/blob/seg/") && own(decodeURIComponent(p).split("/")[3] ?? "")) return forward();
    if (p.startsWith("/blob/manifest/") && own(decodeURIComponent(p).slice("/blob/manifest/".length))) return forward();
    if (p === "/list" && url.searchParams.get("prefix") === "manifest/") {
      const keys = (await (await forward()).json()) as string[];
      return Response.json(keys.filter((k) => own(k.slice("manifest/".length))));
    }
    return new Response(`tenant ${app} may not access ${p}`, { status: 403 });
  }
}
