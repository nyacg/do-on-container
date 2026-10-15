/**
 * Monthly cost model: real Durable Objects vs do-pool, using list prices (Workers Paid,
 * ignoring free allowances, which favour neither side much at scale) and capacities
 * measured in bench/results.
 *
 *   npx tsx bench/cost-model.ts            # markdown tables
 *   npx tsx bench/cost-model.ts --csv      # duty-cycle curve for charts
 */
const MONTH_S = 30 * 24 * 3600;

const DO = {
  gbS: 12.5 / 1e6, // $ per GB-second, billed as 128 MB per awake object
  req: 0.15 / 1e6, // $ per request; incoming WebSocket messages count 1/20
  rowWrite: 1 / 1e6,
};
const CT = { memGiBs: 0.0000025, vcpuS: 0.00002, diskGBs: 0.00000007 };
const R2 = { classA: 4.5 / 1e6 };

/** Measured: one `basic` node (1/4 vCPU, 1 GiB, 4 GB) with 1000 awake 1 Hz tickers billed ~0.2 vCPU. */
const MEASURED = {
  tickersPerBasicNode: 1000,
  basicBilledVcpuAt1000Tickers: 0.2,
  basicIdleVcpu: 0.01,
  framesPerVcpuSecond: 11_000, // naive broadcast, standard-2, see FINDINGS.md
};

const BASIC = { vcpu: 0.25, memGiB: 1, diskGB: 4 };

function realDO(awakeObjects: number, inboundMsgsPerSec = 0) {
  const duration = awakeObjects * 0.125 * MONTH_S * DO.gbS;
  const msgs = (inboundMsgsPerSec * MONTH_S * DO.req) / 20;
  return duration + msgs;
}

function poolNode(billedVcpu: number) {
  const mem = BASIC.memGiB * MONTH_S * CT.memGiBs;
  const disk = BASIC.diskGB * MONTH_S * CT.diskGBs;
  const cpu = billedVcpu * MONTH_S * CT.vcpuS;
  // Segment checkpoints: 2 R2 PUTs per 30 s flush; stats push every 5 s → Placement requests.
  const r2 = 2 * (MONTH_S / 30) * R2.classA;
  const placementReqs = (MONTH_S / 5) * DO.req;
  return { mem, disk, cpu, r2, placementReqs, total: mem + disk + cpu + r2 + placementReqs };
}

/** Singleton Placement DO: awake essentially all the time (stats every 5 s). */
const PLACEMENT_FIXED = 0.125 * MONTH_S * DO.gbS;

function pool(awakeObjects: number, opts: { minNodes?: number } = {}) {
  const nodes = Math.max(opts.minNodes ?? 1, Math.ceil(awakeObjects / MEASURED.tickersPerBasicNode));
  const perObjectVcpu = MEASURED.basicBilledVcpuAt1000Tickers / MEASURED.tickersPerBasicNode;
  const vcpuTotal = Math.max(nodes * MEASURED.basicIdleVcpu, awakeObjects * perObjectVcpu);
  const n = poolNode(vcpuTotal / nodes);
  return { nodes, total: nodes * n.total + PLACEMENT_FIXED, perNode: n };
}

const $ = (x: number) => (x >= 100 ? `$${Math.round(x).toLocaleString()}` : `$${x.toFixed(2)}`);

if (process.argv.includes("--csv")) {
  console.log("awake_fraction,real_do_usd,pool_usd");
  for (const f of [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]) {
    console.log(`${f},${realDO(1000 * f).toFixed(2)},${pool(1000 * f).total.toFixed(2)}`);
  }
  process.exit(0);
}

const node = poolNode(MEASURED.basicBilledVcpuAt1000Tickers);
console.log(`## One pool node (basic, 1000 awake objects), per month

| memory | disk | CPU (${MEASURED.basicBilledVcpuAt1000Tickers} vCPU billed) | R2 segments | stats → Placement | **total** |
|---|---|---|---|---|---|
| ${$(node.mem)} | ${$(node.disk)} | ${$(node.cpu)} | ${$(node.r2)} | ${$(node.placementReqs)} | **${$(node.total)}** |

Plus the singleton Placement DO (≈ ${$(PLACEMENT_FIXED)}/month). The fronting PoolNode DO is
not billed wall-clock for raw-passthrough sockets (measured: 92 GB-s over 18 minutes for 5 nodes).
`);

console.log(`## Always-awake objects (1 Hz loop, one client each)

| awake objects | real DOs | do-pool (nodes) | do-pool, 2-node floor | ratio |
|---|---|---|---|---|`);
for (const n of [10, 100, 1_000, 10_000, 100_000]) {
  const r = realDO(n), p = pool(n), p2 = pool(n, { minNodes: 2 });
  console.log(`| ${n.toLocaleString()} | ${$(r)} | ${$(p.total)} (${p.nodes}) | ${$(p2.total)} | ${(r / p.total).toFixed(0)}× |`);
}

console.log(`
## Duty cycle: 1000 objects that are awake some fraction of the time (hibernating otherwise)

| awake | real DOs | do-pool | winner |
|---|---|---|---|`);
for (const f of [0.001, 0.005, 0.01, 0.05, 0.25, 1]) {
  const r = realDO(1000 * f), p = pool(1000 * f).total;
  console.log(`| ${(f * 100).toFixed(1)}% (${((f * MONTH_S) / 3600).toFixed(1)} h/mo) | ${$(r)} | ${$(p)} | ${r < p ? "real DO" : `pool ${(r / p).toFixed(0)}×`} |`);
}

// Chatty broadcast: 50 rooms × 10 users × 5 msg/s, 20 Hz batched → frames out ≈ users × 20/s.
const rooms = 50, users = 10, rate = 5;
const inbound = rooms * users * rate;
const outbound = rooms * users * 20;
const vcpu = (inbound + outbound) / MEASURED.framesPerVcpuSecond;
const chattyPool = Math.ceil(vcpu / BASIC.vcpu / 0.7) * poolNode(BASIC.vcpu * 0.7).total + PLACEMENT_FIXED;
console.log(`
## Chatty rooms (${rooms} rooms × ${users} users × ${rate} msg/s in, 20 Hz batched out)

| | real DOs | do-pool |
|---|---|---|
| monthly | ${$(realDO(rooms, inbound))} | ${$(chattyPool)} (≈${vcpu.toFixed(2)} vCPU of frames) |

Outgoing WebSocket frames are free on Durable Objects; in a container every frame is CPU.`);
