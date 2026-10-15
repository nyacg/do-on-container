import { DurableObject } from "cloudflare:workers";
import { readSnapshot } from "./ckpt-store";

/**
 * Base class for Durable Objects that can run either on Cloudflare (real DO) or inside a
 * pooled workerd process in a Cloudflare Container.
 *
 * On Cloudflare this is a thin no-op wrapper. Inside the pool it adds:
 *  - hydration from the last R2 checkpoint the first time the object wakes on a fresh disk
 *  - dirty tracking on `ctx.storage` writes, so the node's periodic flush only checkpoints
 *    objects that changed
 *  - drain support (checkpoint + close sockets with 1012) for scale-down and rollouts
 *
 * Put initialisation in `onStart()` instead of the constructor: it runs after hydration.
 */
export interface PoolEnv {
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
  checkpoints: 0,
  checkpointBytes: 0,
  segments: 0,
  hydrations: 0,
};

export function poolKey(cls: string, name: string) {
  return `${cls}/${name}`;
}

const META_TABLE = "_pool_meta";
type Row = Record<string, SqlStorageValue>;

export abstract class PortableDurableObject<Env extends PoolEnv = PoolEnv> extends DurableObject<Env> {
  /** Stable class slug used in URLs and checkpoint keys, e.g. "cursors". */
  static slug: string;
  readonly pooled: boolean;
  readonly doName: string;
  private poolKey: string;
  private poolDrained = false; // set by poolClose()
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
      this.ctx = trackWrites(ctx, () => poolRegistry.dirty.add(this.poolKey)) as typeof this.ctx;
      poolRegistry.live.set(this.poolKey, new WeakRef(this));
    }
    ctx.blockConcurrencyWhile(async () => {
      if (this.pooled) await this.poolHydrate();
      await this.onStart();
    });
  }

  /** Override for setup that needs storage (runs after hydration). */
  protected onStart(): void | Promise<void> {}

  // ---- pool lifecycle (called by the in-container router over RPC) ----

  /**
   * Gzipped dump of this object's storage. Clears the dirty flag; the router writes the bytes
   * into a segment (and re-marks the object dirty if that write fails).
   */
  async poolSnapshot(): Promise<ArrayBuffer> {
    poolRegistry.dirty.delete(this.poolKey);
    const snapshot = dumpStorage(this.rawStorage);
    return gzip(JSON.stringify({ v: 1, key: this.poolKey, at: Date.now(), ...snapshot }));
  }

  /**
   * Close every socket (1012) so clients reconnect and get re-placed. The router fences the
   * object (410s) before calling this and snapshots it afterwards, so nothing written by a
   * client can land between the snapshot and the move.
   */
  async poolClose(reason = "moved"): Promise<void> {
    if (this.poolDrained) return;
    this.poolDrained = true;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1012, reason);
      } catch {}
    }
    poolRegistry.live.delete(this.poolKey);
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

  poolStats() {
    return { key: this.poolKey, sockets: this.ctx.getWebSockets().length };
  }

  private async poolHydrate() {
    const sql = this.rawStorage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (k TEXT PRIMARY KEY, v TEXT)`);
    const done = sql.exec(`SELECT v FROM ${META_TABLE} WHERE k = 'hydrated'`).toArray();
    if (done.length) return;
    const fresh = poolRegistry.fresh.delete(this.poolKey);
    const bytes = fresh ? null : await readSnapshot(this.env, this.poolKey);
    if (bytes) {
      restoreStorage(this.rawStorage, JSON.parse(await gunzip(bytes)));
      poolRegistry.hydrations++;
    }
    sql.exec(`INSERT OR REPLACE INTO ${META_TABLE} VALUES ('hydrated', ?)`, String(Date.now()));
  }
}

// ---------------------------------------------------------------------------------------------
// Storage dump / restore. Works on any SQLite-backed DO: walks sqlite_master for user tables,
// indexes, triggers and views, plus the KV API (which lives in a hidden table).

interface Snapshot {
  schema: { type: string; name: string; sql: string }[];
  tables: { name: string; cols: string[]; rows: unknown[][] }[];
  kv: [string, unknown][];
}

function dumpStorage(storage: DurableObjectStorage): Snapshot {
  const sql = storage.sql;
  const schema = sql
    .exec<{ type: string; name: string; sql: string }>(
      `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '_pool_%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
    )
    .toArray();
  const tables = schema
    .filter((s) => s.type === "table")
    .map(({ name }) => {
      const cursor = sql.exec(`SELECT * FROM "${name}"`);
      return { name, cols: cursor.columnNames, rows: [...cursor.raw()].map((r) => r.map(encodeValue)) };
    });
  const kv = [...storage.kv.list()].map(([k, v]) => [k, encodeValue(v)] as [string, unknown]);
  return { schema, tables, kv };
}

function restoreStorage(storage: DurableObjectStorage, snap: Snapshot) {
  const sql = storage.sql;
  storage.transactionSync(() => {
    const order = ["table", "index", "trigger", "view"];
    for (const s of [...snap.schema].sort((a, b) => order.indexOf(b.type) - order.indexOf(a.type))) {
      sql.exec(`DROP ${s.type.toUpperCase()} IF EXISTS "${s.name}"`);
    }
    for (const s of [...snap.schema].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))) {
      if (s.type === "table") {
        sql.exec(s.sql);
        const t = snap.tables.find((t) => t.name === s.name);
        if (!t) continue;
        const stmt = `INSERT INTO "${t.name}" (${t.cols.map((c) => `"${c}"`).join(",")}) VALUES (${t.cols.map(() => "?").join(",")})`;
        for (const row of t.rows) sql.exec(stmt, ...(row.map(decodeValue) as SqlStorageValue[]));
      } else {
        sql.exec(s.sql);
      }
    }
    for (const [k, v] of snap.kv) storage.kv.put(k, decodeValue(v));
  });
}

function encodeValue(v: unknown): unknown {
  if (v instanceof ArrayBuffer) return { $b: b64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) return { $u8: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  return v;
}
function decodeValue(v: any): any {
  if (v && typeof v === "object") {
    if (typeof v.$b === "string") return unb64(v.$b).buffer;
    if (typeof v.$u8 === "string") return unb64(v.$u8);
  }
  return v;
}
function b64(u8: Uint8Array) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function gzip(s: string): Promise<ArrayBuffer> {
  const stream = new Blob([s]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}
async function gunzip(buf: ArrayBuffer): Promise<string> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

// ---------------------------------------------------------------------------------------------
// Write tracking: wrap ctx.storage so any mutating call marks the object dirty.

// Statements that can't change what a checkpoint would contain. `CREATE ... IF NOT EXISTS`
// runs on every wake; counting it would re-checkpoint every object every time it wakes.
const READ_ONLY_SQL =
  /^\s*(select|pragma|explain|with\s[\s\S]*?\)\s*select|create\s+(unique\s+)?(table|index|trigger|view)\s+if\s+not\s+exists)\b/i;

function trackWrites(ctx: DurableObjectState, markDirty: () => void): DurableObjectState {
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
