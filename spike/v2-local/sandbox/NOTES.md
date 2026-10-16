# Sandboxing a second workerd per tenant inside the container (local spike)

Question: inside our container (debian bookworm-slim + workerd 1.20261014.1), can we run one extra workerd
per tenant as an unprivileged uid that can see only its own config and data dir (`/tenants/tN`)? What does
that require from the runtime, and what does each extra process cost?

Everything here ran locally on Docker Desktop. Nothing was deployed.

## Environment

```
host:   Darwin 27.0.0 arm64 (Apple silicon), Docker Desktop, server 28.5.1
kernel: Linux 6.10.14-linuxkit #1 SMP aarch64   (Docker VM kernel; `docker info` KernelVersion 6.10.14-linuxkit)
docker SecurityOptions: name=seccomp,profile=builtin name=cgroupns    <- no AppArmor/SELinux on this VM
/proc/sys/kernel/unprivileged_userns_clone   (absent -> upstream kernel, userns allowed by the kernel)
/proc/sys/user/max_user_namespaces           31322
LSM: CONFIG_LSM="yama,loadpin,safesetid,integrity,bpf"; CONFIG_SECURITY_LANDLOCK is not set
default container: CapEff=00000000a80425fb (no SYS_ADMIN/NET_ADMIN/SYS_PTRACE), Seccomp: 2 (docker builtin profile)
```

This VM has no AppArmor, so `apparmor=unconfined` does nothing here (mode b is identical to a). On an
Ubuntu host, AppArmor's `docker-default` profile also denies `mount`, and Ubuntu 24.04 also sets
`kernel.apparmor_restrict_unprivileged_userns=1`. probe.sh prints both.

## Files

| file | purpose |
|---|---|
| `Dockerfile` | Production-style image: bookworm-slim + workerd (npm pack) + bubblewrap 0.8.0 (apt) + nsjail 3.4 (built from source; it is **not packaged in bookworm**) + `bwrap-suid` (a setuid copy) + users t1..t5 (uid 10001..10005) |
| `worker.js`, `tenant.capnp.tmpl` | Tenant workerd: one SQLite DO (`Counter`, `enableSql`, `localDisk` → `/tenants/tN/data`) plus a `disk` service rooted at `/` (`ROOT`), so `/read?p=<path>` tries to read any path from inside workerd |
| `parent.capnp` | Parent workerd on :8080 that forwards to the tenant over `external = (address = "unix:/tenants/t1/run/http.sock")` |
| `lib.sh` | Launchers: `lib.sh wrap <approach> <tenant> cmd...` (approaches listed below). Env: `NET=share\|unshare`, `NOPROC=1`, `NSJ_SECCOMP=1` |
| `run-tests.sh` | For each approach: shell escape probe, then start workerd under the sandbox and record time to first request, `/proc/<pid>/status`, namespaces, and disk-escape reads |
| `measure.sh` | VmRSS/PSS for N sandboxed workerds, plus the cgroup `memory.current` delta |
| `matrix.sh` | Host driver: runs run-tests.sh and probe.sh under each docker flag set and writes to `results/` |
| `probe.sh` | **Standalone feature probe to run inside a Cloudflare Container** (see the checklist at the end) |
| `results/` | Raw outputs (run-*, probe-*, measure.txt, parent-unix-socket.txt, nsjail-no-namespaces-default-docker.txt) |

Reproduce:
```
cd spike/v2-local/sandbox
docker build -t v2sb-img .
./matrix.sh                                  # all modes -> results/run-<mode>.txt, results/probe-<mode>.txt
docker run --rm --name v2sb-t --security-opt seccomp=unconfined v2sb-img bash -c 'NOPROC=1 /sb/run-tests.sh'
docker run --rm --name v2sb-meas --cap-add SYS_PTRACE --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
  v2sb-img bash -c 'for a in none setpriv bwrap nsjail; do for n in 1 5; do /sb/measure.sh $a $n; done; done'
```
(measure.sh needs `SYS_PTRACE` only because root has to read `smaps_rollup` of processes owned by other uids.)

## Approaches (lib.sh)

