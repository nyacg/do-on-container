import { DurableObject } from "cloudflare:workers";
import { readSnapshot } from "./ckpt-store";
import { BINDINGS } from "./generated/bindings";
import { withRemoteBindings } from "./remote-bindings";
import { dumpStorage, gunzip, gzip, restoreStorage, type Snapshot } from "./storage-dump";

/**
 * Base class for Durable Objects that can run either on Cloudflare (real DO) or inside a
 * pooled workerd process in a Cloudflare Container.
 *
 * On Cloudflare this is a thin no-op wrapper. Inside the pool it adds:
 *  - hydration from the last R2 checkpoint the first time the object wakes on a fresh disk
 *  - dirty tracking on `ctx.storage` writes, so the node's periodic flush only checkpoints
 *    objects that changed
 *  - drain support (checkpoint + close sockets with 1012) for scale-down and rollouts
 *  - alarms that survive moves: the pending alarm is part of the checkpoint and re-armed on
 *    hydration; objects with pending alarms are tracked so a draining/sleeping node can hand
 *    them to Placement's alarm registry, which wakes them when they're due
 *
 * Put initialisation in `onStart()` instead of the constructor: it runs after hydration.
 */
/** Largest checkpoint a pooled object may write or a node may download (gzipped). Pooled objects
 *  restore their whole SQLite from one snapshot, so a big object must keep bulk data elsewhere
 *  (e.g. R2) or mark cache tables with `poolSnapshotExclude()`. */
export const DEFAULT_MAX_SNAPSHOT_MB = 256;

export function maxSnapshotBytes(env: PoolEnv) {
  return Number(env.POOL_MAX_SNAPSHOT_MB ?? DEFAULT_MAX_SNAPSHOT_MB) * 1024 * 1024;
}

export interface PoolEnv {
  /** Override for DEFAULT_MAX_SNAPSHOT_MB. */
  POOL_MAX_SNAPSHOT_MB?: string;
  /** Set to "1" by the container's workerd config. Absent on Cloudflare. */
  __DO_POOL?: string;
  /** Fetcher that reaches the Worker-side bindings bridge (http://bridge.internal). */
  __BRIDGE?: Fetcher;
}

/** Shared across every DO in the workerd process (one isolate per worker in workerd). */
export const poolRegistry = {
  /** Objects constructed in this process. WeakRefs, so evicted objects drop out after GC. */
  live: new Map<string, WeakRef<PortableDurableObject<any>>>(),
  dirty: new Set<string>(),
  /** Keys Placement says have never existed anywhere: nothing to hydrate. */
  fresh: new Set<string>(),
  /** Assignment epoch of the request that's about to construct each object (set by the router). */
  epochs: new Map<string, number>(),
  /** Objects with a pending alarm (set via setAlarm, cleared when it fires or is deleted). */
  alarmed: new Set<string>(),
  checkpoints: 0,
  checkpointBytes: 0,
  segments: 0,
  hydrations: 0,
};

export function poolKey(cls: string, name: string) {
  return `${cls}/${name}`;
}

const META_TABLE = "_pool_meta";

