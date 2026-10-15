// Drives two browser tabs against each demo + backend, checks they sync, saves screenshots.
//   node bench/ui-check.mjs [base] [outDir]
import { chromium } from "playwright";
const base = process.argv[2] ?? "https://do-pool.do-pool-lab.workers.dev";
const out = process.argv[3] ?? ".context";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const room = `ui-${Date.now().toString(36)}`;
const results = {};

for (const backend of ["pool", "do"]) {
  // Cursors: A moves + stamps, B must see A's cursor and the stamps.
  const a = await ctx.newPage(), b = await ctx.newPage();
  await a.goto(`${base}/cursors.html?backend=${backend}&room=${room}`);
  await b.goto(`${base}/cursors.html?backend=${backend}&room=${room}`);
  await a.waitForFunction(() => document.getElementById("conn")?.textContent === "connected", null, { timeout: 30000 });
  await b.waitForFunction(() => document.getElementById("conn")?.textContent === "connected", null, { timeout: 30000 });
  for (let i = 0; i < 12; i++) {
    const x = 150 + i * 60, y = 200 + Math.round(Math.sin(i / 2) * 120);
    await a.mouse.move(x, y, { steps: 4 });
    if (i % 3 === 0) await a.mouse.click(x, y);
  }
  await a.mouse.move(600, 380, { steps: 5 });
  await b.mouse.move(420, 300, { steps: 5 });
  await b.waitForTimeout(2500);
  const seen = await b.evaluate(() => ({ cursors: document.querySelectorAll(".cursor").length, stamps: document.querySelectorAll(".stamp").length, rtt: document.getElementById("rtt")?.textContent, node: document.getElementById("node")?.textContent }));
  await b.screenshot({ path: `${out}/cursors-${backend}.png` });
  results[`cursors-${backend}`] = seen;
  await a.close(); await b.close();

  // Editor: A types, B must receive the text.
  const ea = await ctx.newPage(), eb = await ctx.newPage();
  await ea.goto(`${base}/editor.html?backend=${backend}&room=${room}`);
  await eb.goto(`${base}/editor.html?backend=${backend}&room=${room}`);
  await ea.waitForFunction(() => document.getElementById("conn")?.textContent === "synced", null, { timeout: 30000 });
  await eb.waitForFunction(() => document.getElementById("conn")?.textContent === "synced", null, { timeout: 30000 });
  await ea.click(".cm-content");
  const text = `Hello from tab A on the ${backend} backend!\nDurable Objects, bin-packed into Cloudflare Containers.`;
  await ea.keyboard.type(text, { delay: 5 });
  await eb.click(".cm-content");
  await eb.keyboard.press("Control+End");
  await eb.keyboard.type("\n— and tab B says hi back.", { delay: 5 });
  await eb.waitForTimeout(1500);
  const got = await ea.evaluate(() => document.querySelector(".cm-content")?.textContent ?? "");
  await ea.screenshot({ path: `${out}/editor-${backend}.png` });
  results[`editor-${backend}`] = { synced: got.includes("tab B says hi") && got.includes("Hello from tab A"), chars: got.length };
  await ea.close(); await eb.close();
}

const dash = await ctx.newPage();
await dash.goto(base + "/");
await dash.waitForTimeout(2500);
await dash.screenshot({ path: `${out}/dashboard.png`, fullPage: true });
console.log(JSON.stringify({ room, ...results }, null, 2));
await browser.close();
