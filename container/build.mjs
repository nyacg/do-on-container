// Bundles the in-container router + Durable Object classes into container/dist/app.js
import { build } from "esbuild";
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
