/**
 * Transparent bindings for pooled objects. Inside the container there are no Cloudflare
 * bindings, so `env.KV`, `env.FILES`, `env.AI`, `env.ECHO`, `env.CONF`… are proxies: every call
 * chain (`env.FILES.put(k, v)`, `env.CONF.getByName(x).ping()`) is recorded and sent to the
 * bridge (`POST http://bridge.internal/rpc`), which replays it against the real binding in the
 * control Worker and returns the result.
 *
 * Kinds (generated from wrangler.jsonc into objects/generated/bindings.ts):
 *   kv · r2 · ai · service · do (a real DO namespace) · pool:<slug> (another pooled class,
 *   routed through Placement to whichever node owns the object) · var (plain value)
 */
import { decode, encode, type Step } from "./rpc-wire";
import { bridgeFetch } from "./ckpt-store";
import type { PoolEnv } from "./portable";

export type BindingKind = "kv" | "r2" | "ai" | "service" | "do" | `pool:${string}` | "var";
export type BindingManifest = Record<string, { kind: BindingKind; value?: string }>;

const DO_LOCAL = new Set(["idFromName", "idFromString", "newUniqueId"]);

async function invoke(env: PoolEnv, binding: string, chain: Step[]) {
  const wire = await Promise.all(chain.map(async (s) => ("call" in s ? { call: s.call, args: await encode(s.args) } : s)));
  const res = await bridgeFetch(env, "/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ binding, chain: wire }),
  });
  const out = (await res.json()) as { ok?: unknown; error?: { name: string; message: string } };
  if (out.error) throw Object.assign(new Error(out.error.message), { name: out.error.name });
  return decode(out.ok);
}

/**
 * A callable, chainable, awaitable recorder: `env.CONF.getByName("x").ping(1)` builds
 * [get getByName, call(x), …] and runs as one round trip when awaited (as with Workers RPC
 * pipelining, nothing in the middle needs awaiting).
 */
function recorder(env: PoolEnv, binding: string, kind: BindingKind, chain: Step[]): any {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "then" || prop === "catch" || prop === "finally") {
        if (!chain.length) return undefined; // the binding object itself isn't awaitable
        const p = invoke(env, binding, chain);
        return (p as any)[prop].bind(p);
      }
      // DurableObjectNamespace id helpers are local and synchronous, as on Cloudflare.
      if (!chain.length && (kind === "do" || kind.startsWith("pool:")) && DO_LOCAL.has(prop)) {
        return (name?: string) => {
          const n = prop === "newUniqueId" ? crypto.randomUUID() : String(name);
          return { $doid: { name: n }, name: n, toString: () => n, equals: (o: any) => o?.name === n };
        };
      }
      return recorder(env, binding, kind, [...chain, { get: prop }]);
    },
    apply(_t, _this, args: unknown[]) {
      const last = chain[chain.length - 1];
      if (!last || !("get" in last)) throw new TypeError(`${binding}: not a function`);
      // fetch(input, init) → one Request, so body and headers travel intact.
      const a = last.get === "fetch" ? [new Request(args[0] as RequestInfo, args[1] as RequestInit)] : args;
      return recorder(env, binding, kind, [...chain.slice(0, -1), { call: last.get, args: a }]);
    },
  });
}

/**
 * Wrap a pooled object's env: declared bindings become remote proxies; everything else
 * (internal pool bindings, plain vars set in workerd) passes through.
 */
export function withRemoteBindings<E extends object>(env: E, manifest: BindingManifest): E {
  return new Proxy(env, {
    get(t, prop) {
      if (typeof prop === "string" && Object.hasOwn(manifest, prop)) {
        const b = manifest[prop];
        if (b.kind === "var") return b.value;
        return recorder(t as PoolEnv, prop, b.kind, []);
      }
      return Reflect.get(t, prop, t);
    },
  });
}
