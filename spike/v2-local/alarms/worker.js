// Alarm semantics probe for workerd with localDisk + enableSql.
import { DurableObject } from "cloudflare:workers";

let instanceSeq = 0;
const ts = () => new Date().toISOString();

export class A extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.inst = ++instanceSeq;
    this.name = ctx.id.name;
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS runs (n INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, inst INTEGER, retry INTEGER, is_retry INTEGER, outcome TEXT)",
    );
    console.log(`${ts()} [construct] name=${this.name} inst=${this.inst}`);
  }

  async fetch(req) {
    const url = new URL(req.url);
    const s = this.ctx.storage;
    switch (url.pathname) {
      case "/set": {
        const ms = Number(url.searchParams.get("ms") ?? 90000);
        const failTimes = Number(url.searchParams.get("fail") ?? 0);
        s.kv.put("failTimes", failTimes);
        s.kv.put("setBy", this.inst);
        const at = Date.now() + ms;
        await s.setAlarm(at);
        return Response.json({ inst: this.inst, setFor: at, setForIso: new Date(at).toISOString(), getAlarm: await s.getAlarm() });
      }
      case "/get":
        return Response.json({
          inst: this.inst,
          now: Date.now(),
          getAlarm: await s.getAlarm(),
          setBy: s.kv.get("setBy"),
          runs: s.sql.exec("SELECT * FROM runs ORDER BY n").toArray(),
        });
      case "/deleteAll": {
        await s.setAlarm(Date.now() + 600000);
        s.kv.put("x", 1);
        const before = await s.getAlarm();
        await s.deleteAll();
        const after = await s.getAlarm();
        return Response.json({ before, after, kvAfter: s.kv.get("x") ?? null });
      }
      case "/deleteAlarm": {
        await s.deleteAlarm();
        return Response.json({ after: await s.getAlarm() });
      }
    }
    return new Response("?", { status: 404 });
  }

  async alarm(info) {
    const s = this.ctx.storage;
    const done = s.sql.exec("SELECT count(*) AS c FROM runs").one().c;
    const failTimes = s.kv.get("failTimes") ?? 0;
    const fail = done < failTimes;
    s.sql.exec(
      "INSERT INTO runs (at, inst, retry, is_retry, outcome) VALUES (?, ?, ?, ?, ?)",
      Date.now(), this.inst, info?.retryCount ?? -1, info?.isRetry ? 1 : 0, fail ? "throw" : "ok",
    );
    console.log(
      `${ts()} [alarm] name=${this.name} inst=${this.inst} setBy=${s.kv.get("setBy")} retryCount=${info?.retryCount} isRetry=${info?.isRetry} -> ${fail ? "THROW" : "ok"}`,
    );
    if (fail) throw new Error(`deliberate failure #${done + 1}`);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const name = url.searchParams.get("name") ?? "a";
    return env.A.get(env.A.idFromName(name)).fetch(req);
  },
};
