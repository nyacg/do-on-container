/** Interactive walkthrough: animated diagrams of real Durable Objects vs do-pool. */
import { mountNav } from "./nav";

// ---------------------------------------------------------------- diagram vocabulary
const box = (x: number, y: number, w: number, h: number, label = "", sub = "", cls = "", attrs = "") =>
  `<g class="box ${cls}" ${attrs}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/>` +
  (label ? `<text x="${x + w / 2}" y="${y + (sub ? h / 2 - 3 : h / 2 + 5)}" text-anchor="middle">${label}</text>` : "") +
  (sub ? `<text class="sub" x="${x + w / 2}" y="${y + h / 2 + 15}" text-anchor="middle">${sub}</text>` : "") +
  `</g>`;
const edge = (id: string, d: string, cls = "", attrs = "") =>
  `<path id="${id}" d="${d}" class="edge ${cls}" marker-end="url(#arr)" ${attrs}/>`;
const pkt = (path: string, dur: number, begin = 0, cls = "") =>
  `<circle r="7" class="pkt ${cls}"><animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite"><mpath href="#${path}"/></animateMotion></circle>`;
const text = (x: number, y: number, t: string, cls = "", anchor = "start", attrs = "") =>
  `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}" ${attrs}>${t}</text>`;
const badge = (x: number, y: number, t: string, attrs = "") =>
  `<g ${attrs}><rect class="badge" x="${x - 14}" y="${y - 14}" width="28" height="28" rx="14"/><text class="badge-t" x="${x}" y="${y + 4}" text-anchor="middle">${t}</text></g>`;
const objects = (x: number, y: number, cols: number, rows: number, size = 12, gap = 6, dirtyEvery = 0) => {
  let s = "";
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      s += `<rect class="obj ${dirtyEvery && i % dirtyEvery === 0 ? "dirty" : ""}" x="${x + c * (size + gap)}" y="${y + r * (size + gap)}" width="${size}" height="${size}" rx="3"/>`;
    }
  return s;
};
const meter = (x: number, y: number, w: number, cls = "") =>
  `<rect class="meter-bg" x="${x}" y="${y}" width="${w}" height="7" rx="3.5"/><rect class="meter grow ${cls}" x="${x}" y="${y}" height="7" rx="3.5" style="--w:${w}px"/>`;
const DEFS = `<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#9c998f"/></marker></defs>`;

interface Step {
  kicker: string;
  title: string;
  body: string;
  fig: () => string;
  /** Captions for the auto-playing sequence (elements with data-seq="1..n"). */
  seq?: string[];
  html?: () => string;
}

