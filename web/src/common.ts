export type Backend = "do" | "pool";

export function params() {
  const q = new URLSearchParams(location.search);
  const backend = (q.get("backend") === "do" ? "do" : "pool") as Backend;
  const room = q.get("room") || "lobby";
  return { backend, room };
}

export function wsOrigin() {
  return (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
}

/** Renders the backend switcher + live stats strip into #bar. */
export function bar(backend: Backend, room: string, page: string) {
  const el = document.getElementById("bar")!;
  const other: Backend = backend === "do" ? "pool" : "do";
  el.innerHTML = `
    <a href="/">do-pool</a>
    <span class="pill ${backend}">${backend === "do" ? "real Durable Object" : "pooled DO in a Container"}</span>
    <span>room <b>${room}</b></span>
    <span id="node"></span>
    <span id="rtt"></span>
    <span id="conn">connecting…</span>
    <a href="/${page}?backend=${other}&room=${encodeURIComponent(room)}">switch to ${other === "do" ? "real DO" : "pool"} →</a>`;
  if (backend === "pool") {
    fetch(`/pool/${page.replace(".html", "") === "editor" ? "doc" : "cursors"}/${encodeURIComponent(room)}/info`).then((r) => {
      const n = r.headers.get("x-pool-node");
      if (n) document.getElementById("node")!.innerHTML = `node <b>${n}</b>`;
    });
  }
}

export class RttMeter {
  private samples: number[] = [];
  add(ms: number) {
    this.samples.push(ms);
    if (this.samples.length > 50) this.samples.shift();
    const s = [...this.samples].sort((a, b) => a - b);
    const p = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(0);
    document.getElementById("rtt")!.innerHTML = `rtt p50 <b>${p(0.5)}ms</b> p99 <b>${p(0.99)}ms</b>`;
  }
}

export function setConn(text: string) {
  document.getElementById("conn")!.textContent = text;
}