export abstract class PortableDurableObject<Env extends PoolEnv = PoolEnv> extends DurableObject<Env> {
  /** Stable class slug used in URLs and checkpoint keys, e.g. "cursors". */
  static slug: string;
  readonly pooled: boolean;
  readonly doName: string;
  private poolKey: string;
  private poolDrained = false; // set by poolClose()
  /** Second fence, inside the object: requests that got past the router's fence just before a
   *  move are refused (410) or finished before the hand-off snapshot is taken. */
  private poolFrozen = false;
  private poolInflight = 0;
  /** Untracked storage handle for the pool's own reads/writes (meta, restore, dump). */
  private rawStorage: DurableObjectStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const slug = (this.constructor as typeof PortableDurableObject).slug;
    this.pooled = env.__DO_POOL === "1";
    this.doName = ctx.id.name ?? ctx.id.toString();
    this.poolKey = poolKey(slug, this.doName);
    this.rawStorage = ctx.storage;
    if (this.pooled) {
      const key = this.poolKey;
      // Bindings declared in wrangler.jsonc (KV, R2, AI, services, other DO classes) don't exist
      // inside the container: give the object proxies that run each call in the control Worker.
      this.env = withRemoteBindings(env, BINDINGS);
      this.ctx = trackWrites(ctx, {
        dirty: () => poolRegistry.dirty.add(key),
        alarm: (set) => (set ? poolRegistry.alarmed.add(key) : poolRegistry.alarmed.delete(key)),
      }) as typeof this.ctx;
      poolRegistry.live.set(key, new WeakRef(this));
      // workerd deletes the alarm before invoking the handler; a handler that re-arms re-adds
      // the key via setAlarm, and a handler that throws is retried, so it stays pending.
      const fetchHandler = (this as { fetch?: (req: Request) => Promise<Response> }).fetch;
      if (fetchHandler) {
        (this as any).fetch = async (req: Request) => {
          if (this.poolFrozen) return new Response("object moved", { status: 410, headers: { "x-pool-moved": "object" } });
          this.poolInflight++;
          try {
            return await fetchHandler.call(this, req);
          } finally {
            this.poolInflight--;
          }
        };
      }
      const handler = (this as { alarm?: (info?: AlarmInvocationInfo) => unknown }).alarm;
      if (handler) {
        (this as any).alarm = async (info?: AlarmInvocationInfo) => {
          // Mid-move: throw so workerd retries it (after an abandoned move), or so the retire's
          // deleteAll cancels it (the new node re-armed it from the hand-off snapshot).
          if (this.poolFrozen) throw new Error("object is moving");
          poolRegistry.alarmed.delete(key);
          try {
            return await handler.call(this, info);
          } catch (e) {
            poolRegistry.alarmed.add(key);
            throw e;
          }
        };
      }
    }
    ctx.blockConcurrencyWhile(async () => {
      if (this.pooled) await this.poolHydrate();
      await this.onStart();
    });
  }

  /**
   * Tables that are caches (rebuildable from elsewhere): their schema goes into checkpoints, their
   * rows don't. Keeps a big local cache from turning into a big snapshot that every move and
   * every cold node has to download.
   */
  protected poolSnapshotExclude(): string[] {
    return [];
  }

  /** Override for setup that needs storage (runs after hydration). */
  protected onStart(): void | Promise<void> {}

  /** Extra state to include in checkpoints (e.g. a facet's own database). JSON-serialisable. */
  protected poolExtraState(): unknown | Promise<unknown> {
    return undefined;
  }

  /** Counterpart of poolExtraState(), called after the object's own storage is restored. */
  protected poolRestoreExtra(_extra: unknown): void | Promise<void> {}

  /** For state the write tracker can't see (e.g. writes inside a facet). */
  protected markPoolDirty() {
    if (this.pooled) poolRegistry.dirty.add(this.poolKey);
  }

  // ---- pool lifecycle (called by the in-container router over RPC) ----

  /**
   * Gzipped dump of this object's storage. Clears the dirty flag; the router writes the bytes
   * into a segment (and re-marks the object dirty if that write fails).
   */
  async poolSnapshot(): Promise<{ bytes: ArrayBuffer; alarm: number | null }> {
    const cap = maxSnapshotBytes(this.env);
    const exclude = new Set(this.poolSnapshotExclude());
    // Cheap early refusal: the whole database is far beyond what a snapshot may hold.
    const size = (this.rawStorage.sql as { databaseSize?: number }).databaseSize;
    if (!exclude.size && typeof size === "number" && size > cap * 8) throw this.tooBig(size, "database", cap);
    poolRegistry.dirty.delete(this.poolKey);
    const snapshot = dumpStorage(this.rawStorage, { exclude });
    const alarm = await this.rawStorage.getAlarm();
    const extra = await this.poolExtraState();
    const bytes = await gzip(JSON.stringify({ v: 2, key: this.poolKey, at: Date.now(), alarm, extra, ...snapshot }));
    if (bytes.byteLength > cap) {
      poolRegistry.dirty.add(this.poolKey); // nothing was checkpointed
      throw this.tooBig(bytes.byteLength, "snapshot", cap);
    }
    return { bytes, alarm };
  }

  private tooBig(bytes: number, what: string, cap: number) {
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    return new Error(
      `${this.poolKey}: ${what} is ${mb(bytes)} MB, over the ${mb(cap)} MB snapshot cap (POOL_MAX_SNAPSHOT_MB). ` +
        `Mark cache tables with poolSnapshotExclude(), or keep bulk data in R2 and fetch it on demand.`,
    );
  }

  /** No-op RPC: constructing the object hydrates it and re-arms its alarm (alarm registry wake). */
  async poolWake(): Promise<{ alarm: number | null }> {
    return { alarm: await this.rawStorage.getAlarm() };
  }

  /**
   * Close every socket (1012) so clients reconnect and get re-placed. The router fences the
   * object (410s) before calling this and snapshots it afterwards, so nothing written by a
   * client can land between the snapshot and the move.
   */
  async poolClose(reason = "moved"): Promise<void> {
    if (this.poolDrained) return;
    this.poolDrained = true;
    this.poolFrozen = true;
    for (let waited = 0; this.poolInflight > 0 && waited < 10_000; waited += 10) await sleep(10);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1012, reason);
      } catch {}
    }
    poolRegistry.live.delete(this.poolKey);
  }

  /** The move was abandoned (nothing persisted): serve again. */
  async poolUnfreeze(): Promise<void> {
    this.poolFrozen = false;
    this.poolDrained = false;
    poolRegistry.live.set(this.poolKey, new WeakRef(this));
  }

  /**
   * The object now lives on another node and its hand-off snapshot is durable: drop the local
   * copy and the in-memory instance, so if it's ever assigned back here it re-hydrates
   * instead of resurrecting stale state.
   */
  async poolRetire(): Promise<void> {
    poolRegistry.dirty.delete(this.poolKey);
    poolRegistry.live.delete(this.poolKey);
    await this.rawStorage.deleteAll();
    this.ctx.abort("moved to another node");
  }

  /** Open WebSockets held by this object (the node only sleeps when the total is 0). */
  async poolSockets(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  private async poolHydrate() {
    const storage = this.rawStorage;
    const sql = storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (k TEXT PRIMARY KEY, v TEXT)`);
    const meta = Object.fromEntries(
      sql.exec<{ k: string; v: string }>(`SELECT k, v FROM ${META_TABLE}`).toArray().map((r) => [r.k, r.v]),
    );
    const epoch = poolRegistry.epochs.get(this.poolKey) ?? 0;
    poolRegistry.epochs.delete(this.poolKey);
    if (meta.hydrated) {
      // A local copy from an older assignment (e.g. this node slept or was presumed dead and the
      // object lived elsewhere meanwhile) is stale: drop it and hydrate from the latest checkpoint.
      if (!(epoch > Number(meta.epoch ?? 0))) return;
      await storage.deleteAll();
      sql.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (k TEXT PRIMARY KEY, v TEXT)`);
    }
    const fresh = poolRegistry.fresh.delete(this.poolKey);
    const bytes = fresh ? null : await readSnapshot(this.env, this.poolKey);
    if (bytes) {
      const snap = JSON.parse(await gunzip(bytes)) as Snapshot & { alarm?: number | null; extra?: unknown };
      restoreStorage(storage, snap);
      if (snap.extra !== undefined) await this.poolRestoreExtra(snap.extra);
      // workerd keeps alarms outside the object's tables; re-arm explicitly (past-due fires now).
      if (snap.alarm) {
        await storage.setAlarm(snap.alarm);
        poolRegistry.alarmed.add(this.poolKey);
      }
      poolRegistry.hydrations++;
    }
    sql.exec(`INSERT OR REPLACE INTO ${META_TABLE} VALUES ('hydrated', ?), ('epoch', ?)`, String(Date.now()), String(epoch));
  }
}

