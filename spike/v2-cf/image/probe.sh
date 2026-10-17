#!/bin/bash
# Sandboxing feature probe. Self-contained: run as root inside any container (e.g. a Cloudflare Container)
# and it prints what the kernel/runtime allows. Optional tools are used only if present:
#   bwrap (apt: bubblewrap), nsjail (build from source), capsh (apt: libcap2-bin); unshare/setpriv come from util-linux.
# TEST_UID defaults to 65534 (nobody).
U=${TEST_UID:-65534}
hr() { printf '\n== %s\n' "$*"; }
try() { # try LABEL CMD... -> prints OK/FAIL + first error line
  local label=$1; shift
  local out; out=$(timeout 10 "$@" 2>&1); local rc=$?
  if [ $rc -eq 0 ]; then printf '  %-38s OK    %s\n' "$label" "$(echo "$out" | tail -1 | head -c 120)"
  else # prefer the line carrying the root cause (nsjail logs it before the generic "Couldn't launch")
    local why; why=$(echo "$out" | grep -m1 -E 'not permitted|denied|failed:|Couldn.t mount|No permissions|capset') || why=$(echo "$out" | grep -v '^$' | tail -1)
    printf '  %-38s FAIL  rc=%s %s\n' "$label" "$rc" "$(echo "$why" | sed -E 's/^\[[WEF]\]\[[^]]*\]\[[0-9]+\] //' | head -c 200)"; fi
}

hr kernel / runtime
uname -a
cat /etc/os-release 2>/dev/null | grep PRETTY_NAME
echo "id: $(id)"
echo "pid1: $(tr '\0' ' ' </proc/1/cmdline | head -c 100)"
grep -E '^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp|Seccomp_filters):' /proc/self/status
command -v capsh >/dev/null && capsh --decode="$(awk '/^CapEff/{print $2}' /proc/self/status)"
echo "virt: $(cat /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name 2>/dev/null | tr '\n' ' ')  cpus=$(nproc) mem=$(awk '/MemTotal/{print $2" kB"}' /proc/meminfo)"
echo "kernel cmdline: $(cat /proc/cmdline 2>/dev/null | head -c 300)"
echo "cgroup: $(cat /proc/self/cgroup | head -3 | tr '\n' ' ')  rootfs: $(awk '$2=="/" {print $1" "$3}' /proc/mounts)"

hr userns sysctls
for f in /proc/sys/kernel/unprivileged_userns_clone /proc/sys/user/max_user_namespaces /proc/sys/user/max_mnt_namespaces \
         /proc/sys/user/max_pid_namespaces /proc/sys/user/max_net_namespaces /proc/sys/kernel/apparmor_restrict_unprivileged_userns \
         /proc/sys/kernel/unprivileged_bpf_disabled /proc/sys/kernel/yama/ptrace_scope /proc/sys/kernel/seccomp/actions_avail; do
  printf '  %-58s %s\n' "$f" "$(cat "$f" 2>/dev/null || echo '(absent)')"
done
echo "  LSM: $(cat /sys/kernel/security/lsm 2>/dev/null || echo '(securityfs not mounted)')  apparmor-profile: $(cat /proc/self/attr/current 2>/dev/null || echo -)"

hr "masked /proc mounts (these make a fresh procfs mount in a userns fail: mount_too_revealing)"
awk '$2 ~ /^\/proc\// || $2=="/proc" {print "  "$1" "$2" "$3" "$4}' /proc/mounts | head -20
echo "  cgroup: $(stat -fc %T /sys/fs/cgroup 2>/dev/null)  /dev/fuse: $([ -e /dev/fuse ] && echo yes || echo no)"

hr tools
for t in unshare setpriv nsenter bwrap nsjail capsh; do printf '  %-8s %s\n' $t "$(command -v $t || echo missing) $( [ -u "$(command -v $t 2>/dev/null)" ] && echo SETUID)"; done
command -v bwrap >/dev/null && echo "  bwrap $(bwrap --version 2>&1)"

hr namespace tests as root
try "unshare -U (userns)"                 unshare --user true
try "unshare -U -r (map root)"            unshare --user --map-root-user id -u
try "unshare -m (mntns, needs SYS_ADMIN)" unshare --mount true
try "unshare -m + tmpfs mount"            unshare --mount sh -c 'mount -t tmpfs t /mnt && echo mounted'
try "unshare -p -f --mount-proc"          unshare --pid --fork --mount --mount-proc sh -c 'ls /proc | grep -c "^[0-9]"'
try "unshare -n (netns)"                  unshare --net sh -c 'cat /proc/net/dev | wc -l'
try "unshare -U -r -m -p -f --mount-proc" unshare --user --map-root-user --mount --pid --fork --mount-proc sh -c 'ls /proc | grep -c "^[0-9]"'
try "unshare -U -r -m tmpfs"              unshare --user --map-root-user --mount sh -c 'mount -t tmpfs t /mnt && echo mounted'

hr namespace tests as uid $U
try "setpriv drop uid (no ns)"            setpriv --reuid=$U --regid=$U --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- sh -c 'grep -E "^(Uid|CapEff)" /proc/self/status | tr "\n\t" "  "'
try "uid: unshare -U -r"                  setpriv --reuid=$U --regid=$U --clear-groups -- unshare --user --map-root-user id -u
try "uid: unshare -U -r -m tmpfs"         setpriv --reuid=$U --regid=$U --clear-groups -- unshare --user --map-root-user --mount sh -c 'mount -t tmpfs t /mnt && echo mounted'
try "uid: unshare -U -r -p -f mount-proc" setpriv --reuid=$U --regid=$U --clear-groups -- unshare --user --map-root-user --mount --pid --fork --mount-proc sh -c 'ls /proc | grep -c "^[0-9]"'

