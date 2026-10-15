// polls each instance type until /__cpubench works, prints cold-start & cpubench
const B = "https://do-pool-spike.do-pool-lab.workers.dev";
const types = process.argv.slice(2).length ? process.argv.slice(2) : ["lite", "basic", "s1", "s2", "s4"];
await Promise.all(types.map(async (t) => {
  const deadline = Date.now() + 9 * 60_000;
  while (Date.now() < deadline) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${B}/pool/__cpubench?type=${t}&node=bench`);
      const txt = await r.text();
      if (r.ok && txt.includes('"ms"')) {
        const t1 = Date.now();
        const st = await (await fetch(`${B}/pool/__stats?type=${t}&node=bench`)).json();
        console.log(t, { firstReqMs: t1 - t0, cpubench: JSON.parse(txt).ms, memTotalMB: st.mem?.totalKb >> 10, nproc: st.nproc, v: st.v });
        return;
      }
      if (!txt.includes("router ok")) process.stdout.write(`${t}:${r.status} `);
    } catch (e) { process.stdout.write(`${t}:err `); }
    await new Promise(r => setTimeout(r, 10000));
  }
  console.log(t, "timeout");
}));
