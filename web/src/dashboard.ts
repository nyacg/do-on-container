import { mountNav } from "./nav";

type PoolNodeRow = {
  name: string;
  status: string;
  assigned: number;
  load: number;
  lastSeenS: number;
  location?: string;
  region?: string | null;
  stats: Record<string, number> | null;
};

const fmt = (n: number | undefined, d = 0) => (n === undefined ? "–" : n.toFixed(d));

async function refresh() {
  const s = await (await fetch("/api/status")).json();
  const rows = (s.nodes as PoolNodeRow[])
    .filter((n) => n.status !== "stopped" || n.lastSeenS < 600)
    .map((n) => {
      const st = n.stats ?? {};
      const mem = st.memTotalKb ? (st.memUsedKb / st.memTotalKb) * 100 : undefined;
      return `<tr class="${n.status}">
        <td>${n.name}</td><td>${n.location ?? "–"}${n.region ? ` <span>(${n.region})</span>` : ""}</td><td>${n.status}</td>
        <td><div class="meter"><div style="width:${Math.min(100, n.load * 100)}%"></div></div> ${fmt(n.load * 100)}%</td>
        <td>${fmt(st.conns)}</td><td>${fmt(st.cpuCores, 2)}</td><td>${fmt(mem)}%</td>
        <td>${fmt(st.liveObjects)}</td><td>${n.assigned}</td><td>${fmt(st.checkpoints)}</td><td>${n.lastSeenS}s</td></tr>`;
    })
    .join("");
  document.getElementById("nodes")!.innerHTML = rows || `<tr><td colspan="11">no nodes yet — open a demo on the pool backend</td></tr>`;
  document.getElementById("events")!.innerHTML = (s.events as { at: number; kind: string; node: string; detail: string }[])
    .map((e) => `<li><time>${new Date(e.at).toLocaleTimeString()}</time> <b>${e.kind}</b> ${e.node} <span>${e.detail ?? ""}</span></li>`)
    .join("");
  const alarms = s.alarms?.n ? ` · ${s.alarms.n} alarms parked in the registry` : "";
  document.getElementById("summary")!.textContent = `${s.assignments} objects assigned · min ${s.config.minNodes} / max ${s.config.maxNodes} nodes${alarms}`;
}
mountNav();
refresh();
setInterval(refresh, 2000);