// ---------------------------------------------------------------- steps
const STEPS: Step[] = [
  {
    kicker: "1 · The idea",
    title: "Two ways to host the same Durable Object",
    body: `<p>A <b>Durable Object</b> is a single-threaded object with its own SQLite database, addressed by name.</p>
      <ul><li><b>On Cloudflare</b>, every awake object is billed as if it used <b>128 MB for every second it's awake</b>,
      even when idle. That's $4.05/month for one that never sleeps.</li>
      <li><b>In do-pool</b>, the same class runs inside <b>workerd</b> (Cloudflare's open-source runtime) in a container.
      Thousands of objects share one process at ~0.2 MB each. You pay for the container's memory and the CPU it actually uses.</li></ul>
      <p>For objects that are awake but mostly idle (game loops, presence, agents waiting on an LLM) that's <b>~180× cheaper</b>.</p>`,
    fig: () => {
      let left = text(40, 44, "Cloudflare Durable Objects", "ttl");
      for (let i = 0; i < 6; i++) {
        const x = 40 + (i % 2) * 210, y = 66 + Math.floor(i / 2) * 104;
        left += box(x, y, 190, 72, "Durable Object", "128 MB billed while awake", "do") + meter(x + 12, y + 80, 166);
      }
      left += text(40, 400, "6 objects × 128 MB × every awake second", "sub");
      let right = text(530, 44, "do-pool", "ttl");
      right += `<g class="box vm"><rect x="530" y="66" width="430" height="300" rx="14"/></g>`;
      right += text(548, 92, "Container · 1 vCPU · 2 GiB · one bill", "sub");
      right += `<g class="box pool"><rect x="548" y="104" width="394" height="236" rx="12"/></g>`;
      right += text(564, 128, "workerd · 1,000s of objects", "", "start");
      right += objects(566, 144, 19, 9, 12, 7);
      right += meter(548, 380, 412, "pool");
      right += text(530, 410, "provisioned memory + CPU actually used", "sub");
      const totals =
        `<g transform="translate(40,450)">${box(0, 0, 420, 56, "1,000 awake objects: $4,050 / month", "", "do")}</g>` +
        `<g transform="translate(530,450)">${box(0, 0, 430, 56, "1,000 awake objects: ≈ $22 / month", "", "pool")}</g>`;
      return left + right + totals;
    },
  },
  {
    kicker: "2 · Requests",
    title: "A request to a real Durable Object",
    body: `<p>Your Worker runs at the edge closest to the user. It looks the object up by name and forwards the request
      to the <b>one place in the world</b> where that object lives.</p>
      <p>The object reads and writes its SQLite database. Cloudflare <b>replicates every write</b> before it confirms the
      write to anyone, so an acknowledged write is never lost.</p>`,
    fig: () =>
      box(30, 220, 150, 80, "Browser", "WebSocket / HTTP") +
      box(250, 220, 170, 80, "Cloudflare edge", "your Worker") +
      box(500, 195, 210, 130, "Durable Object", "one instance · one thread", "do") +
      box(790, 120, 180, 62, "SQLite replica", "", "store") +
      box(790, 229, 180, 62, "SQLite replica", "", "store") +
      box(790, 338, 180, 62, "SQLite replica", "", "store") +
      edge("r1", "M180,260 L248,260") +
      edge("r2", "M420,260 L498,260", "do") +
      edge("r3a", "M710,250 C750,250 750,151 788,151", "store") +
      edge("r3b", "M710,260 L788,260", "store") +
      edge("r3c", "M710,270 C750,270 750,369 788,369", "store") +
      `<path id="rp" d="M180,260 L600,260" fill="none"/>` +
      pkt("rp", 2.2) + pkt("r3a", 2.2, 1.1, "store") + pkt("r3b", 2.2, 1.1, "store") + pkt("r3c", 2.2, 1.1, "store") +
      text(500, 360, "write acknowledged after replication", "sub") +
      text(30, 470, "Placement: near the object's first caller. Billing: 128 MB × wall-clock while awake.", "sub"),
  },
  {
    kicker: "3 · Requests",
    title: "A request to a pooled object",
    body: `<p>The same Worker asks <b>Placement</b> (one coordinating Durable Object) which node owns the object.
      The answer is cached for 30 s. New objects go to a node in the caller's region.</p>
      <p>Each node is a <b>PoolNode</b> Durable Object with a container next to it. The request goes to the container
      as a <b>raw TCP passthrough</b>, so no JavaScript runs per WebSocket message. Inside, workerd's router hands it to
      the object.</p>
      <p>Code in the container reaches Cloudflare only through <b>bridge.internal</b>: checkpoints in R2, stats, and your objects' bindings (step 10).</p>`,
    fig: () =>
      box(20, 240, 120, 70, "Browser") +
      box(170, 240, 150, 70, "Edge Worker", "", "") +
      box(170, 60, 150, 76, "Placement", "which node? (cached)", "do") +
      box(360, 240, 150, 70, "PoolNode DO", "one per container", "pool") +
      `<g class="box vm"><rect x="545" y="110" width="440" height="330" rx="14"/></g>` +
      text(563, 136, "Container (microVM) · same city as its PoolNode DO", "sub") +
      `<g class="box pool"><rect x="563" y="150" width="250" height="270" rx="12"/></g>` +
      text(578, 176, "workerd", "") +
      box(578, 190, 110, 42, "router", "", "") +
      objects(580, 250, 11, 8, 13, 7) +
      box(830, 150, 140, 110, "Local disk", "SQLite per object", "store") +
      box(830, 290, 140, 60, "bridge.internal", "", "") +
      box(830, 455, 140, 52, "R2", "checkpoints", "store") +
      edge("a1", "M140,275 L168,275") +
      edge("a2", "M245,238 L245,138", "dash") +
      edge("a3", "M320,275 L358,275", "pool") +
      edge("a4", "M510,275 C545,275 545,211 576,211", "pool") +
      edge("a5", "M813,205 L828,205", "store") +
      edge("a6", "M900,350 L900,453", "store dash") +
      `<path id="ap" d="M140,275 L510,275 C545,275 545,211 576,211" fill="none"/>` +
      pkt("ap", 2.4) + pkt("a2", 2.4, 0.2, "do") + pkt("a6", 3, 1, "store") +
      text(330, 330, "raw TCP passthrough", "tiny"),
  },
  {
    kicker: "4 · State",
    title: "Where does the state live?",
    body: `<p><b>Real DO:</b> state lives in memory while the object is awake, and durably in Cloudflare's replicated storage.</p>
      <p><b>do-pool</b> has three layers:</p>
      <ul><li><b>Memory:</b> the live object and its WebSockets.</li>
      <li><b>Container disk:</b> one SQLite file per object. Writes are acknowledged here, immediately.</li>
      <li><b>R2:</b> the durable copy. Changed objects are flushed every <b>30 s</b>, on every move or drain, and before sleep.</li></ul>
      <p>So a planned move loses nothing, but a <b>hard crash can lose up to the last 30 s</b> of writes. That's the honest trade-off.</p>`,
    fig: () =>
      text(40, 40, "Real Durable Object", "ttl") +
      box(40, 60, 400, 80, "In memory", "the live object, its sockets", "do") +
      box(40, 210, 400, 150, "Cloudflare storage", "SQLite, replicated · durable on every write", "store") +
      edge("w1", "M240,140 L240,208", "store") +
      pkt("w1", 1.4, 0, "do") +
      text(250, 180, "every write, before ack", "tiny") +
      text(540, 40, "Pooled object", "ttl") +
      box(540, 60, 420, 80, "In memory", "the live object, its sockets", "pool") +
      box(540, 190, 420, 100, "Container disk", "one SQLite file per object · ack immediately", "pool") +
      box(540, 360, 420, 110, "R2", "segments + manifests · every 30 s, on moves, before sleep", "store") +
      edge("w2", "M750,140 L750,188", "pool") +
      edge("w3", "M750,290 L750,358", "store") +
      pkt("w2", 1.0, 0) + pkt("w3", 3, 0.6, "store") +
      text(762, 330, "batched every 30 s", "tiny") +
      `<g class="blink">${text(540, 500, "crash: lose ≤ 30 s · planned move / sleep: lose nothing", "sub")}</g>`,
  },
  {
    kicker: "5 · Storage",
    title: "Checkpoints: one write for many objects",
    body: `<p>Writing one R2 object per Durable Object would cost more than the container ($4.50 per million writes).
      So each flush packs <b>every changed object into one segment</b>, plus one small manifest per node.
      That's 2 writes every 30 s, however many objects changed.</p>
      <p>To bring an object back anywhere, a node finds the newest entry for it across all manifests and does a
      <b>ranged read</b> of just its bytes.</p>`,
    seq: [
      "Objects write to their local SQLite. The changed ones (orange) are marked dirty.",
      "Every 30 s the node snapshots each dirty object: tables, KV and its pending alarm.",
      "All snapshots are concatenated into ONE segment: a single R2 PUT.",
      "The node's manifest records key → (segment, offset, length, alarm). Second PUT.",
      "Any node can now hydrate the object with a ranged GET of just its bytes.",
    ],
    fig: () =>
      `<g data-seq="1">${box(30, 70, 280, 300, "", "", "pool")}${text(48, 98, "node-7 · local SQLite files")}${objects(52, 120, 8, 8, 20, 10, 5)}</g>` +
      `<g data-seq="2">${edge("c1", "M310,220 L378,220", "store")}${text(318, 205, "snapshot", "tiny")}</g>` +
      `<g data-seq="3">${box(380, 160, 290, 120, "", "", "store")}${text(396, 186, "seg/node-7/1729…  (1 PUT)")}` +
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => `<rect x="${396 + i * 20}" y="206" width="18" height="50" rx="3" fill="${i % 3 ? "#f2a27e" : "#eb6834"}"/>`).join("") +
      `</g>` +
      `<g data-seq="4">${edge("c2", "M670,220 L728,220", "store")}${box(730, 110, 240, 220, "", "", "store")}${text(746, 136, "manifest/node-7  (1 PUT)")}` +
      ["chat:lobby → seg@0, 812 B", "counter:a → seg@812, 240 B", "ticker:9 → seg@1052 · ⏰", "notes:x → seg@1290, 3.1 KB"].map((t, i) => text(746, 170 + i * 34, t, "sub")).join("") +
      `</g>` +
      `<g data-seq="5">${edge("c3", "M525,280 C525,420 525,430 470,450", "store")}${box(300, 420, 170, 62, "node-3", "ranged GET → hydrate", "pool")}</g>` +
      text(560, 470, "2 PUTs per flush, regardless of how many objects changed", "sub"),
  },
  {
    kicker: "6 · Moves",
    title: "Moving a live object without losing a write",
    body: `<p>Objects move when a node is hot, being drained, or replaced. The order of operations is what makes it safe.
      The new owner is only pointed at once the old one has <b>stopped accepting writes</b> and <b>persisted</b> them.</p>
      <p>Tested: 8 round-trip moves under continuous writes, <b>0 acknowledged writes lost</b>, with clients reconnecting in 0.6–1.2 s.</p>`,
    seq: [
      "Placement asks node A to hand the object over.",
      "A fences it twice: the router answers 410, and the object refuses new requests and finishes in-flight ones.",
      "Its WebSockets close with 1012 (service restart), so clients start reconnecting.",
      "A writes the object's final snapshot to R2.",
      "Only now does Placement point the object at node B (epoch + 1).",
      "Clients reconnect, and the edge re-resolves to B.",
      "B hydrates the object from R2 with a ranged read and serves it. A deletes its stale copy.",
    ],
    fig: () =>
      box(380, 30, 240, 76, "Placement", "object → node, epoch", "do") +
      box(40, 190, 300, 200, "", "", "pool") + text(58, 218, "node A") +
      box(660, 190, 300, 200, "", "", "pool") + text(678, 218, "node B") +
      `<g data-seq="1">${edge("m1", "M420,106 C300,130 260,150 230,188", "do")}</g>` +
      `<g data-seq="2">${box(90, 250, 200, 80, "object", "fenced · 410", "do")}${badge(290, 250, "410")}</g>` +
      `<g data-seq="3">${edge("m3", "M190,330 C220,440 330,460 420,462", "dash")}${text(210, 425, "close 1012", "tiny")}</g>` +
      box(420, 225, 160, 70, "R2", "", "store") +
      `<g data-seq="4">${edge("m4", "M290,272 L418,262", "store")}${text(318, 252, "final snapshot", "tiny")}</g>` +
      `<g data-seq="5">${edge("m5", "M580,106 C700,130 740,150 770,188", "do")}${text(690, 130, "epoch + 1", "tiny")}</g>` +
      box(420, 430, 160, 64, "Client", "reconnects") +
      `<g data-seq="6">${edge("m6", "M580,462 C680,460 760,440 790,392", "pool")}</g>` +
      `<g data-seq="7">${edge("m7", "M580,262 L708,262", "store")}${box(710, 250, 200, 80, "object", "hydrated · serving", "pool")}</g>`,
  },
  {
    kicker: "7 · Scale to zero",
    title: "Nodes sleep when idle, and wake in about a second",
    body: `<p>A real Durable Object hibernates for free. A container costs money while it runs, so an idle node puts
      itself to sleep using a <b>filesystem snapshot</b>, a recent Cloudflare Containers feature.</p>
      <p>Waking is a normal request, or a due alarm. The node <b>restores from its snapshot</b> with every object's
      SQLite already on disk, so nothing needs re-hydrating one by one.</p>
      <p>Measured: sleep 3–9 s, wake to ready in 1.0–1.5 s, with the alarm on time and data intact.</p>`,
    seq: [
      "No WebSockets and no requests for 10 minutes.",
      "Flush every changed object to R2 (R2 stays the source of truth).",
      "Snapshot the container's filesystem (0.2–10 MB, crash-consistent).",
      "Hand pending alarms to Placement's alarm registry.",
      "Stop the container: from now on it costs nothing.",
      "A request arrives, or Placement wakes the node because an alarm is due.",
      "Restore from the snapshot (~1 s). Every object is already on disk.",
    ],
    fig: () =>
      `<g data-seq="1">${box(40, 160, 300, 220, "", "", "pool")}${text(58, 188, "node-10")}${objects(62, 210, 10, 7, 16, 10)}${text(58, 365, "idle 10 min", "tiny")}</g>` +
      box(420, 40, 170, 64, "R2", "", "store") +
      `<g data-seq="2">${edge("s2", "M250,158 C300,80 360,72 418,72", "store")}</g>` +
      `<g data-seq="3">${box(420, 200, 170, 90, "snapshot", "filesystem image", "store")}${edge("s3", "M340,245 L418,245", "store")}</g>` +
      box(660, 40, 300, 70, "Placement", "alarm registry", "do") +
      `<g data-seq="4">${edge("s4", "M300,158 C420,120 560,110 658,90", "do")}${text(470, 140, "pending alarms", "tiny")}</g>` +
      `<g data-seq="5">${box(660, 200, 300, 130, "node-10 · stopped", "costs nothing", "ghost")}${text(900, 240, "zzz", "sub")}</g>` +
      `<g data-seq="6">${box(660, 420, 140, 64, "Request", "", "")}${edge("s6", "M730,418 L760,332", "pool")}${edge("s6b", "M820,112 L820,198", "do dash")}${text(830, 160, "alarm due", "tiny")}</g>` +
      `<g data-seq="7">${edge("s7", "M590,265 L658,265", "store")}${text(596, 255, "restore ~1 s", "tiny")}${box(840, 420, 140, 64, "ready", "all SQLite on disk", "pool")}</g>`,
  },
  {
    kicker: "8 · Alarms",
    title: "Alarms that survive moves, sleep and crashes",
    body: `<p>On Cloudflare an alarm always fires, even if the machine dies. The pool has to work for that:</p>
      <ul><li>the pending alarm is part of every <b>checkpoint</b> and is re-armed when the object hydrates elsewhere</li>
      <li>objects leaving a node hand their alarms to Placement's <b>alarm registry</b></li>
      <li>if a node dies without warning, Placement reads its <b>last manifest</b>, which records each object's alarm</li>
      <li>failing alarms are retried with the same backoff as real DOs (<code>retryCount</code> and all)</li></ul>
      <p>Tested: an alarm fires after its object migrates, after SIGTERM and after SIGKILL of its node.</p>`,
    seq: [
      "The object calls setAlarm(). It's recorded locally and goes into its next checkpoint.",
      "Node A dies abruptly (SIGKILL): no drain, no goodbye.",
      "Placement notices and reads A's last manifest from R2: this object had an alarm at T.",
      "At T, Placement assigns the object to a live node B and wakes it there.",
      "B hydrates the object; the alarm is re-armed (already due, so it fires now).",
      "alarm() runs exactly as on a real DO, with retries if it throws.",
    ],
    fig: () =>
      `<g data-seq="1">${box(40, 180, 280, 180, "", "", "pool")}${text(58, 208, "node A")}${box(80, 240, 200, 80, "object  ⏰ T", "setAlarm(T)", "pool")}</g>` +
      `<g data-seq="2">${text(180, 420, "✕ SIGKILL", "", "middle", 'style="font-size:22px;fill:#b3261e"')}</g>` +
      box(380, 30, 240, 76, "Placement", "alarm registry", "do") +
      box(400, 230, 200, 70, "R2", "manifest/node-A", "store") +
      `<g data-seq="3">${edge("l3", "M500,228 L500,108", "store")}${text(510, 170, "alarm at T", "tiny")}</g>` +
      `<g data-seq="4">${edge("l4", "M620,80 C740,90 790,130 810,178", "do")}${text(700, 100, "wake at T", "tiny")}</g>` +
      `<g data-seq="5">${box(680, 180, 280, 180, "", "", "pool")}${text(698, 208, "node B")}${edge("l5", "M600,265 L718,272", "store")}${box(720, 240, 200, 80, "object  ⏰ re-armed", "hydrated", "pool")}</g>` +
      `<g data-seq="6">${box(720, 400, 200, 64, "alarm() ✓", "retries like a real DO", "sbx")}</g>`,
  },
  {
    kicker: "9 · Dynamic apps",
    title: "Running other people's code: three backends",
    body: `<p>Apps can be published as code at runtime (<b>Worker Loader</b>) and run as <b>facets</b>: child Durable Objects
      with their own database. The same app runs three ways:</p>
      <ul><li><span class="tag do">Real DO facet</span> Cloudflare isolates it. Durable on every write.</li>
      <li><span class="tag pool">Pooled facet</span> One shared workerd process, an isolate per code version. Cheapest; for your own code.</li>
      <li><span class="tag sbx">Sandboxed tenant</span> Its <b>own workerd process</b>: own uid, every Linux namespace, no network,
      inside a microVM. Its only way out is a bridge that can read just its own code and checkpoints.</li></ul>
      <p>workerd's own README says it isn't a hardened sandbox for malicious code on its own; this is the extra layer.</p>`,
    fig: () =>
      // real DO
      text(30, 36, "Real DO facet", "ttl") +
      `<g class="box"><rect x="30" y="50" width="290" height="380" rx="14"/></g>` + text(46, 76, "Cloudflare", "sub") +
      box(50, 90, 250, 320, "", "", "do") + text(66, 116, "host Durable Object") +
      box(70, 140, 210, 150, "facet: your App", "loaded by code id", "do") +
      box(70, 310, 210, 80, "its own SQLite", "replicated", "store") +
      // pooled
      text(355, 36, "Pooled facet", "ttl") +
      `<g class="box vm"><rect x="355" y="50" width="290" height="380" rx="14"/></g>` + text(371, 76, "container (microVM)", "sub") +
      box(375, 90, 250, 320, "", "", "pool") + text(391, 116, "workerd · shared process") +
      box(395, 135, 210, 110, "isolate · app v1", "facets of many objects", "pool") +
      box(395, 260, 210, 110, "isolate · app v2", "hot-swapped code", "pool") +
      // sandboxed
      text(680, 36, "Sandboxed tenant", "ttl") +
      `<g class="box vm"><rect x="680" y="50" width="300" height="380" rx="14"/></g>` + text(696, 76, "container (microVM)", "sub") +
      box(700, 90, 260, 220, "", "", "sbx") + text(716, 116, "process per app") +
      text(716, 138, "uid 20003 · namespaces · no network", "tiny") +
      box(720, 155, 220, 130, "facet: your App", "own data dir only", "sbx") +
      box(700, 330, 260, 80, "TenantBridge", "own code + checkpoints only", "") +
      text(30, 470, "isolation: Cloudflare's", "sub") + text(355, 470, "isolation: V8 isolate", "sub") + text(680, 470, "isolation: process + namespaces + VM", "sub") +
      text(30, 492, "cost: 128 MB × awake time", "tiny") + text(355, 492, "cost: ~0.4–2.5 MB per object", "tiny") + text(680, 492, "cost: ~17 MB per app per node", "tiny"),
  },
  {
    kicker: "10 · Bindings",
    title: "KV, R2, AI, other Workers and other DOs: same code",
    body: `<p>A pooled object writes <code>await this.env.FILES.put(k, v)</code> or
      <code>this.env.BIND.getByName("b").ping()</code>, exactly as a real Durable Object would.</p>
      <ul><li>Inside the container those names are <b>proxies</b>. They record the call chain and send it to
      <b>bridge.internal/rpc</b> in one round trip.</li>
      <li>The <b>control Worker</b> holds the real bindings (declared in <code>wrangler.jsonc</code>), replays the call and
      sends the result back: bytes, Dates, R2 objects, Requests and Responses included.</li>
      <li>For <b>another pooled DO</b>, there's no binding to replay on. The bridge asks Placement which node owns it and
      calls it there, retrying if it's mid-move.</li></ul>
      <p>Cost: +15–25 ms per call; DO→DO is about the same as on Cloudflare (~31–37 ms). Bodies are buffered, not streamed.
      Sandboxed apps get no bindings. <a href="https://github.com/nyacg/do-on-container/blob/main/docs/bindings.md">More</a></p>`,
    seq: [
      "Object A calls env.FILES.put(k, v). The proxy records [put(k, v)] and nothing has been sent yet.",
      "Awaiting it sends one POST to bridge.internal/rpc. The container's egress is intercepted by its PoolNode.",
      "The control Worker's Bridge checks the name against the manifest and runs env.FILES.put(k, v) on real R2.",
      "The R2Object comes back tagged, and A gets .etag, .uploaded (a Date), .text()…",
      "A calls env.BIND.getByName('b').ping(). The bridge asks Placement: b lives on node 2.",
      "The call goes to node 2's router (x-do-call), which runs b.ping() on its local stub, like Workers RPC.",
    ],
    fig: () =>
      `<g class="box vm"><rect x="20" y="40" width="300" height="420" rx="14"/></g>` + text(36, 66, "container · node 1", "sub") +
      box(50, 90, 240, 90, "object A", "this.env.FILES / this.env.BIND", "pool") +
      `<g data-seq="1">${box(50, 220, 240, 64, "proxy: [put(k, v)]", "records, sends on await", "")}</g>` +
      box(50, 360, 240, 60, "bridge.internal", "", "") +
      `<g data-seq="2">${edge("b2", "M170,182 L170,218", "pool")}${edge("b2b", "M170,286 L170,358", "pool")}${edge("b2c", "M290,390 L408,390", "pool")}</g>` +
      box(410, 340, 220, 100, "control Worker", "Bridge · /rpc · manifest", "do") +
      `<g data-seq="3">${box(720, 400, 240, 60, "R2 · KV · AI · Workers", "real bindings", "store")}${edge("b3", "M630,410 L718,425", "store")}</g>` +
      `<g data-seq="4">${text(440, 470, "← { ok: R2Object }", "tiny")}</g>` +
      `<g data-seq="5">${box(410, 60, 220, 70, "Placement", "bind/b → node 2", "do")}${edge("b5", "M520,338 L520,132", "dash")}</g>` +
      `<g data-seq="6">${`<g class="box vm"><rect x="690" y="40" width="290" height="300" rx="14"/></g>`}${text(706, 66, "container · node 2", "sub")}${box(720, 100, 230, 60, "router", "x-do-call → stub.ping()", "")}${box(720, 200, 230, 90, "object b", "ping() runs here", "pool")}${edge("b6", "M630,380 C680,380 680,130 718,130", "pool")}${edge("b6b", "M835,162 L835,198", "pool")}</g>`,
  },
  {
    kicker: "11 · Compare",
    title: "Feature by feature",
    body: `<p>Every row marked ✅ for the pool is covered by a test that runs against the real deployment:
      55 API-parity tests across five backends, 12 binding tests (real vs pooled) and 12 lifecycle tests.</p>
      <p>See <a href="/bench.html">Benchmarks & limitations</a> for numbers and for what's still missing.</p>`,
    fig: () => "",
    html: () => `<table class="cmp"><thead><tr><th></th><th><span class="dot" style="background:var(--orange)"></span>Real Durable Object</th><th><span class="dot" style="background:var(--blue)"></span>do-pool</th></tr></thead><tbody>
      <tr><td>SQL, KV, transactions</td><td class="yes">✅</td><td class="yes">✅ same API</td></tr>
      <tr><td>WebSocket hibernation API</td><td class="yes">✅</td><td class="yes">✅ tags, attachments</td></tr>
      <tr><td>Alarms + retries</td><td class="yes">✅</td><td class="yes">✅ survive moves and crashes</td></tr>
      <tr><td>Write durable on acknowledgement</td><td class="yes">✅ replicated</td><td class="no">❌ up to 30 s lost on a hard crash</td></tr>
      <tr><td>Zero-loss planned moves</td><td>n/a</td><td class="yes">✅ fenced twice</td></tr>
      <tr><td>Near its users</td><td class="yes">✅</td><td class="yes">✅ region-local nodes</td></tr>
      <tr><td>Scale to zero</td><td class="yes">✅ hibernation</td><td class="yes">✅ snapshot sleep (~1 s wake)</td></tr>
      <tr><td>Dynamic code (facets)</td><td class="yes">✅</td><td class="yes">✅ + hot swap</td></tr>
      <tr><td>Untrusted code</td><td class="yes">✅</td><td class="part">⚠️ sandboxed tier only</td></tr>
      <tr><td>Point-in-time recovery</td><td class="yes">✅ 30 days</td><td class="no">❌</td></tr>
      <tr><td>KV, R2, AI, other Workers</td><td class="yes">✅</td><td class="yes">✅ same code, +15–25 ms per call</td></tr>
      <tr><td>Calling other Durable Objects</td><td class="yes">✅</td><td class="yes">✅ RPC + fetch, via Placement</td></tr>
      <tr><td>Cost, 1,000 awake objects</td><td>$4,050 / month</td><td class="yes">≈ $22 / month</td></tr>
    </tbody></table>`,
  },
];

