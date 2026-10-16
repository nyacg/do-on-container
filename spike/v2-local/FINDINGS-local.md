# v2 local spike: alarms, Worker Loader + DO facets, process sandboxing

workerd **1.20261014.1**, the same version as `container/Dockerfile`. Alarm and facet behaviour was measured on darwin-arm64. Memory was measured on linux-arm64 in debian:bookworm-slim (`Dockerfile.local`). Nothing was deployed.

## 1. Alarms (`alarms/`)
| Question | Answer |
|---|---|
| Does an alarm fire for an evicted object? | **Yes.** Alarm set +90 s, no further requests; fired 6 ms late on a freshly constructed instance. |
| Does it fire after a process restart? | **Yes.** Overdue alarm fired ~1.3 s after restart. A future alarm fired on time after SIGKILL + restart. |
| Where is it stored? | `<disk>/<uniqueKey>/metadata.sqlite` table `_cf_ALARM(actor_id, scheduled_time ns, actor_name)`, which the scheduler loads at startup. Also `_cf_METADATA` key 1 inside each object's `.sqlite`. |
| Retries? | 6 retries (7 attempts in total). Backoff `2<<n` s plus up to 25% jitter (+2.1, +4.0, +9.2, +17.6, +36.1, +68.8 s), then the alarm is dropped. Retry state is in memory only. Retries survive eviction. |
| `getAlarm` / `deleteAll` | `getAlarm()` returns the time set, and the original time during retries. `deleteAll()` clears the alarm and its `_cf_ALARM` row. |

**Consequence:** restoring an object's data on another node does *not* reschedule its alarm. Hydration must call `setAlarm` itself, so the alarm time has to be in the checkpoint.

## 2. Worker Loader + facets (`facets/`)
- **Requirements:** `workerd serve --experimental` is required for `workerLoader` bindings. No compat flag is needed.
- **Storage:** each facet gets its own SQLite, `<rootId>.<n>.sqlite`. A binary index `<rootId>.facets` maps names to numbers.
- **Works in a facet:**
  - `sql`, `kv`, `transactionSync` (with rollback), `blockConcurrencyWhile`, RPC from the supervisor
  - `ctx.id.name` (returns the root's name)
  - WebSocket hibernation API: tags, attachments, `getWebSockets`. True hibernation and rebuild after 90 s idle was verified.
- **Alarms: not supported.** Facets throw `Facets currently cannot set alarms.`
  - Proxy that works: the facet calls `ctx.props.sched.setAlarm(t)`, which goes to a root `ctx.exports` entrypoint. The root's `alarm()` then calls `facet.runAlarm()`.
  - Verified after both root and facet were evicted.
- **Code swap:** `facets.abort()` then `get()` with a new code id keeps SQLite and KV.
  - Open sockets close with **1006**, so close them with 1012 first.
  - Without `abort()`, the old code silently stays.
- **Delete / clone / root `deleteAll`:**
  - `facets.delete()` removes the facet's files. `facets.clone()` copies them.
  - Root `deleteAll()` deletes the facet files, but a *running* facet keeps serving stale data. Abort facets first.
- **Load latency:** cold ~3 ms (Docker linux-arm64), warm ~0 ms. Same id reuses the isolate.
- **Memory:**
  - ~2.2 MB per distinct code id.
  - Root+facet pair: 0.42 MB on shared code, 2.5 MB with its own code.
  - **Named `LOADER.get(id)` workers are never evicted** (plain HashMap in `loader.rs`): 557 MB still resident after 2+ min idle.
  - Unnamed `LOADER.load()` workers are garbage-collected.
- **Isolation limits:**
  - Tenants on the same code id share an isolate and its module globals.
  - `limits.cpuMs` is **not enforced**.
  - One busy dynamic worker stalls the whole single-threaded process (a concurrent request waited 1.69 s).
- **`globalOutbound: null`** blocks `fetch` as expected.

## 3. Process sandboxing (`sandbox/`, details in `sandbox/NOTES.md`)
- **Default Docker flags:**
  - Every namespace approach (bwrap, nsjail, unshare) fails with EPERM: the seccomp profile blocks user namespaces and `pivot_root`.
  - What works is a per-tenant uid via `setpriv`, or nsjail without namespaces (caps 0, no_new_privs, extra seccomp filter, 0700 dir, unix socket).
  - That blocks other tenants' data, but tenants can still see the image filesystem, the process list, `/tmp` and every TCP listener.
- **With SYS_ADMIN:** `unshare` as root, then `setpriv`.
- **With `seccomp=unconfined`:** bwrap and nsjail with user namespaces work (no `/proc` mount needed by workerd).
- **Cost:** each extra workerd process is ~17 MB (the 38 MB binary is shared). Wrapper overhead: setpriv 0, bwrap 0.35 MB, nsjail 1.5 MB. First request 23–35 ms after spawn.
- **Next step:** run `sandbox/probe.sh` inside a Cloudflare container to see which mode applies there.
