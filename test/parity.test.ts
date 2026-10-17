/**
 * API parity: the same assertions against every backend that can host the Conformance object.
 *
 *   BASE=https://do-pool-v2.do-pool-lab.workers.dev BACKENDS=do,pool npm run test:parity
 *
 * Backends are URL prefixes on the edge Worker:
 *   do          real Durable Object                         /do/conf/<name>
 *   pool        pooled DO in workerd in a container         /pool/conf/<name>
 *   do-facet    facet of a real DO, code via Worker Loader  /do/app/<name>
 *   pool-facet  facet inside the pool                       /pool/app/<name>
 *   pool-sbx    facet in a sandboxed per-tenant process     /pool/sapp/<name>
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

const BASE = process.env.BASE ?? "https://do-pool-v2.do-pool-lab.workers.dev";
const BACKENDS = (process.env.BACKENDS ?? "do,pool").split(",");
const RUN = Date.now().toString(36);
const PATHS: Record<string, string> = {
  do: "do/conf",
  pool: "pool/conf",
  "do-facet": "do/app",
  "pool-facet": "pool/app",
  "pool-sbx": "pool/sapp",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Facet backends address objects as `<appId>:<name>` (the app is the conformance code). */
const fullName = (backend: string, name: string) => (backend.includes("facet") || backend.includes("sbx") ? `conf:${RUN}-${name}` : `${RUN}-${name}`);

