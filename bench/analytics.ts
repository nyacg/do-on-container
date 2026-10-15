/**
 * Pulls Durable Object + Container usage from the Cloudflare GraphQL Analytics API and
 * prices it.  npx tsx bench/analytics.ts [sinceISO] [untilISO]
 */
const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = process.env;
const since = process.argv[2] ?? new Date(Date.now() - 3600_000).toISOString();
const until = process.argv[3] ?? new Date().toISOString();

async function gql(query: string, variables: Record<string, unknown>) {
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = (await r.json()) as any;
  if (j.errors?.length) throw new Error(JSON.stringify(j.errors));
  return j.data.viewer.accounts[0];
}

const ns = (await (
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/durable_objects/namespaces?per_page=100`, {
    headers: { authorization: `Bearer ${token}` },
  })
).json()) as any;
const nsName = new Map<string, string>(ns.result.map((n: any) => [n.id, `${n.script}:${n.class}`]));

const d = await gql(
  `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
    durableObjectsInvocationsAdaptiveGroups(limit:1000,filter:{datetime_geq:$s,datetime_leq:$e}){sum{requests} dimensions{namespaceId}}
    durableObjectsPeriodicGroups(limit:1000,filter:{datetime_geq:$s,datetime_leq:$e}){sum{activeTime cpuTime duration inboundWebsocketMsgCount outboundWebsocketMsgCount} dimensions{namespaceId}}
  }}}`,
  { a: account, s: since, e: until },
);

const rows = new Map<string, any>();
const row = (id: string) => rows.get(id) ?? (rows.set(id, { ns: nsName.get(id) ?? id, requests: 0, inboundWs: 0, outboundWs: 0, gbSeconds: 0, cpuMs: 0 }), rows.get(id));
for (const g of d.durableObjectsInvocationsAdaptiveGroups) row(g.dimensions.namespaceId).requests += g.sum.requests;
for (const g of d.durableObjectsPeriodicGroups) {
  const r = row(g.dimensions.namespaceId);
  r.gbSeconds += g.sum.duration;
  r.cpuMs += g.sum.cpuTime / 1000;
  r.inboundWs += g.sum.inboundWebsocketMsgCount;
  r.outboundWs += g.sum.outboundWebsocketMsgCount;
}
const DURATION_PER_GBS = 12.5 / 1e6, PER_REQ = 0.15 / 1e6;
console.log(`window ${since} → ${until}`);
console.table(
  [...rows.values()]
    .filter((r) => r.ns.startsWith("do-pool:"))
    .map((r) => ({
      ...r,
      gbSeconds: Math.round(r.gbSeconds),
      cpuMs: Math.round(r.cpuMs),
      // incoming WS messages bill at 20:1 and are included in requests for hibernatable sockets
      list$: +(r.gbSeconds * DURATION_PER_GBS + r.requests * PER_REQ + (r.inboundWs / 20) * PER_REQ).toFixed(4),
    })),
);

try {
  const c = await gql(
    `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
      containersMetricsAdaptiveGroups(limit:1000,filter:{datetime_geq:$s,datetime_leq:$e}){
        sum{cpuTimeSec allocatedMemory allocatedDisk txBytes rxBytes} dimensions{applicationId}}
    }}}`,
    { a: account, s: since, e: until },
  );
  console.log("containers:");
  console.table(c.containersMetricsAdaptiveGroups.map((g: any) => ({ app: g.dimensions.applicationId, ...g.sum })));
} catch (e) {
  console.log("container metrics query failed:", String(e).slice(0, 300));
}
