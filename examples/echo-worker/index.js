// A separate Worker that pooled (and real) Durable Objects bind to as a service:
// HTTP via `env.ECHO.fetch(request)` and JS RPC via `env.ECHO.greet("you")`.
import { WorkerEntrypoint } from "cloudflare:workers";

export default class Echo extends WorkerEntrypoint {
  async fetch(req) {
    return Response.json({
      method: req.method,
      path: new URL(req.url).pathname,
      body: req.method === "GET" ? null : await req.text(),
      from: "do-pool-v2-echo",
    });
  }
  greet(name) {
    return `hello, ${name}, from another Worker`;
  }
  sum(...xs) {
    return xs.reduce((a, b) => a + b, 0);
  }
  shape() {
    return { when: new Date(0), bytes: new Uint8Array([1, 2, 3]), nested: { ok: true } };
  }
}