if command -v bwrap >/dev/null; then
  hr bubblewrap
  B="--ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/bin /bin --symlink usr/sbin /sbin $([ -d /usr/lib64 ] && echo --symlink usr/lib64 /lib64) --dev /dev --tmpfs /tmp"
  try "bwrap root, --unshare-all --proc"    bwrap --unshare-all $B --proc /proc -- sh -c 'id -u; ls /proc | grep -c "^[0-9]"'
  try "bwrap root, --unshare-all no-proc"   bwrap --unshare-all $B -- id -u
  try "bwrap uid, --unshare-all --proc"     setpriv --reuid=$U --regid=$U --clear-groups -- bwrap --unshare-all $B --proc /proc -- id -u
  try "bwrap uid, --unshare-all no-proc"    setpriv --reuid=$U --regid=$U --clear-groups -- bwrap --unshare-all $B -- id -u
  try "bwrap uid, -user -mount only"        setpriv --reuid=$U --regid=$U --clear-groups -- bwrap --unshare-user --unshare-ipc $B -- id -u
  try "bwrap uid, + --unshare-net"          setpriv --reuid=$U --regid=$U --clear-groups -- bwrap --unshare-user --unshare-net $B -- sh -c 'cat /proc/net/dev 2>/dev/null | wc -l; id -u'
  try "bwrap uid, + --unshare-pid --proc"   setpriv --reuid=$U --regid=$U --clear-groups -- bwrap --unshare-user --unshare-pid $B --proc /proc -- id -u
fi

if command -v nsjail >/dev/null; then
  hr nsjail
  N="-Mo -t 0 -q --rlimit_as inf -R /usr -R /lib -R /bin -R /dev/null -T /tmp"
  try "nsjail root, userns (default)"       nsjail $N -u $U:$U:1 -g $U:$U:1 -- /bin/sh -c 'id -u'
  try "nsjail root, userns, no proc"        nsjail $N --disable_proc -u $U:$U:1 -g $U:$U:1 -- /bin/sh -c 'id -u'
  try "nsjail root, no userns"              nsjail $N --disable_clone_newuser -u $U:$U:1 -g $U:$U:1 -- /bin/sh -c 'id -u'
  try "nsjail root, no userns, share net"   nsjail $N --disable_clone_newuser -N -u $U:$U:1 -g $U:$U:1 -- /bin/sh -c 'id -u'
  try "nsjail uid, userns, no proc"        setpriv --reuid=$U --regid=$U --clear-groups -- nsjail $N --disable_proc -- /bin/sh -c 'id -u'
  try "nsjail uid, userns"                  setpriv --reuid=$U --regid=$U --clear-groups -- nsjail $N -- /bin/sh -c 'id -u'
  try "nsjail root, NO namespaces, seccomp" nsjail -Mo -t 0 -q --rlimit_as inf --disable_clone_newns --disable_clone_newpid --disable_clone_newipc --disable_clone_newuts \
        --disable_clone_newcgroup --disable_clone_newnet --disable_clone_newuser -u $U -g $U --seccomp_string 'ERRNO(1) { ptrace, mount } DEFAULT ALLOW' \
        -- /bin/sh -c 'grep -E "^(Uid|Seccomp_filters)" /proc/self/status | tr "\n\t" "  "'
  try "nsjail root, userns, seccomp"        nsjail $N -u $U:$U:1 -g $U:$U:1 --seccomp_string 'ERRNO(1) { ptrace, mount } DEFAULT ALLOW' -- /bin/sh -c 'id -u'
fi

hr "landlock (unprivileged FS allowlist, no namespaces needed; kernel >= 5.13 + CONFIG_SECURITY_LANDLOCK + 'landlock' in lsm=)"
echo "  config: $(zcat /proc/config.gz 2>/dev/null | grep -E 'SECURITY_LANDLOCK|^CONFIG_LSM=' | tr '\n' ' ' || echo '(no /proc/config.gz)')"
if setpriv --help 2>&1 | grep -q landlock; then
  try "setpriv --landlock-access fs"        setpriv --landlock-access fs --landlock-rule path-beneath:execute,read-file,read-dir:/usr \
                                              --landlock-rule path-beneath:execute,read-file,read-dir:/lib -- /bin/sh -c 'ls /usr >/dev/null && ! ls /etc >/dev/null 2>&1 && echo restricted'
else echo "  setpriv has no --landlock-access (util-linux < 2.40; bookworm ships 2.38) -> test with a trixie image"; fi

if command -v workerd >/dev/null; then
  hr "workerd binary inside sandboxes (--version only; serving also needs /etc/ssl bound in for CA certs)"
  W=$(command -v workerd)
  try "setpriv workerd"                     setpriv --reuid=$U --regid=$U --clear-groups --no-new-privs -- $W --version
  command -v bwrap  >/dev/null && try "bwrap uid workerd (no proc)"  setpriv --reuid=$U --regid=$U --clear-groups -- bwrap --unshare-all $B -- $W --version
  command -v nsjail >/dev/null && try "nsjail root workerd (no proc)" nsjail $N --disable_proc -u $U:$U:1 -g $U:$U:1 -- $W --version
fi
