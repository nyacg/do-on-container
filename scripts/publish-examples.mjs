// Publishes examples/apps/*.js as dynamic apps (app id = file name).
//   BASE=https://do-pool-v2.do-pool-lab.workers.dev ADMIN_TOKEN=... node scripts/publish-examples.mjs
import { readdirSync, readFileSync } from "node:fs";

const base = process.env.BASE ?? "https://do-pool-v2.do-pool-lab.workers.dev";
const dir = new URL("../examples/apps/", import.meta.url);
for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
  const app = file.replace(/\.js$/, "");
  const res = await fetch(`${base}/api/code?app=${app}`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
    body: readFileSync(new URL(file, dir), "utf8"),
  });
  console.log(app, res.status, await res.text());
}
