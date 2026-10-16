#!/bin/sh
# Starts sandboxed tenant processes on request from the router (container/tenants.ts).
#
# The router writes /run/spawnq/<slot> containing the app id; we start that app's own workerd:
#   - as uid 20000+slot (setpriv), no capabilities, no new privileges
#   - inside bwrap with new user/mount/pid/net/ipc/uts/cgroup namespaces: the filesystem is the
#     read-only system dirs + the bundle, plus ONLY /data/tenants/<app> (as /data) and its slot
#     dir; no network at all — its only egress is /run/bridge.sock (the router's TenantBridge)
# and mark /run/slots/<slot>/ready once its http.sock is up.
#
# `probe <slot>` requests run a shell probe in the same sandbox (isolation tests).
Q=/run/spawnq

sandbox() { # sandbox <slot> <app> <cmd...>
  slot=$1; app=$2; shift 2
  uid=$((20000 + slot))
  setpriv --reuid "$uid" --regid "$uid" --clear-groups --inh-caps=-all --no-new-privs -- \
    bwrap --unshare-all --die-with-parent --new-session \
      --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
      $( [ -d /lib64 ] && echo --ro-bind /lib64 /lib64 ) \
      --ro-bind /etc/ssl /etc/ssl --ro-bind /etc/ca-certificates /etc/ca-certificates \
      --ro-bind /app/dist /app \
      --bind "/data/tenants/$app" /data \
      --bind "/run/slots/$slot" /run/slot \
      --bind "/run/bridges/$slot.sock" /run/bridge.sock \
      --dev /dev --tmpfs /tmp \
      --setenv NODE_NAME "${NODE_NAME:-local}--t--$app" --setenv TENANT "$app" \
      "$@"
}

start_tenant() { # start_tenant <slot> <app>
  slot=$1; app=$2; uid=$((20000 + slot))
  mkdir -p "/data/tenants/$app" "/run/slots/$slot"
  chown "$uid:$uid" "/data/tenants/$app" "/run/slots/$slot"
  chmod 700 "/data/tenants/$app" "/run/slots/$slot"
  rm -f "/run/slots/$slot/http.sock" "/run/slots/$slot/ready"
  sandbox "$slot" "$app" /usr/local/bin/workerd serve /app/tenant.capnp --experimental \
    > "/stats/tenant-$slot.log" 2>&1 &
  i=0
  while [ ! -S "/run/slots/$slot/http.sock" ] && [ $i -lt 200 ]; do sleep 0.025; i=$((i + 1)); done
  : > "/run/slots/$slot/ready"
  chmod 644 "/run/slots/$slot/ready"
  echo "[spawner] tenant $app on slot $slot ($((i * 25))ms)"
}

probe() { # probe <slot> <app> → /run/slots/<slot>/probe.txt
  slot=$1; app=$2
  sandbox "$slot" "$app" /bin/sh -c '
    echo "id: $(id)"
    echo "ls /data/tenants: $(ls /data/tenants 2>&1 | head -1)"
    echo "own data: $(ls /data | head -3 | tr "\n" " ")"
    echo "other slot: $(ls /run/slots 2>&1 | head -1)"
    echo "router admin: $(curl -s -m 2 http://127.0.0.1:8080/__stats 2>&1 | head -c 80 || echo unreachable)"
    echo "internet: $(curl -s -m 3 -o /dev/null -w %{http_code} https://example.com 2>&1 | head -c 80)"
    echo "write /usr: $(touch /usr/x 2>&1 | head -c 60)"
    echo "processes: $(ls /proc 2>/dev/null | grep -c "^[0-9]") visible"
    echo "bridge own manifest: $(curl -s -m 3 -o /dev/null -w %{http_code} --unix-socket /run/bridge.sock "http://bridge.internal/blob/manifest/${NODE_NAME}")"
    echo "bridge other tenant: $(curl -s -m 3 -w " %{http_code}" --unix-socket /run/bridge.sock "http://bridge.internal/blob/manifest/${NODE_NAME%%--t--*}--t--conf" | tail -c 60)"
    echo "bridge stats/drain: $(curl -s -m 3 -o /dev/null -w %{http_code} --unix-socket /run/bridge.sock -X POST http://bridge.internal/drained)"
  ' > "/run/slots/$slot/probe.out" 2>&1
  mv "/run/slots/$slot/probe.out" "/run/slots/$slot/probe.txt"
  chmod 644 "/run/slots/$slot/probe.txt"
}

while true; do
  for f in "$Q"/*; do
    [ -f "$f" ] || continue
    slot=$(basename "$f")
    req=$(cat "$f"); rm -f "$f"
    case "$req" in
      probe:*) probe "$slot" "${req#probe:}" & ;;
      *) start_tenant "$slot" "$req" & ;;
    esac
  done
  sleep 0.05
done
