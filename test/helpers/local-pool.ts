import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

/** Bundle the real handlers; only the Cloudflare base classes are replaced. */
export async function loadPool() {
  const dir = await mkdtemp(join(tmpdir(), "pool-regressions-"));
  const outfile = join(dir, "pool.mjs");
  await build({
    stdin: {
      contents: `
        export { default as edge } from './src/worker';
        export { default as router } from './container/router';
        export { rpc } from './src/rpc-server';
        export { Placement } from './src/placement';
        export { PortableDurableObject, poolRegistry } from './objects/portable';
        export { encode, decode } from './objects/rpc-wire';
        export { gunzip } from './objects/storage-dump';
      `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    define: { __BUILD__: '"regression-test"' },
    plugins: [{
      name: "cloudflare-base-classes",
      setup(b) {
        b.onResolve({ filter: /^(cloudflare:workers|@cloudflare\/containers)$/ }, (args) => ({ path: args.path, namespace: "platform" }));
        b.onLoad({ filter: /.*/, namespace: "platform" }, () => ({ contents: `
          export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
          export class WorkerEntrypoint extends DurableObject {}
          export class Container extends DurableObject {}
          export class ContainerProxy extends DurableObject {}
        ` }));
      },
    }],
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run Placement's actual SQL against SQLite, including assignment and alarm ownership. */
export function objectContext(name = "test") {
  const db = new DatabaseSync(":memory:");
  const kv = new Map<string, unknown>();
  const pending: Promise<unknown>[] = [];
  let alarm: number | null = null;
  const sql = {
    exec(query: string, ...args: any[]) {
      if (query.split(";").filter((q) => q.trim()).length > 1) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const statement = db.prepare(query);
      const rows = statement.all(...args);
      const columns = Object.keys(rows[0] ?? {});
      return {
        toArray: () => rows,
        one: () => rows[0],
        raw: () => rows.map((r) => columns.map((c) => r[c])),
        columnNames: columns,
        rowsWritten: (db.prepare("SELECT changes() AS n").get() as any).n,
      };
    },
  };
  return {
    id: { name },
    storage: {
      sql,
      kv: { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => kv.set(k, v), delete: (k: string) => kv.delete(k), list: () => kv },
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => { alarm = at; },
      deleteAlarm: async () => { alarm = null; },
      deleteAll: async () => {
        kv.clear();
        alarm = null;
        for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
          db.exec(`DROP TABLE "${name}"`);
        }
      },
    },
    getWebSockets: () => [],
    abort: () => { throw new Error("object aborted"); },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => { pending.push(fn()); },
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    settle: async () => { while (pending.length) await Promise.all(pending.splice(0)); },
    close: () => db.close(),
  };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
