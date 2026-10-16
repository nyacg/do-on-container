/**
 * Facet shim: the `mainModule` of every dynamically loaded app. It re-exports the app's class
 * wrapped with what the host needs (bundled to a string by scripts/gen-facet.mjs):
 *
 *  - `__poolDump` / `__poolRestore`: checkpoint the facet's own SQLite (the root's dump can't
 *    see it) so pooled facets move and survive like any other pooled object
 *  - write tracking: the first write after a checkpoint pings the host so it gets flushed
 *  - alarm proxy: facets can't own alarms ("Facets currently cannot set alarms", on Cloudflare
 *    and in workerd), so set/get/deleteAlarm go to the host root, whose alarm() calls
 *    `__poolAlarm`
 *
 * The host is reached through `env.__HOST` (a FacetCtl entrypoint scoped to this code id):
 * Cloudflare rejects service stubs in facet props, but accepts them in a dynamic Worker's env.
 *  - `__poolClose`: close the facet's WebSockets with 1012 before a move or a code swap
 */
// @ts-ignore resolved inside the dynamic worker
import * as user from "./user.js";
import { dumpStorage, restoreStorage } from "./storage-dump";

interface HostCtl {
  dirty(name: string): Promise<void>;
  setAlarm(name: string, at: number): Promise<void>;
  getAlarm(name: string): Promise<number | null>;
  deleteAlarm(name: string): Promise<void>;
}

const UserClass = (user as any).App ?? (user as any).default;
const READ_ONLY_SQL =
  /^\s*(select|pragma|explain|with\s[\s\S]*?\)\s*select|create\s+(unique\s+)?(table|index|trigger|view)\s+if\s+not\s+exists)\b/i;

function wrap(ctx: DurableObjectState, host: HostCtl, state: { dirty: boolean }): DurableObjectState {
  const name = ctx.id.name!;
  const touch = () => {
    if (state.dirty) return;
    state.dirty = true;
    ctx.waitUntil(host.dirty(name).catch(() => (state.dirty = false)));
  };
  const bind = (t: any, v: any) => (typeof v === "function" ? v.bind(t) : v);
  const sql = new Proxy(ctx.storage.sql, {
    get(t, p) {
      if (p === "exec") return (q: string, ...a: any[]) => (READ_ONLY_SQL.test(q) || touch(), t.exec(q, ...a));
      return bind(t, Reflect.get(t, p, t));
    },
  });
  const kv = new Proxy(ctx.storage.kv, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      if (p === "put" || p === "delete") return (...a: any[]) => (touch(), (v as Function).apply(t, a));
      return bind(t, v);
    },
  });
  const writes = new Set(["put", "delete", "deleteAll", "transaction", "transactionSync"]);
  const storage = new Proxy(ctx.storage, {
    get(t, p) {
      if (p === "sql") return sql;
      if (p === "kv") return kv;
      if (p === "setAlarm") return (at: number | Date) => host.setAlarm(name, +at);
      if (p === "getAlarm") return () => host.getAlarm(name);
      if (p === "deleteAlarm") return () => host.deleteAlarm(name);
      // deleteAll() also cancels the alarm — which lives on the host.
      if (p === "deleteAll")
        return async (...a: any[]) => (touch(), await host.deleteAlarm(name), (t.deleteAll as Function).apply(t, a));
      const v = Reflect.get(t, p, t);
      if (typeof p === "string" && writes.has(p)) return (...a: any[]) => (touch(), (v as Function).apply(t, a));
      return bind(t, v);
    },
  });
  return new Proxy(ctx, {
    get(t, p) {
      if (p === "storage") return storage;
      return bind(t, Reflect.get(t, p, t));
    },
  });
}

export class App extends UserClass {
  private __raw: DurableObjectStorage;
  private __state: { dirty: boolean };

  constructor(ctx: DurableObjectState, env: unknown) {
    // The runtime type-checks ctx in DurableObject's constructor, so wrap it afterwards
    // (writes made inside the app's own constructor aren't tracked).
    super(ctx, env);
    const host = (env as { __HOST?: HostCtl } | undefined)?.__HOST;
    this.__raw = ctx.storage;
    this.__state = { dirty: false };
    if (host) (this as any).ctx = wrap(ctx, host, this.__state);
  }

  async __poolDump() {
    this.__state.dirty = false;
    return dumpStorage(this.__raw);
  }

  async __poolRestore(snap: ReturnType<typeof dumpStorage>) {
    restoreStorage(this.__raw, snap);
  }

  async __poolAlarm(info?: AlarmInvocationInfo) {
    return (UserClass.prototype.alarm as Function | undefined)?.call(this, info);
  }

  async __poolSockets() {
    return ((this as any).ctx as DurableObjectState).getWebSockets().length;
  }

  async __poolClose(code = 1012, reason = "moved") {
    for (const ws of ((this as any).ctx as DurableObjectState).getWebSockets()) {
      try {
        ws.close(code, reason);
      } catch {}
    }
  }
}