function client(backend: string, name: string) {
  const base = `${BASE}/${PATHS[backend]}/${fullName(backend, name)}`;
  return {
    async op<T = any>(op: string, params: Record<string, string | number> = {}): Promise<T> {
      const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await fetch(`${base}/${op}?${qs}`);
        } catch (e) {
          if (attempt < 5) {
            await sleep(1000); // flaky client network (ECONNRESET), not the backend
            continue;
          }
          throw e;
        }
        const text = await res.text();
        // Transient: brand-new pool nodes / deploy propagation.
        if ((res.status >= 500 || res.status === 404 || res.status === 410) && attempt < 5 && !text.startsWith("{")) {
          await sleep(1500);
          continue;
        }
        assert.ok(text.startsWith("{"), `${op}: HTTP ${res.status} ${text.slice(0, 200)}`);
        const body = JSON.parse(text);
        assert.equal(body.error, undefined, `${op}: ${body.error}`);
        return body as T;
      }
    },
    socket(tag: string): Promise<{ ws: WebSocket; next: () => Promise<string | Buffer> }> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?tag=${tag}`, { perMessageDeflate: false });
        const queue: (string | Buffer)[] = [];
        const waiters: ((m: string | Buffer) => void)[] = [];
        ws.on("message", (d, isBinary) => {
          const m = isBinary ? (d as Buffer) : d.toString();
          const w = waiters.shift();
          w ? w(m) : queue.push(m);
        });
        const next = () =>
          new Promise<string | Buffer>((res, rej) => {
            const m = queue.shift();
            if (m !== undefined) return res(m);
            const t = setTimeout(() => rej(new Error("websocket message timeout")), 10_000);
            waiters.push((x) => (clearTimeout(t), res(x)));
          });
        ws.on("open", () => resolve({ ws, next }));
        ws.on("error", reject);
        ws.on("unexpected-response", (_q, r) => reject(new Error(`ws upgrade HTTP ${r.statusCode}`)));
      });
    },
  };
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const t0 = Date.now();
  let v = await fn();
  while (!ok(v) && Date.now() - t0 < timeoutMs) {
    await sleep(500);
    v = await fn();
  }
  return v;
}

for (const backend of BACKENDS) {
  describe(`parity: ${backend}`, { concurrency: true }, () => {
    test("ctx.id.name is the name it was addressed by", async () => {
      const c = client(backend, "name");
      const r = await c.op("c/name");
      assert.equal(r.name, fullName(backend, "name"));
    });

    test("SQL: writes persist across requests", async () => {
      const c = client(backend, "sql");
      await c.op("sql/put", { k: "a", v: "1" });
      await c.op("sql/put", { k: "b", v: "2" });
      await c.op("sql/put", { k: "a", v: "3" });
      assert.equal((await c.op("sql/get", { k: "a" })).v, "3");
      assert.equal((await c.op("sql/count")).n, 2);
    });

    test("SQL: BLOB round-trip", async () => {
      const c = client(backend, "blob");
      assert.equal((await c.op("sql/blob")).equal, true);
      assert.deepEqual((await c.op("sql/blobget")).bytes, [0, 1, 2, 250, 251, 252]);
    });

    test("transactionSync rolls back on throw", async () => {
      const c = client(backend, "tx");
      const r = await c.op("sql/tx");
      assert.match(r.threw, /rollback/);
      assert.equal(r.v, null);
    });

    test("sync KV: put/get/list/delete with structured values", async () => {
      const c = client(backend, "kv");
      await c.op("kv/put", { k: "p:1", v: JSON.stringify({ a: [1, 2], s: "x" }) });
      await c.op("kv/put", { k: "p:2", v: "42" });
      await c.op("kv/put", { k: "q:1", v: "true" });
      assert.deepEqual((await c.op("kv/get", { k: "p:1" })).v, { a: [1, 2], s: "x" });
      assert.deepEqual((await c.op("kv/list", { prefix: "p:" })).keys, ["p:1", "p:2"]);
      assert.equal((await c.op("kv/delete", { k: "p:2" })).deleted, true);
      assert.deepEqual((await c.op("kv/list", { prefix: "p:" })).keys, ["p:1"]);
    });

    test("async storage API: put/get", async () => {
      const c = client(backend, "async");
      await c.op("async/put", { k: "obj", v: JSON.stringify({ n: 7 }) });
      assert.deepEqual((await c.op("async/get", { k: "obj" })).v, { n: 7 });
    });

    test("alarm fires once and clears", async () => {
      const c = client(backend, "alarm");
      const { at } = await c.op("alarm/set", { ms: 1500 });
      assert.equal((await c.op("alarm/get")).at, at);
      const r = await waitFor(() => c.op("alarm/fired"), (r) => r.fired.length >= 1, 20_000);
      assert.equal(r.fired.length, 1);
      assert.ok(r.fired[0].at >= at, "fired before scheduled time");
      assert.equal((await c.op("alarm/get")).at, null);
    });

    test("alarm is retried after throwing (retryCount increments)", async () => {
      const c = client(backend, "alarmretry");
      await c.op("alarm/set", { ms: 500, fail: 2 });
      const r = await waitFor(() => c.op("alarm/fired"), (r) => r.fired.length >= 3, 30_000);
      assert.deepEqual(
        r.fired.slice(0, 3).map((f: { retryCount: number }) => f.retryCount),
        [0, 1, 2],
      );
    });

    test("deleteAlarm cancels", async () => {
      const c = client(backend, "alarmdel");
      await c.op("alarm/set", { ms: 2500 });
      assert.equal((await c.op("alarm/delete")).at, null);
      await sleep(4000);
      assert.equal((await c.op("alarm/fired")).fired.length, 0);
    });

    test("WebSocket hibernation API: echo, tags, attachments, binary", async () => {
      const c = client(backend, "ws");
      const a = await c.socket("a");
      const b = await c.socket("b");
      a.ws.send("echo:hello");
      assert.equal(await a.next(), "echo:hello");
      a.ws.send("who");
      const who = JSON.parse(String(await a.next()));
      assert.deepEqual(
        who.map((w: any) => w.tags[0]).sort(),
        ["a", "b"],
      );
      assert.deepEqual(
        who.map((w: any) => w.att).sort((x: any, y: any) => x.tag.localeCompare(y.tag)),
        [
          { tag: "a", joined: true },
          { tag: "b", joined: true },
        ],
      );
      a.ws.send("tag:b");
      assert.equal(await b.next(), "to-b");
      a.ws.send(Buffer.from([1, 2, 3]));
      assert.deepEqual([...((await a.next()) as Buffer)], [1, 2, 3]);
      a.ws.close();
      b.ws.close();
    });

    test("deleteAll wipes data, KV and the alarm", async () => {
      const c = client(backend, "delall");
      await c.op("sql/put", { k: "a", v: "1" });
      await c.op("kv/put", { k: "x", v: "1" });
      await c.op("alarm/set", { ms: 60_000 });
      const r = await c.op("c/deleteAll");
      assert.equal(r.alarm, null);
      assert.equal(r.kv, 0);
      assert.equal((await c.op("sql/count")).n, 0);
    });
  });
}
