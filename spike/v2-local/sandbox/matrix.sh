#!/bin/bash
# Host-side driver: run run-tests.sh (and probe.sh) under each docker security mode. Output -> results/.
set -u
cd "$(dirname "$0")"; mkdir -p results
MODES='a-default|
b-apparmor-unconfined|--security-opt apparmor=unconfined
c-seccomp-unconfined|--security-opt seccomp=unconfined
d-cap-sys-admin|--cap-add SYS_ADMIN
e-sysadmin+seccomp-unconf|--cap-add SYS_ADMIN --security-opt seccomp=unconfined
f-seccomp-unconf+systempaths|--security-opt seccomp=unconfined --security-opt systempaths=unconfined
g-sysadmin+seccomp+aa+systempaths|--cap-add SYS_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined
h-privileged|--privileged'
echo "$MODES" | while IFS='|' read -r m flags; do
  [ -n "${ONLY:-}" ] && [[ "$m" != $ONLY ]] && continue
  echo "##### $m: docker run $flags"
  docker rm -f v2sb-matrix >/dev/null 2>&1
  docker run --rm --name v2sb-matrix $flags v2sb-img bash -c '/sb/run-tests.sh; echo; echo "## NET=share"; NET=share /sb/run-tests.sh bwrap nsjail unshare-root; echo; echo "## NSJ_SECCOMP=1"; NSJ_SECCOMP=1 /sb/run-tests.sh nsjail nsjail-unpriv' > "results/run-$m.txt" 2>&1 </dev/null
  docker run --rm --name v2sb-matrix $flags v2sb-img /sb/probe.sh > "results/probe-$m.txt" 2>&1 </dev/null
  grep -E '^(-- |   \[.*\] workerd|##)' "results/run-$m.txt" | sed -E 's/(workerd (OK|FAILED)[^:]{0,40}).*/\1/' | cut -c1-200
done
