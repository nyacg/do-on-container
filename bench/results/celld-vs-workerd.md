# workerd vs celld inside Cloudflare Containers

Same `Room` class (naive broadcast: one `send` per peer), same instance type (`standard-2`, 1 vCPU),
raw passthrough through the fronting DO, load from a laptop in California. 2026-10-15.

| runtime | host `cpubench` (lower = faster host) | load (in msg/s) | frames out/s | RTT p50 | RTT p99 |
|---|---|---|---|---|---|
| workerd 1.20261014 | 7.85 s | 975 | 2,582 | 8.0 s (saturated) | 15.0 s |
| celld v0.6.2 | 5.23 s | 661 | 3,896 | 342 ms | 913 ms |
| workerd | 7.85 s | 2,475 | 2,817 | 8.9 s | 17.9 s |
| celld | 5.23 s | 2,475 | 2,749 | 12.1 s | 18.1 s |

Normalised for host speed (frames/s × cpubench seconds), the two runtimes are within a few percent
of each other (≈20k "cpubench-normalised frames"). The same `standard-2` workerd image measured 4.7 s
on `cpubench` and 8.5k frames/s out in an earlier run: **host-to-host variance (~1.7×) dominates
runtime choice**.

Local (Apple M4 Pro, 1 CPU, 1 GB, arm64):

| | workerd | celld (`celld dev`) |
|---|---|---|
| baseline RSS | 18–50 MB | 77 MB (incl. 24 MB dev supervisor) |
| per resident SQLite object | ~200 KB | ~350 KB |
| 100 rooms × 10 clients × 10 msg/s | 62k frames/s out, saturated | 68k frames/s out, saturated |

Why the pool uses workerd anyway: it's the runtime Cloudflare runs, so the same class is a real DO
one deploy away; it has `localDisk` SQLite storage + eviction built in; and it's lighter per
object. celld's durability story (LTX to S3, RPO=0) is stronger, but in a container it would need
R2's S3 API on every write (~90 ms) and its peer protocol can't run between containers (no
container-to-container networking).
