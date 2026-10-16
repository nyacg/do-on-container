import { build } from "esbuild";
await build({
  entryPoints: ["cursors", "editor", "dashboard", "apps", "how", "bench"].map((n) => new URL(`./src/${n}.ts`, import.meta.url).pathname),
  outdir: new URL("./public/js", import.meta.url).pathname,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  logLevel: "info",
});