// ---------------------------------------------------------------------------------------------
// Write tracking: wrap ctx.storage so any mutating call marks the object dirty.

// Statements that can't change what a checkpoint would contain. `CREATE ... IF NOT EXISTS`
// runs on every wake; counting it would re-checkpoint every object every time it wakes.
const READ_ONLY_SQL =
  /^\s*(select|pragma|explain|with\s[\s\S]*?\)\s*select|create\s+(unique\s+)?(table|index|trigger|view)\s+if\s+not\s+exists)\b/i;

function trackWrites(
  ctx: DurableObjectState,
  hooks: { dirty: () => void; alarm: (set: boolean) => void },
): DurableObjectState {
  const markDirty = hooks.dirty;
  const bind = (target: any, value: any) => (typeof value === "function" ? value.bind(target) : value);
  const sql = new Proxy(ctx.storage.sql, {
    get(t, p) {
      if (p === "exec")
        return (query: string, ...args: any[]) => {
          if (!READ_ONLY_SQL.test(query)) markDirty();
          return t.exec(query, ...args);
        };
      return bind(t, Reflect.get(t, p, t));
    },
  });
  const kv = new Proxy(ctx.storage.kv, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      if (p === "put" || p === "delete") return (...a: any[]) => (markDirty(), (v as Function).apply(t, a));
      return bind(t, v);
    },
  });
  const writes = new Set(["put", "delete", "deleteAll", "transaction", "transactionSync", "setAlarm", "deleteAlarm"]);
  const storage = new Proxy(ctx.storage, {
    get(t, p) {
      if (p === "sql") return sql;
      if (p === "kv") return kv;
      const v = Reflect.get(t, p, t);
      if (p === "setAlarm" || p === "deleteAlarm")
        return (...a: any[]) => (markDirty(), hooks.alarm(p === "setAlarm"), (v as Function).apply(t, a));
      if (p === "deleteAll") return (...a: any[]) => (markDirty(), hooks.alarm(false), (v as Function).apply(t, a));
      if (typeof p === "string" && writes.has(p)) return (...a: any[]) => (markDirty(), (v as Function).apply(t, a));
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