Every approach ends with workerd running as uid 10001 (t1). Each tenant directory is `chown tN; chmod 700`.
* `setpriv`: `setpriv --reuid/--regid --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs`. Uses no namespaces; isolation comes only from Unix file permissions.
* `nsjail-nons`: nsjail with every `--disable_clone_new*` set, so it only does setuid, rlimits, and a **custom seccomp policy** (kafel). No namespaces.
* `unshare-root`: root runs `unshare --mount --pid --fork --mount-proc [--net]`, bind-moves `/tenants/t1` aside, mounts a tmpfs over `/tenants`, moves t1 back, then drops privileges with setpriv.
* `unshare-userns`: setpriv to t1 first, then `unshare --user --map-root-user --mount --pid ...`, does the same tmpfs trick as root inside the userns, then sets no_new_privs and drops caps.
* `bwrap`: setpriv to t1 (bwrap from Debian is not setuid), then `bwrap --unshare-all [--share-net] --die-with-parent --new-session --cap-drop ALL --ro-bind /usr /usr` (+ /lib,/bin,/sbin symlinks) `--proc /proc --dev /dev --tmpfs /tmp --ro-bind /etc/ssl /etc/ssl --bind /tenants/t1 /tenants/t1`.
* `bwrap-suid`: the same bwrap command using a setuid-root copy of bwrap.
* `nsjail`: nsjail run as root, `-Mo`, user namespace mapping `-u 10001:10001:1 -g 10001:10001:1`, `-R /usr -R /lib -R /bin -R /dev/{null,urandom,random} -R /etc/ssl -T /tmp -B /tenants/t1`, `--rlimit_as inf` (V8 reserves a large virtual address space), `-t 0`.
* `nsjail-nouserns`: the nsjail command with `--disable_clone_newuser`.
* `nsjail-unpriv`: the nsjail command run after setpriv to t1.

Two gotchas cost time:
- **nsjail `-u 10001` maps inside uid 10001 to outside uid 0 (root).** nsjail warns "Process will be UID/EUID=0 in the global user namespace". Always pass `-u in:out:count`.
- workerd inside a bare rootfs fails with `bridge.rs:795: failed: TLS configuration: unexpected error: No CA certificates were loaded from the system`. Bind `/etc/ssl` read-only.
- Without `/proc`, workerd prints `Unable to find and open the program executable, so unable to determine if there is a compiled-in config file. Proceeding on the assumption that there is not.` This is harmless.

## Results: workerd serving under each approach × docker mode

Docker modes: **a** default · **b** `apparmor=unconfined` · **c** `seccomp=unconfined` · **d** `--cap-add SYS_ADMIN` ·
**e** SYS_ADMIN + seccomp=unconfined · **f** seccomp=unconfined + `systempaths=unconfined` · **g** SYS_ADMIN + seccomp + apparmor + systempaths · **h** `--privileged`

Cells are `Y` (workerd served the DO, the uid was confirmed, and the tenant could not read t2), `Y*` (works only with `NOPROC=1`, i.e. no fresh procfs), or the exact error.

| approach | a / b (default) | c seccomp=unconf | d SYS_ADMIN | e SYS_ADMIN+seccomp | f seccomp+systempaths | g | h priv |
|---|---|---|---|---|---|---|---|
| setpriv | **Y** | Y | Y | Y | Y | Y | Y |
| nsjail-nons (seccomp, no ns) | **Y** (Seccomp_filters: 2) | (not run) | | | | | (probe Y in all modes) |
| unshare-root | `unshare failed: Operation not permitted` | same | **Y** | Y | `unshare failed: EPERM` | Y | Y |
| unshare-userns | `unshare failed: Operation not permitted` | `mount /proc failed: Operation not permitted` → **Y\*** | `mount /proc failed` → **Y\*** | `mount /proc failed` | **Y** | Y | Y |
| bwrap (non-setuid, uid t1) | `No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.` | `Can't mount proc on /newroot/proc: Operation not permitted` → **Y\*** | `pivot_root: Operation not permitted` (also with NOPROC) | `Can't mount proc...` (Y\* in probe) | **Y** | Y | Y |
| bwrap-suid | `capset failed: Operation not permitted` | same | same | same | same | same | Y |
| nsjail (root, userns) | `clone(CLONE_NEWNS\|...\|CLONE_NEWUSER\|...) failed: Operation not permitted` | `initCloneNs(): Couldn't mount '/proc'` → **Y\*** | `Couldn't mount '/proc'`; NOPROC → `pivot_root(...): Operation not permitted` | `Couldn't mount '/proc'` (Y\* in probe) | **Y** | Y | Y |
| nsjail-unpriv (uid t1) | clone EPERM | /proc → **Y\*** | pivot_root EPERM | /proc | **Y** | Y | Y |
| nsjail-nouserns (root) | clone EPERM | clone EPERM | `pivot_root(...): Operation not permitted` | `ioctl(iface='lo', SIOCSIFFLAGS, IFF_UP\|IFF_RUNNING): Operation not permitted` (needs NET_ADMIN; OK with `-N`) | clone EPERM | lo ioctl EPERM | Y |
| nsjail + kafel seccomp policy | clone EPERM | **Y\*** | – | – | **Y** | Y | Y |

