// Phase 0 sequence against do-pool-v2-spike. node run.mjs <nodeName> <hint>
const B = "https://do-pool-v2-spike.do-pool-lab.workers.dev";
const [name = "s4", hint = "wnam"] = process.argv.slice(2);
const q = (op, params = "") => `${B}/n/${name}/${op}?hint=${hint}&instance=standard-1${params}`;
async function call(op, params, label = op) {
  const t0 = Date.now();
  const r = await fetch(q(op, params));
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = txt.slice(0, 200); }
  const out = { step: label, status: r.status, clientMs: Date.now() - t0 };
  for (const k of ["readyMs", "ms", "error", "running", "doColo", "already"]) if (body?.[k] !== undefined) out[k] = body[k];
  if (body?.stats?.cf) out.loc = body.stats.cf.CLOUDFLARE_LOCATION;
  if (body?.snapshot) out.snapshot = { size: body.snapshot.size, id: String(body.snapshot.id).slice(0, 16) };
  if (body?.n !== undefined) out.n = body.n;
  console.log(JSON.stringify(out));
  return body;
}
const touch = async (label) => {
  const r = await fetch(`${B}/n/${name}/p/r/d5/touch?hint=${hint}`);
  console.log(JSON.stringify({ step: label, status: r.status, body: (await r.text()).slice(0, 80) }));
};
await call("start", "", "start-1");
await fetch(`${B}/n/${name}/p/bulk?from=0&n=500&hint=${hint}`).then((r) => r.text()).then((t) => console.log("bulk", t));
await touch("touch-before-snapshot");
await call("snapshot", "", "snapshot-container");
await call("snapdir", "&dir=/data", "snapshot-dir");
await call("stop", "", "stop-sigterm");
await call("start", "&from=container", "start-from-container-snapshot");
await touch("touch-after-container-restore (expect n=2)");
await call("stop", "", "stop");
await call("start", "", "start-fresh-warm-image");
await touch("touch-after-fresh (expect n=1)");
await call("stop", "", "stop");
await call("start", "&from=dir", "start-with-dir-snapshot");
await touch("touch-after-dir-restore (expect n=2 or 3)");