// ---------------------------------------------------------------- player
const $ = (id: string) => document.getElementById(id)!;
let current = Number(new URLSearchParams(location.search).get("step") ?? 1) - 1;
let timer: ReturnType<typeof setInterval> | undefined;
const seen = new Set<number>();

function show(i: number) {
  current = Math.max(0, Math.min(STEPS.length - 1, i));
  seen.add(current);
  const s = STEPS[current];
  $("kicker").textContent = s.kicker;
  $("title").textContent = s.title;
  $("text").innerHTML = s.body;
  const figWrap = $("fig").parentElement!;
  if (s.html) {
    figWrap.innerHTML = `<div style="width:100%">${s.html()}</div><svg id="fig" viewBox="0 0 1000 520" style="display:none"></svg>`;
  } else {
    if (!document.getElementById("fig") || $("fig").style.display === "none") {
      figWrap.innerHTML = `<svg id="fig" viewBox="0 0 1000 520" role="img"></svg>`;
    }
    $("fig").innerHTML = DEFS + s.fig();
  }
  $("fig").setAttribute("aria-label", s.title);
  $("stepper").innerHTML = STEPS.map(
    (st, j) => `<button class="${j === current ? "on" : seen.has(j) ? "seen" : ""}" data-i="${j}">${st.kicker.split(" · ")[0]}. ${st.kicker.split(" · ")[1]}</button>`,
  ).join("");
  document.querySelectorAll<HTMLButtonElement>("#stepper button").forEach((b) => (b.onclick = () => show(Number(b.dataset.i))));
  ($("prev") as HTMLButtonElement).disabled = current === 0;
  ($("next") as HTMLButtonElement).textContent = current === STEPS.length - 1 ? "Start over" : "Next →";
  history.replaceState(null, "", `?step=${current + 1}`);
  playSequence(s);
}

/** Light up data-seq="1..n" one at a time, with captions, looping. */
function playSequence(s: Step) {
  clearInterval(timer);
  $("caption").textContent = "";
  if (!s.seq) return;
  let n = 0;
  const tick = () => {
    n = n >= s.seq!.length ? 1 : n + 1;
    document.querySelectorAll<SVGElement>("#fig [data-seq]").forEach((el) => {
      const k = Number(el.dataset.seq);
      el.classList.toggle("lit", k <= n);
      el.classList.toggle("now", k === n);
    });
    $("caption").innerHTML = `<b>${n}/${s.seq!.length}</b> · ${s.seq![n - 1]}`;
  };
  tick();
  timer = setInterval(tick, 2400);
}

$("prev").onclick = () => show(current - 1);
$("next").onclick = () => show(current === STEPS.length - 1 ? 0 : current + 1);
document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") show(current + 1);
  if (e.key === "ArrowLeft") show(current - 1);
});
mountNav();
show(current);
