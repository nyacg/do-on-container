# Autoscaling / scale-down runs (2026-10-14, basic nodes)

- ticker-3000x2-autoscale-v3: 6,000 sockets from cold, 1 → 5 nodes in ~70 s, 5,995/6,000 connected
  (5 errors), p50 RTT 601 ms because early nodes saturated before the earlier-scale-up fix (see POST §6).
- Placement scaled down after 5 idle minutes: drained node-35 (690 objects → 1 R2 segment, 2.8 s) and
  node-36 (119 live objects, 1.6 s); spot-checked objects re-hydrated on surviving nodes with their state.
- Under CPU saturation, segment uploads from the hot node failed ("Network connection lost") until load
  dropped; that's why scale-up now triggers at 60% smoothed load.
