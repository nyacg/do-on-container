/**
 * Storage dump / restore for SQLite-backed Durable Objects. Pure functions over the
 * `DurableObjectStorage` API, shared by the pool base class and the facet shim (which is
 * bundled into a string and loaded with the Worker Loader, so nothing here may import from
 * the rest of the project).
 *
 * Walks sqlite_master for user tables, indexes, triggers and views, plus the KV API (which
 * lives in a hidden table).
 */
export interface Snapshot {
  schema: { type: string; name: string; sql: string }[];
  tables: { name: string; cols: string[]; rows: unknown[][] }[];
  kv: [string, unknown][];
}

export function dumpStorage(storage: DurableObjectStorage): Snapshot {
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

export function restoreStorage(storage: DurableObjectStorage, snap: Snapshot) {
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

export async function gzip(s: string): Promise<ArrayBuffer> {
  const stream = new Blob([s]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}
export async function gunzip(buf: ArrayBuffer): Promise<string> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

