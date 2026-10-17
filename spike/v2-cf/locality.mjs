const B = "https://do-pool-v2-spike.do-pool-lab.workers.dev";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realFetch = globalThis.fetch;
globalThis.fetch = async (...a) => { for (let i = 0; ; i++) { try { return await realFetch(...a); } catch (e) { if (i >= 3) throw e; await sleep(500); } } };
const results = [];
for (const hint of ["wnam", "enam", "weur", "apac"]) {
  const name = `loc-${hint}-${Date.now().toString(36)}`;
  const t0 = Date.now();
  const r = await (await fetch(`${B}/n/${name}/start?hint=${hint}&instance=standard-1`)).json();
  results.push({ hint, doColo: r.doColo, container: r.stats?.cf?.CLOUDFLARE_LOCATION, readyMs: r.readyMs, clientMs: Date.now() - t0, error: r.error });
  await fetch(`${B}/n/${name}/stop?hint=${hint}&kill=1`);
}
console.log(JSON.stringify(results, null, 1));
// snapshot consistency under concurrent writes
const name = "consist-" + Date.now().toString(36);
await fetch(`${B}/n/${name}/start?hint=wnam&instance=standard-1`);
let stop = false, writes = 0, errs = 0;
const writer = (async () => { while (!stop) { const r = await fetch(`${B}/n/${name}/p/r/w${writes % 20}/touch?hint=wnam`); r.ok ? writes++ : errs++; } })();
await sleep(2000);
const snap = await (await fetch(`${B}/n/${name}/snapshot?hint=wnam`)).json();
await sleep(1000); stop = true; await writer;
await fetch(`${B}/n/${name}/stop?hint=wnam`);
const restore = await (await fetch(`${B}/n/${name}/start?hint=wnam&from=container`)).json();
let ok = 0, bad = [];
for (let i = 0; i < 20; i++) { const r = await fetch(`${B}/n/${name}/p/r/w${i}/touch?hint=wnam`); const t = await r.text(); r.ok ? ok++ : bad.push(t.slice(0, 120)); }
console.log(JSON.stringify({ consistency: { writesDuring: writes, errs, snapshotMs: snap.ms, size: snap.snapshot?.size, restoreReadyMs: restore.readyMs, dbsOpenAfterRestore: ok, bad: bad.slice(0, 2) } }));
await fetch(`${B}/n/${name}/stop?hint=wnam&kill=1`);
