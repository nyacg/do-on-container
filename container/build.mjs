// Bundles the in-container router + Durable Object classes into container/dist/app.js and
// renders container/dist/workerd.capnp (with one entry per tenant-sandbox slot).
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

export const TENANT_SLOTS = 32;
await build({
  entryPoints: [new URL("./router.ts", import.meta.url).pathname],
  outfile: new URL("./dist/app.js", import.meta.url).pathname,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2023",
  external: ["cloudflare:*", "node:*"],
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "browser"],
  minify: false,
  define: { __BUILD__: JSON.stringify(new Date().toISOString()) },
  logLevel: "info",
});

const dir = new URL("./", import.meta.url).pathname;
mkdirSync(`${dir}dist`, { recursive: true });
const slots = Array.from({ length: TENANT_SLOTS }, (_, i) => i);
const capnp = readFileSync(`${dir}workerd.capnp`, "utf8")
  // Router → tenant process: each tenant's workerd listens on its slot's unix socket.
  .replace("#SLOT_SERVICES#", slots.map((i) => `    (name = "slot${i}", external = (address = "unix:/run/slots/${i}/http.sock", http = ())),`).join("\n"))
  // Tenant process → router: its only egress, bound into the sandbox as /run/bridge.sock.
  .replace(
    "#SLOT_SOCKETS#",
    slots
      .map((i) => `    (name = "tb${i}", address = "unix:/run/bridges/${i}.sock", http = (), service = (name = "main", entrypoint = "TenantBridge", props = (json = "{\\"slot\\":${i}}"))),`)
      .join("\n"),
  )
  .replace("#SLOT_BINDINGS#", slots.map((i) => `    (name = "SLOT${i}", service = "slot${i}"),`).join("\n"))
  .replace('embed "dist/app.js"', 'embed "app.js"');
writeFileSync(`${dir}dist/workerd.capnp`, capnp);
writeFileSync(`${dir}dist/tenant.capnp`, readFileSync(`${dir}tenant.capnp`, "utf8"));
