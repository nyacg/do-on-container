/**
 * Bindings parity: the BindingsDemo object (objects/bindings-demo.ts) uses KV, R2, Workers AI,
 * another Worker (fetch + JS RPC) and other Durable Objects of its class. On Cloudflare those
 * are native bindings; in the pool they're proxies through the bridge. Same code, same asserts.
 *
 *   BASE=https://do-pool-v2.do-pool-lab.workers.dev npm run test:bindings
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

const BASE = process.env.BASE ?? "https://do-pool-v2.do-pool-lab.workers.dev";
const BACKENDS = (process.env.BACKENDS ?? "do,pool").split(",");
const RUN = Date.now().toString(36);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(backend: string, name: string, op: string, qs = "") {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/${backend}/bind/${RUN}-${name}/${op}${qs ? "?" + qs : ""}`).catch(() => null);
    const text = res ? await res.text() : "";
    if ((!res || (res.status >= 500 && !text.startsWith("{"))) && attempt < 6) {
      await sleep(2000); // node starting
      continue;
    }
    assert.ok(text.startsWith("{"), `${op}: HTTP ${res?.status} ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
    assert.equal(body.error, undefined, `${op}: ${body.error}`);
    return body;
  }
}

for (const backend of BACKENDS) {
  describe(`bindings on ${backend}`, { concurrency: true }, () => {
    test("wrangler var", async () => {
      const r = await get(backend, "v", "var");
      assert.equal(r.greeting, "hello from a wrangler var");
      assert.equal(r.pooled, backend === "pool");
    });

    test("KV: put/get/json/metadata/list/delete", async () => {
      const r = await get(backend, "kv", "kv", "v=abc");
      assert.deepEqual(r, {
        text: JSON.stringify({ v: "abc" }),
        json: { v: "abc" },
        metadata: { by: `${RUN}-kv` },
        listed: [`demo/${RUN}-kv`],
        gone: null,
      });
    });

    test("R2: put/head/get/list/delete with metadata", async () => {
      const r = await get(backend, "r2", "r2", "v=hello-r2");
      assert.deepEqual(r, {
        size: 8,
        etagMatches: true,
        uploadedIsDate: true,
        contentType: "text/plain",
        customMetadata: { by: `${RUN}-r2` },
        text: "hello-r2",
        listed: [`demo/${RUN}-r2.txt`],
        gone: null,
      });
    });

    test("Workers AI: text generation", async () => {
      const r = await get(backend, "ai", "ai", "q=" + encodeURIComponent("Reply with one word: hello"));
      assert.equal(typeof r.response, "string");
      assert.ok(r.response.length > 0);
    });

    test("another Worker: fetch + JS RPC (Date, bytes)", async () => {
      const r = await get(backend, "svc", "svc");
      assert.deepEqual(r, {
        fetched: { method: "POST", path: "/hello", body: `from ${RUN}-svc`, from: "do-pool-v2-echo" },
        status: 200,
        greet: `hello, ${RUN}-svc, from another Worker`,
        sum: 6,
        shape: { when: "1970-01-01T00:00:00.000Z", bytes: [1, 2, 3], nested: { ok: true } },
      });
    });

    test("another Durable Object: RPC + fetch, state lands on the peer", async () => {
      const r = await get(backend, "a", "do", `to=${RUN}-b&msg=yo`);
      assert.equal(r.rpc.me, `${RUN}-b`);
      assert.equal(r.rpc.pooled, backend === "pool");
      assert.deepEqual([r.rpc.from, r.rpc.msg, r.rpc.count, r.rpc.at], [`${RUN}-a`, "yo", 1, true]);
      assert.equal(r.viaId, 2);
      assert.deepEqual(r.fetched, { me: `${RUN}-b`, via: "fetch", method: "POST", body: `fetch from ${RUN}-a` });
      // The peer is an ordinary object at its own URL, with the pings in its own storage.
      assert.equal((await get(backend, "b", "count")).count, 2);
    });
  });
}

/** The AI rooms example (objects/ai-room.ts + objects/lobby.ts, web/public/rooms.html). */
function join(backend: string, room: string, name: string) {
  return new Promise<{ ws: WebSocket; next: (pred: (m: any) => boolean) => Promise<any> }>((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/${backend}/room/${room}/ws?name=${name}`, { perMessageDeflate: false });
    const messages: any[] = [];
    const waiters: [(m: any) => boolean, (m: any) => void][] = [];
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      messages.push(m);
      for (const w of [...waiters]) if (w[0](m)) (waiters.splice(waiters.indexOf(w), 1), w[1](m));
    });
    const next = (pred: (m: any) => boolean) =>
      new Promise<any>((res, rej) => {
        const i = messages.findIndex(pred);
        if (i >= 0) return res(messages.splice(i, 1)[0]);
        const t = setTimeout(() => rej(new Error("timed out waiting for a room message")), 30_000);
        waiters.push([pred, (m) => (clearTimeout(t), messages.splice(messages.indexOf(m), 1), res(m))]);
      });
    ws.on("open", () => resolve({ ws, next }));
    ws.on("error", reject);
    ws.on("unexpected-response", (_q, r) => reject(new Error(`ws HTTP ${r.statusCode}`)));
  });
}

for (const backend of BACKENDS) {
  describe(`AI room example on ${backend}`, () => {
    const room = `t-${RUN}-${backend}`;
    const calls = (m: any) => (m.trace ?? []).map((t: any) => t.call);

    // Sockets left open by a failed assertion would keep the test runner alive.
    const open: WebSocket[] = [];
    const joinT = async (r: string, n: string) => {
      const c = await join(backend, r, n);
      open.push(c.ws);
      return c;
    };
    afterEach(() => {
      for (const ws of open.splice(0)) ws.terminate();
    });

    test("moderation (service RPC), presence + lobby (DO RPC)", async () => {
      await get(backend, "warm", "var"); // node up
      const alice = await joinT(room, "alice");
      assert.equal((await alice.next((m) => m.type === "history")).messages.length, 0);
      alice.ws.send(JSON.stringify({ text: "what a darn  good   demo" }));
      const m = await alice.next((m) => m.type === "msg");
      assert.equal(m.text, "what a d*** good demo");
      assert.deepEqual(calls(m), ["MODERATOR.moderate()"]);
      const bob = await joinT(room, "bob");
      const p = await alice.next((m) => m.type === "presence" && m.users.length === 2);
      assert.deepEqual(p.users.sort(), ["alice", "bob"]);
      assert.deepEqual(calls(p), ["LOBBY.update()"]);
      const lobby = await (await fetch(`${BASE}/${backend}/lobby/tests`)).json(); // t-… rooms report here
      assert.equal(lobby.pooled, backend === "pool");
      assert.equal(lobby.rooms.find((r: any) => r.name === room)?.users, 2);
      // Both leave at once: their "left" reports race each other (and any in-flight "posted" report).
      bob.ws.close();
      alice.ws.close();
      let users = -1;
      for (let i = 0; i < 20 && users !== 0; i++) {
        await sleep(500);
        users = (await (await fetch(`${BASE}/${backend}/lobby/tests`)).json()).rooms.find((r: any) => r.name === room)?.users;
      }
      assert.equal(users, 0, "room empty in the lobby once everyone left");
    });

    test("@ai: Workers AI answer, then the same question from KV", async () => {
      const alice = await joinT(`${room}-ai`, "alice");
      await alice.next((m) => m.type === "history");
      // KV is shared by both backends, so the question is unique per backend and run.
      const question = `@ai reply with just the word pong ${RUN} ${backend}`;
      alice.ws.send(JSON.stringify({ text: question }));
      const a = await alice.next((m) => m.type === "msg" && m.kind === "ai");
      assert.ok(a.text.length > 0);
      assert.deepEqual(calls(a), ["KV.get()", "LOBBY.takeAiBudget()", "AI.run()", "KV.put()"]);
      assert.equal(a.trace[0].note, "miss");
      alice.ws.send(JSON.stringify({ text: question }));
      const b = await alice.next((m) => m.type === "msg" && m.kind === "ai");
      assert.deepEqual(calls(b), ["KV.get()"]);
      assert.deepEqual([b.trace[0].note, b.text], ["hit", a.text]);
      alice.ws.close();
    });

    test("attachments in R2: upload, download as attachment", async () => {
      const body = `hello from ${backend} ${RUN}`;
      const res = await fetch(`${BASE}/${backend}/room/${room}-files/upload?name=alice&filename=note.txt`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body,
      });
      const m = await res.json();
      assert.equal(m.kind, "file");
      assert.deepEqual([m.file.name, m.file.size, m.file.type], ["note.txt", body.length, "text/plain"]);
      assert.deepEqual(calls(m), ["FILES.put()"]);
      const file = await fetch(`${BASE}/${backend}/room/${room}-files/files/${m.file.id}`);
      assert.equal(await file.text(), body);
      // Not an image: served as a download, never rendered on the site's origin.
      assert.equal(file.headers.get("content-type"), "application/octet-stream");
      assert.match(file.headers.get("content-disposition") ?? "", /attachment; filename="note.txt"/);
    });
  });
}