The same results hold with `NET=share` (TCP on :8101 instead of a unix socket). See `results/run-*.txt` and `results/run-c-seccomp-unconfined-NOPROC.txt`.

`probe.sh` pass/fail grid (Y = OK), from `results/probe-*.txt`:
```
test                                     a  b  c  d  e  f  g  h
unshare -U (userns)                      .  .  Y  Y  Y  Y  Y  Y
unshare -m (mntns, needs SYS_ADMIN)      .  .  .  Y  Y  .  Y  Y
unshare -p -f --mount-proc               .  .  .  Y  Y  .  Y  Y
unshare -U -r -m -p -f --mount-proc      .  .  .  .  .  Y  Y  Y
setpriv drop uid (no ns)                 Y  Y  Y  Y  Y  Y  Y  Y
uid: unshare -U -r -m tmpfs              .  .  Y  Y  Y  Y  Y  Y
bwrap uid, --unshare-all --proc          .  .  .  .  .  Y  Y  Y
bwrap uid, --unshare-all no-proc         .  .  Y  .  Y  Y  Y  Y
nsjail root, userns (default)            .  .  .  .  .  Y  Y  Y
nsjail root, userns, no proc             .  .  Y  .  Y  Y  Y  Y
nsjail root, no userns                   .  .  .  .  .  .  .  Y
nsjail uid, userns, no proc              .  .  Y  .  Y  Y  Y  Y
nsjail root, NO namespaces, seccomp      Y  Y  Y  Y  Y  Y  Y  Y
setpriv workerd / bwrap workerd / nsjail workerd(no proc): a,b,d: Y . .   c,e,f,g,h: Y Y Y
```

## Kernel and runtime features each approach needs

