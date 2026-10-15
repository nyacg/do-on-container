// Local stand-in for the Worker-side bridge (http://bridge.internal) when running the
// container under plain Docker: stores checkpoints in memory and prints stats pushes.
import http from "node:http";
const blobs = new Map();
let lastStats = null;
http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/blob/")) {
      const key = decodeURIComponent(url.pathname.slice(6));
      if (req.method === "PUT") {
        blobs.set(key, body);
        console.log(`PUT ${key} ${body.length}B`);
        return res.end("ok");
      }
      let b = blobs.get(key);
      const m = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
      if (b && m) b = b.subarray(+m[1], +m[2] + 1);
      res.statusCode = b ? 200 : 404;
      return res.end(b ?? "");
    }
    if (url.pathname === "/list") {
      const prefix = url.searchParams.get("prefix") ?? "";
      return res.end(JSON.stringify([...blobs.keys()].filter((k) => k.startsWith(prefix))));
    }
    if (url.pathname === "/stats") {
      lastStats = JSON.parse(body.toString() || "null");
      return res.end("ok");
    }
    if (url.pathname === "/_dev") return res.end(JSON.stringify({ keys: [...blobs.keys()], lastStats }));
    res.statusCode = 404;
    res.end("not found");
  })
  .listen(80, () => console.log("dev bridge on :80"));
