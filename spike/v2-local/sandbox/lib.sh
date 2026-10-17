#!/bin/bash
# Sandbox launchers for a per-tenant workerd. Source it, or call `lib.sh wrap APPROACH TENANT CMD...`.
#   NET=share|unshare  (default unshare: no network namespace sharing -> serve on a unix socket)
#   NSJ_SECCOMP=1      add a kafel seccomp denylist to nsjail
#   NOPROC=1           don't mount a fresh procfs in the sandbox (needed when the runtime masks /proc paths)
set -u
TENANTS=/tenants

uid_of() { id -u "$1"; }

setup_tenant() { # setup_tenant t1 ADDR
  local t=$1 addr=$2 d=$TENANTS/$1
  mkdir -p "$d/data" "$d/run"
  echo "secret-of-$t" > "$d/secret"
  cp /sb/worker.js "$d/worker.js"
  sed -e "s|@TENANT@|$t|g" -e "s|@ADDR@|$addr|g" /sb/tenant.capnp.tmpl > "$d/config.capnp"
  chown -R "$t:$t" "$d"; chmod 700 "$d"
}

priv_drop() { # setpriv to the tenant uid, no caps, no_new_privs
  local u; u=$(uid_of "$1"); shift
  exec setpriv --reuid="$u" --regid="$u" --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- "$@"
}
# like priv_drop but WITHOUT no_new_privs/bounding drop (needed so a setuid helper can still elevate)
uid_drop() { local u; u=$(uid_of "$1"); shift; exec setpriv --reuid="$u" --regid="$u" --clear-groups -- "$@"; }

bwrap_args() {
  local t=$1
  echo --unshare-all $([ "${NET:-unshare}" = share ] && echo --share-net) --die-with-parent --new-session --cap-drop ALL \
    --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/bin /bin --symlink usr/sbin /sbin \
    $([ -d /usr/lib64 ] && echo --symlink usr/lib64 /lib64) \
    $([ -n "${NOPROC:-}" ] || echo --proc /proc) --dev /dev --tmpfs /tmp --ro-bind /etc/ssl /etc/ssl \
    --bind "$TENANTS/$t" "$TENANTS/$t" --chdir "$TENANTS/$t"
}

NSJ_POLICY='ERRNO(1) { ptrace, process_vm_readv, process_vm_writev, mount, pivot_root, chroot, kexec_load, init_module, finit_module, delete_module, bpf, perf_event_open, keyctl, add_key, request_key, unshare, setns, userfaultfd } DEFAULT ALLOW'
nsjail_args() {
  local t=$1
  echo -Mo -t 0 --log "/tmp/nsjail-$t.log" \
    --rlimit_as inf --rlimit_cpu inf --rlimit_fsize inf --rlimit_nofile 65536 --rlimit_nproc soft \
    $([ "${NET:-unshare}" = share ] && echo -N) $([ -n "${NOPROC:-}" ] && echo --disable_proc) \
    -R /usr -R /lib -R /bin -R /dev/null -R /dev/urandom -R /dev/random -R /etc/ssl -T /tmp \
    -B "$TENANTS/$t" --cwd "$TENANTS/$t"
}

unshare_inner() { # runs as root in a fresh mount ns: hide every other tenant, then drop
  local t=$1 mode=$2; shift 2
  mkdir -p /mnt/keep && mount --bind "$TENANTS/$t" /mnt/keep
  mount -t tmpfs -o mode=755 tmpfs "$TENANTS"
  mkdir "$TENANTS/$t" && mount --move /mnt/keep "$TENANTS/$t"
  if [ "$mode" = root ]; then priv_drop "$t" "$@"
  else exec setpriv --inh-caps=-all --bounding-set=-all --no-new-privs -- "$@"; fi  # userns: already uid t outside
}

wrap() { # wrap APPROACH TENANT CMD...
  local a=$1 t=$2; shift 2
  local u; u=$(uid_of "$t")
  local unet=; [ "${NET:-unshare}" = unshare ] && unet=--net
  local mproc=--mount-proc; [ -n "${NOPROC:-}" ] && mproc=
  case $a in
    none)           exec "$@" ;;
    setpriv)        priv_drop "$t" "$@" ;;
    unshare-root)   exec unshare --mount --pid --fork $mproc $unet --propagation private -- /sb/lib.sh unshare_inner "$t" root "$@" ;;
    unshare-userns) exec setpriv --reuid="$u" --regid="$u" --clear-groups -- \
                      unshare --user --map-root-user --mount --pid --fork $mproc $unet --propagation private -- /sb/lib.sh unshare_inner "$t" userns "$@" ;;
    bwrap)          uid_drop "$t" bwrap $(bwrap_args "$t") -- "$@" ;;
    bwrap-suid)     uid_drop "$t" /usr/local/bin/bwrap-suid $(bwrap_args "$t") -- "$@" ;;
    nsjail)         exec nsjail $(nsjail_args "$t") -u "$u:$u:1" -g "$u:$u:1" ${NSJ_SECCOMP:+--seccomp_string "$NSJ_POLICY"} -- "$@" ;;
    nsjail-nouserns) exec nsjail $(nsjail_args "$t") --disable_clone_newuser -u "$u:$u:1" -g "$u:$u:1" ${NSJ_SECCOMP:+--seccomp_string "$NSJ_POLICY"} -- "$@" ;;
    # no namespaces at all: nsjail as a setuid + seccomp + rlimit launcher (works under Docker's default profile)
    nsjail-nons)    exec nsjail -Mo -t 0 --log "/tmp/nsjail-$t.log" --rlimit_as inf --rlimit_cpu inf --rlimit_fsize inf --rlimit_nofile 65536 --rlimit_nproc soft \
                      --disable_clone_newns --disable_clone_newpid --disable_clone_newipc --disable_clone_newuts --disable_clone_newcgroup \
                      --disable_clone_newnet --disable_clone_newuser -u "$u" -g "$u" --cwd "$TENANTS/$t" --seccomp_string "$NSJ_POLICY" -- "$@" ;;
    nsjail-unpriv)  uid_drop "$t" nsjail $(nsjail_args "$t") ${NSJ_SECCOMP:+--seccomp_string "$NSJ_POLICY"} -- "$@" ;;
    *) echo "unknown approach $a" >&2; exit 2 ;;
  esac
}

# allow `lib.sh <fn> args...`
if [ "${BASH_SOURCE[0]}" = "$0" ] && [ $# -gt 0 ]; then "$@"; fi
