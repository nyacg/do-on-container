/** Benchmarks page: recovery-time range chart (log scale) with hover details. */
import { mountNav } from "./nav";

type Row = { label: string; lo: number; hi: number; detail: string };
const RECOVERY: Row[] = [
  { label: "Object moved (live)", lo: 0.6, hi: 1.2, detail: "Client reconnect gap during a live migration under continuous writes; 0 acknowledged writes lost." },
  { label: "Node wakes from sleep", lo: 1.0, hi: 1.5, detail: "Snapshot restore → ready, woken by a request or a due alarm. Every object's SQLite is already on disk." },
  { label: "Brand-new node", lo: 0.8, hi: 6.9, detail: "Cold start of a new container under the durable_object policy (image already cached → slower when not)." },
  { label: "Node stopped (SIGTERM)", lo: 4.8, hi: 4.8, detail: "Graceful stop: drain, then hydrate on another node. 10/10 writes survived, including unflushed ones." },
  { label: "Node killed (SIGKILL)", lo: 7.2, hi: 7.2, detail: "Host failure: the object comes back from its last checkpoint. Writes from the last ≤30 s are lost." },
  { label: "Control-plane deploy", lo: 32, hi: 32, detail: "Worst single write stall while every node restarted on the new version. 5,637/5,637 writes kept." },
];

function recoveryChart(el: HTMLElement) {
  const W = 980, rowH = 46, top = 16, left = 210, right = 120, H = top + RECOVERY.length * rowH + 40;
  const lo = Math.log10(0.4), hi = Math.log10(50);
  const X = (s: number) => left + ((Math.log10(s) - lo) / (hi - lo)) * (W - left - right);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Recovery time by event, log scale">`;
  svg += `<g class="grid">`;
  for (const t of [0.5, 1, 2, 5, 10, 20, 50]) {
    svg += `<line x1="${X(t)}" x2="${X(t)}" y1="${top - 6}" y2="${H - 30}"/><text x="${X(t)}" y="${H - 12}" text-anchor="middle">${t} s</text>`;
  }
  svg += `</g>`;
  RECOVERY.forEach((r, i) => {
    const y = top + i * rowH + 10;
    const x0 = X(r.lo), x1 = Math.max(X(r.hi), x0 + 8);
    svg += `<text class="lbl" x="${left - 14}" y="${y + 15}" text-anchor="end">${r.label}</text>`;
    svg += `<rect class="bar" data-i="${i}" x="${x0}" y="${y}" width="${x1 - x0}" height="20" rx="4"/>`;
    svg += `<text x="${x1 + 8}" y="${y + 15}">${r.lo === r.hi ? `${r.lo} s` : `${r.lo}–${r.hi} s`}</text>`;
    svg += `<rect data-i="${i}" x="0" y="${y - 12}" width="${W}" height="${rowH}" fill="transparent"/>`;
  });
  svg += `</svg>`;
  el.className = "chart";
  el.innerHTML = svg + `<div class="tip"></div>`;
  const tip = el.querySelector<HTMLElement>(".tip")!;
  el.querySelectorAll<SVGRectElement>("[data-i]").forEach((r) => {
    r.addEventListener("pointermove", (e) => {
      const row = RECOVERY[Number(r.dataset.i)];
      el.querySelectorAll(".bar").forEach((b) => b.classList.toggle("hot", (b as SVGElement).dataset.i === r.dataset.i));
      tip.innerHTML = `<b>${row.label}</b><br>${row.detail}`;
      const box = el.getBoundingClientRect();
      tip.style.display = "block";
      tip.style.left = `${Math.min(e.clientX - box.left + 14, box.width - 290)}px`;
      tip.style.top = `${e.clientY - box.top + 12}px`;
    });
    r.addEventListener("pointerleave", () => {
      tip.style.display = "none";
      el.querySelectorAll(".bar").forEach((b) => b.classList.remove("hot"));
    });
  });
}

mountNav();
recoveryChart(document.getElementById("recovery")!);