| approach | needs |
|---|---|
| setpriv | Container root with CAP_SETUID/SETGID (Docker grants these by default). Nothing else. |
| nsjail-nons | The same, plus the `seccomp()` syscall being allowed (Docker's default profile allows it). The filter stacks on the runtime's filter (`Seccomp_filters: 2`). |
| unshare-root | **CAP_SYS_ADMIN** in the container. Docker's default seccomp profile then also opens `unshare`/`mount`/`setns`/`umount2`, so seccomp can stay on. |
| unshare-userns / bwrap / nsjail (userns) | Unprivileged user namespaces in the kernel (no `unprivileged_userns_clone=0`, `max_user_namespaces>0`, no AppArmor userns restriction). **The runtime's seccomp must allow `clone`/`unshare` with CLONE_NEWUSER, `mount`, and (for bwrap/nsjail) `pivot_root`.** Docker's default profile allows the first two only when the container has CAP_SYS_ADMIN, and never allows `pivot_root`. That is why mode **d** (SYS_ADMIN, default seccomp) passes `unshare -U` but fails bwrap/nsjail at `pivot_root`. In practice you need `seccomp=unconfined` or a custom profile. |
| fresh `/proc` in the sandbox (`--proc`, `--mount-proc`, nsjail default) | Additionally needs **unmasked /proc**. Docker overmounts `/proc/kcore`, `/proc/keys`, `/proc/timer_list`, etc. with tmpfs and mounts `/proc/sys` and `/proc/bus` read-only, and the kernel (`mount_too_revealing`) refuses a new procfs in a userns while those exist. Fixes: `systempaths=unconfined`, privileged, or **just don't mount /proc**. workerd runs fine without /proc. |
| bwrap-suid | Container bounding set must include the caps setuid bwrap keeps (fails with `capset failed` unless privileged). Don't use it. |
| nsjail root without userns | CAP_SYS_ADMIN, plus CAP_NET_ADMIN if it creates a new netns (to bring `lo` up), plus `pivot_root` through seccomp. |
| Landlock (FS allowlist without namespaces) | Not available on this kernel: `setpriv: landlock_create_ruleset failed: Function not implemented` (trixie setpriv 2.41, even with seccomp=unconfined). bookworm's setpriv 2.38 has no `--landlock-access`. probe.sh checks for it. |

## Isolation evidence (mode g; same for f, h, and NOPROC in c)

```
-- [setpriv] shell: uid=10001 cat_t2=[cat: /tenants/t2/secret: Permission denied] own=[secret-of-t1] ls_tenants=[t1 t2 ]
     root=[bin boot dev etc home lib ... sb ... var] pids_visible=11
   [setpriv] workerd OK first_req=29ms resp={"tenant":"t1","count":3} Uid:10001,10001 CapEff:0000000000000000 NoNewPrivs:1
   [setpriv] disk-escape t2: status=404 Not Found
-- [unshare-root] shell: uid=10001 cat_t2=[cat: /tenants/t2/secret: No such file or directory] ls_tenants=[t1 ] pids_visible=4
   [unshare-root] workerd OK first_req=27ms ... Uid:10001,10001 NSpid:266,1 CapEff:0 NoNewPrivs:1
-- [bwrap] shell: uid=10001 cat_t2=[cat: /tenants/t2/secret: No such file or directory] ls_tenants=[t1 ]
     root=[bin dev etc lib proc sbin tenants tmp usr ] pids_visible=5
   [bwrap] workerd OK first_req=33ms resp={"tenant":"t1","count":3} Uid:10001,10001 NSpid:490,2 CapEff:0 NoNewPrivs:1 Seccomp:0
   [bwrap] disk-escape t2: status=404 Not Found      disk ls /: [bin, dev, etc, lib, proc, sbin, tenants, tmp, usr]
-- [nsjail] shell: uid=10001 cat_t2=[...No such file or directory] ls_tenants=[t1 ] root=[bin dev etc lib proc tenants tmp usr ] pids_visible=4
   [nsjail] workerd OK first_req=32ms ... Uid:10001,10001 NSpid:636,1 mntns=own netns=own userns=own
   (NSJ_SECCOMP=1 -> Seccomp:2, workerd still OK)
-- [nsjail-nons] (DEFAULT docker): uid=10001 cat_t2=[Permission denied]; workerd OK; Uid 10001; NoNewPrivs 1; Seccomp_filters 2;
   `unshare -U` inside -> "unshare failed: Operation not permitted" (blocked by our kafel policy)
```
`Uid:` comes from `/proc/<workerd pid>/status` read from the outer container. `NSpid: X,1` shows workerd is pid 1 in its own pid namespace.
The `/read?p=/tenants/t2/secret` request goes through workerd's own `disk` service rooted at `/`. In every namespace approach it gets 404 because the path does not exist. With setpriv and nsjail-nons it also gets 404, because DAC denies access. `/read?p=/tenants/t1/secret` returns 200.

kafel policy used (`NSJ_POLICY` in lib.sh): `ERRNO(1) { ptrace, process_vm_readv, process_vm_writev, mount, pivot_root, chroot, kexec_load, init_module, finit_module, delete_module, bpf, perf_event_open, keyctl, add_key, request_key, unshare, setns, userfaultfd } DEFAULT ALLOW`. workerd served normally under it. Note that `umount2` is not a known identifier in kafel on aarch64 (`Could not compile policy: 1:64: Undefined identifier 'umount2'`).

bwrap has no inline seccomp. It needs a precompiled BPF program passed with `--seccomp FD`, which we did not test. nsjail compiles kafel inline.

## Networking: unix socket vs TCP

- With `NET=unshare`, the sandbox gets its own netns that contains only `lo`. workerd listens on `address = "unix:/tenants/t1/run/http.sock"` inside the bind-mounted tenant dir. The outer side can reach it:
  - `curl --unix-socket /tenants/t1/run/http.sock http://t1/?name=a` → `{"tenant":"t1","count":N}` (all namespace approaches)
  - **parent workerd** with `(name="t1", external=(address="unix:/tenants/t1/run/http.sock", http=()))` works (`results/parent-unix-socket.txt`):
    ```
    [bwrap]  host curl -> parent :8080 -> unix socket -> sandboxed t1: {"tenant":"t1","count":1} {"tenant":"t1","count":2}
    [nsjail] (same)
    socket file: srwxr-xr-x 1 t1 t1 /tenants/t1/run/http.sock   (other tenants cannot connect: needs write perm; the dir is 0700)
    sandbox -> parent tcp 127.0.0.1:8080: curl: (7) Failed to connect ... Couldn't connect to server
    sandbox -> internet: curl: (6) Could not resolve host: example.com   (host control: 200)
    ```
- With `NET=share` (`bwrap --share-net`, `nsjail -N`), TCP `*:8101` works and is reachable from the outer container. The tenant can then also reach every localhost port, including the parent and other tenants.
- With setpriv and nsjail-nons, the netns is always shared. Use the unix socket in the 0700 tenant dir so other tenants can't connect to it. The tenant can still connect to any TCP listener in the container.
- An unshared netns also removes egress. If the tenant's worker needs `fetch()`, route it through the parent, e.g. `globalOutbound` pointing at an `external` unix-socket service served by the parent.

## Memory (VmRSS from /proc/<pid>/status, PSS from /proc/<pid>/smaps_rollup), `results/measure.txt`

Each tenant workerd serves one SQLite DO. Measured 3 s idle after 4 requests. Units are kB.

| approach | N | per-workerd VmRSS | RssAnon | RssFile | per-workerd PSS | Pss_Anon | Pss_File | Σ PSS (incl. wrappers) | cgroup memory.current Δ |
|---|---|---|---|---|---|---|---|---|---|
| none (root) | 1 | 54,692 | 16,596 | 38,096 | 53,556 | 16,704 | 36,852 | 53,556 | 78,796 |
| none (root) | 5 | ~55,300 | ~16,550 | ~38,800 | ~24,300 | ~16,700 | ~7,600 | 121,522 | 148,264 |
| setpriv | 1 / 5 | same | | | 53,544 / ~24,280 | | | 53,544 / 121,414 | 77,380 / 149,272 |
| bwrap | 1 / 5 | same | | | 53,482 / ~24,280 | | | 54,169 / 123,194 | 78,464 / 153,036 |
| nsjail (-Mo supervisor) | 1 / 5 | same | | | 53,470 / ~24,230 | | | 57,937 / 129,079 | 83,444 / 158,492 |

- **The marginal cost of one more tenant workerd is about 17 MB.** Σ PSS goes from 53.6 to 121.5 MB for 1→5 processes, i.e. 17.0 MB per extra process. The cgroup delta gives 17.4 MB per extra. Nearly all of it is anonymous memory (V8 heap, isolate, SQLite). The 37–38 MB of binary text is shared once.
- Wrapper overhead per sandbox: **setpriv 0** (it execs). **bwrap ≈ 0.35 MB** PSS (two small `bwrap` processes, RSS 1.6 + 1.2 MB). **nsjail ≈ 1.5 MB** PSS (one `nsjail` supervisor as root, RSS 6.5 MB, mostly shared libprotobuf and libstdc++).
- `nsjail -Me` (execve mode, no supervisor) did not work. As root it failed with `gid_map ... Operation not permitted` because it can't map a foreign uid after unsharing itself. As uid t1, workerd died with SIGTRAP. Not pursued.

## Startup (time from spawn to first successful DO response over the socket)

- Warm page cache: **23–35 ms for every approach**, including `none`. Sandbox setup adds no measurable time beyond that noise.
- First instance after a cold page cache: 74–276 ms, mostly paging in the 143 MB workerd binary. In a 5-instance run the later instances take 22–35 ms.

## Recommendation

1. **The namespace sandbox needs runtime support. Run `probe.sh` in a Cloudflare Container first.** Under Docker defaults (seccomp profile, no SYS_ADMIN), *no* namespace-based approach works. User namespaces are blocked by seccomp, not by the kernel.
2. **If probe shows `bwrap uid, --unshare-all no-proc` OK**, the CF runtime allows userns, mount, and pivot_root. Then use **nsjail in userns mode** (`-u 10001:10001:1`, add `--disable_proc` unless `nsjail root, userns (default)` also passes), a unix socket in `/tenants/tN/run`, a kafel seccomp denylist, and rlimits. It costs about 1.5 MB per tenant on top of about 17 MB for workerd. bwrap is the lighter alternative (about 0.35 MB per tenant, can run without root), but it has no inline seccomp. If CF only passes the `uid: unshare -U -r -m tmpfs` row, `unshare-userns` with NOPROC is a zero-dependency option.
3. **If probe matches Docker defaults** (likely if CF Containers apply a Docker-like seccomp profile), fall back to **`nsjail-nons`**. It runs workerd as a per-tenant uid with no caps, no_new_privs, our own seccomp filter stacked on the runtime's, rlimits, a 0700 tenant dir, and a unix socket. Plain `setpriv` gives the same minus seccomp and rlimits, with no extra binary. In this mode the tenant can still see the image filesystem (world-readable files), the process list (`/proc/*/cmdline`, but not environ or memory: different uid and no ptrace), a shared `/tmp`, and every TCP listener. Keep secrets out of world-readable paths, and make the parent listen on a unix socket or bind to something tenants can't reach.
4. **If CF grants CAP_SYS_ADMIN** but keeps a Docker-style seccomp profile (probe: `unshare -m (mntns, needs SYS_ADMIN)` OK, bwrap fails with `pivot_root`), use **`unshare-root`**. It gives a mount ns that hides other tenants, a pid ns, an optional net ns, and then setpriv. It ran in mode d with the default seccomp profile still active.

## Checklist for testing inside a Cloudflare Container

1. Add to the image: `apt-get install bubblewrap libcap2-bin libprotobuf32 libnl-route-3-200`, copy the nsjail binary from the `nsjail` build stage in `Dockerfile` (use `linux-64`/amd64 for prod; arch is chosen by TARGETARCH), and copy `probe.sh`. Optionally use a trixie-based image or a static helper so the Landlock check can run.
2. At container start, run `TEST_UID=65534 /sb/probe.sh` (as root) and expose the output, e.g. log it to stdout or serve it on an HTTP endpoint in the supervisor. It prints:
   - `uname -a`, kernel cmdline, virt vendor, cgroup and rootfs, `CapEff` decoded by `capsh`, `NoNewPrivs`, `Seccomp`/`Seccomp_filters`
   - the userns sysctls (`unprivileged_userns_clone`, `max_user_namespaces`, `apparmor_restrict_unprivileged_userns`), `/sys/kernel/security/lsm`, and the AppArmor profile
   - masked `/proc` mounts (predicts whether a fresh procfs mount will fail)
   - OK/FAIL with the exact error for: `unshare -U`, `-m`, `-p --mount-proc`, `-n`, userns+mount as root and as uid; bwrap with and without `--proc`, root and uid; nsjail userns, no-proc, no-userns, uid, seccomp, and NO-namespaces+seccomp; Landlock via setpriv; `workerd --version` under setpriv, bwrap, and nsjail
3. Read the result:
   - `Seccomp: 0` with userns rows OK → recommendation 2.
   - `unshare -U` FAIL with `Operation not permitted` while `max_user_namespaces > 0` → seccomp or LSM is blocking it → recommendation 3.
   - Only `--proc` rows FAIL → add `--disable_proc` (nsjail), drop `--proc` (bwrap), or set `NOPROC=1` in lib.sh.
4. To run the full end-to-end test there, copy `lib.sh`, `run-tests.sh`, `worker.js`, and `tenant.capnp.tmpl` in as well, create users t1/t2, and run `NOPROC=1 /sb/run-tests.sh setpriv nsjail-nons bwrap nsjail unshare-userns unshare-root`.
