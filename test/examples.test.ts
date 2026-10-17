/**
 * The example dynamic apps (examples/apps/*.js) on every backend that can host a facet:
 * real Durable Object (Dynamic Workers), pooled facet, and sandboxed tenant process.
 *
 *   BASE=https://do-pool-v2.do-pool-lab.workers.dev npm run test:examples
 * (publish them first: ADMIN_TOKEN=... npm run publish:examples)
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

const BASE = process.env.BASE ?? "https://do-pool-v2.do-pool-lab.workers.dev";
const BACKENDS = (process.env.BACKENDS ?? "do/app,pool/app,pool/sapp").split(",");
const RUN = Date.now().toString(36);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function at(backend: string, app: string, name: string) {
  const base = `${BASE}/${backend}/${app}:${RUN}-${name}`;
  return {
    async call(method: string, path: string, body?: string) {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(base + path, { method, body });
          const text = await res.text();
          if (res.status >= 500 && attempt < 5) {
            await sleep(1500); // node starting / moving
            continue;
          }
          return { status: res.status, json: text.startsWith("{") ? JSON.parse(text) : text };
        } catch (e) {
          if (attempt >= 5) throw e;
          await sleep(1000);
        }
      }
    },
    socket(path: string): Promise<{ ws: WebSocket; messages: any[]; next: (pred?: (m: any) => boolean) => Promise<any> }> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(base.replace(/^http/, "ws") + path, { perMessageDeflate: false });
        const messages: any[] = [];
        const waiters: [(m: any) => boolean, (m: any) => void][] = [];
        ws.on("message", (d) => {
          const m = JSON.parse(String(d));
          messages.push(m);
          for (const w of [...waiters]) if (w[0](m)) (waiters.splice(waiters.indexOf(w), 1), w[1](m));
        });
        const next = (pred: (m: any) => boolean = () => true) =>
          new Promise<any>((res, rej) => {
            const hit = messages.find(pred);
            if (hit) return res(hit);
            const t = setTimeout(() => rej(new Error("timed out waiting for a websocket message")), 15_000);
            waiters.push([pred, (m) => (clearTimeout(t), res(m))]);
          });
        ws.on("open", () => resolve({ ws, messages, next }));
        ws.on("error", reject);
        ws.on("unexpected-response", (_q, r) => reject(new Error(`ws HTTP ${r.statusCode}`)));
      });
    },
  };
}

for (const backend of BACKENDS) {
  describe(`examples on ${backend}`, { concurrency: true }, () => {
    test("counter: SQL + alarm reset", async () => {
      const c = at(backend, "counter", "c");
      assert.equal((await c.call("GET", "/")).json.count, 0);
      await c.call("POST", "/inc");
      assert.equal((await c.call("POST", "/inc")).json.count, 2);
      const r = await c.call("POST", "/reset-in?ms=1500");
      assert.ok(r.json.resetAt > Date.now() - 5000);
      await sleep(5000);
      assert.equal((await c.call("GET", "/")).json.count, 0);
    });

    test("notes: KV REST API", async () => {
      const n = at(backend, "notes", "n");
      assert.equal((await n.call("PUT", "/notes/a", "first")).json.text, "first");
      await n.call("PUT", "/notes/b", "second");
      assert.deepEqual((await n.call("GET", "/notes")).json.notes.map((x: any) => x.id), ["a", "b"]);
      assert.equal((await n.call("DELETE", "/notes/a")).json.deleted, true);
      assert.equal((await n.call("GET", "/notes/a")).status, 404);
    });

    test("chat: broadcast + history over hibernatable WebSockets", async () => {
      const c = at(backend, "chat", "room");
      const alice = await c.socket("/ws?name=alice");
      const bob = await c.socket("/ws?name=bob");
      await alice.next((m) => m.type === "history");
      alice.ws.send("hi bob");
      const got = await bob.next((m) => m.type === "msg");
      assert.deepEqual([got.name, got.text], ["alice", "hi bob"]);
      const carol = await c.socket("/ws?name=carol");
      const hist = await carol.next((m) => m.type === "history");
      assert.equal(hist.messages.at(-1).text, "hi bob");
      assert.equal((await c.call("GET", "/history")).json.messages.length, 1);
      for (const s of [alice, bob, carol]) s.ws.close();
    });

    test("reminders: many jobs on one alarm, pushed over a socket", async () => {
      const r = at(backend, "reminders", "r");
      const watch = await r.socket("/ws");
      await r.call("POST", "/remind?in=1500&text=first");
      await r.call("POST", "/remind?in=3000&text=second");
      assert.equal((await r.call("GET", "/")).json.pending.length, 2);
      const a = await watch.next((m) => m.type === "due" && m.text === "first");
      const b = await watch.next((m) => m.type === "due" && m.text === "second");
      assert.ok(a.firedAt >= a.due && b.firedAt >= b.due);
      const list = (await r.call("GET", "/")).json;
      assert.deepEqual([list.pending.length, list.done.length], [0, 2]);
      watch.ws.close();
    });
  });
}
