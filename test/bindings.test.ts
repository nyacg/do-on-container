/**
 * Bindings parity: the BindingsDemo object (objects/bindings-demo.ts) uses KV, R2, Workers AI,
 * another Worker (fetch + JS RPC) and other Durable Objects of its class. On Cloudflare those
 * are native bindings; in the pool they're proxies through the bridge. Same code, same asserts.
 *
 *   BASE=https://do-pool-v2.do-pool-lab.workers.dev npm run test:bindings
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

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
