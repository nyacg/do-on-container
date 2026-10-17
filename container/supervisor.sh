#!/bin/sh
# PID 2 in the container (under tini). Runs workerd and does the housekeeping workerd can't:
#  - samples VM CPU / memory / inbound connections into /stats/proc.json (read by the router)
#  - pushes node stats to the Placement DO every STATS_EVERY seconds (via the bridge)
#  - asks the router to checkpoint dirty objects every CKPT_INTERVAL seconds
#  - on SIGTERM (rollout, scale-down, sleep): drain = checkpoint everything + close sockets
STATS_EVERY=${STATS_EVERY:-5}
CKPT_INTERVAL=${CKPT_INTERVAL:-30}
NODE_NAME=${NODE_NAME:-local}
export NODE_NAME
ulimit -n 65536 2>/dev/null || true
# Runtime state never survives a restart — but a filesystem snapshot (sleep/wake) or a reused
# disk would bring back stale sockets and markers: start clean.
rm -rf /run/spawnq /run/bridges /run/slots
mkdir -p /stats /data /data/tenants /run/spawnq /run/bridges
for i in $(seq 0 31); do mkdir -p /run/slots/$i; done

# Lower priority than this script, so stats keep flowing to Placement even when workerd
# saturates the CPU (a silent node looks dead).
nice -n 10 workerd serve /app/dist/workerd.capnp --experimental &
WPID=$!
# Tenant sandboxes connect to their bridge socket as their own uid.
( for i in $(seq 1 100); do [ -S /run/bridges/31.sock ] && break; sleep 0.05; done; chmod 666 /run/bridges/*.sock ) &
/app/spawner.sh > /stats/spawner.log 2>&1 &

drain() {
  echo "[supervisor] SIGTERM: draining"
  curl -sS -m 600 -X POST http://127.0.0.1:8080/__drain > /stats/drain.json
  cat /stats/drain.json; echo
  curl -s -m 10 -X POST --data-binary @/stats/drain.json http://bridge.internal/drained >/dev/null 2>&1
  kill -TERM $WPID 2>/dev/null
  wait $WPID
  exit 0
}
trap drain TERM INT

# Cloudflare sets CLOUDFLARE_* env vars (location, region, ...) in the container.
CFENV=$(env | grep -E '^CLOUDFLARE_[A-Z_]+=' | grep -v -E 'TOKEN|SECRET|KEY' | awk -F= '{v=substr($0, index($0,"=")+1); printf "%s\"%s\":\"%s\"", (NR>1?",":""), $1, v}')
prev=""
tick=0
while kill -0 $WPID 2>/dev/null; do
  cur=$(awk '/^cpu / {idle=$5+$6; tot=0; for(i=2;i<=NF;i++) tot+=$i; print tot, idle, $9}' /proc/stat)
  ncpu=$(nproc)
  if [ -n "$prev" ]; then
    cpu=$(echo "$prev $cur $ncpu" | awk '{dt=$4-$1; di=$5-$2; ds=$6-$3; if (dt>0) printf "%.3f %.3f", (dt-di)/dt*$7, ds/dt*$7; else print "0 0"}')
  else cpu="0 0"; fi
  prev=$cur
  set -- $cpu
  conns=$(cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '$2 ~ /:1F90$/ && $4 == "01" {n++} END {print n+0}')
  mem=$(awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {printf "\"memTotalKb\":%d,\"memUsedKb\":%d", t, t-a}' /proc/meminfo)
  rss=$(awk '/VmRSS/ {print $2}' /proc/$WPID/status 2>/dev/null)
  printf '{"cpuCores":%s,"cpuSteal":%s,"nproc":%s,"conns":%s,%s,"workerdRssKb":%s,"cf":{%s},"ts":%s}' \
    "$1" "$2" "$ncpu" "$conns" "$mem" "${rss:-0}" "$CFENV" "$(date +%s)" > /stats/proc.json.tmp && mv /stats/proc.json.tmp /stats/proc.json

  tick=$((tick + 1))
  if [ $((tick % STATS_EVERY)) -eq 0 ]; then
    (curl -s -m 3 http://127.0.0.1:8080/__stats | curl -s -m 3 -X POST --data-binary @- http://bridge.internal/stats >/dev/null 2>&1 &)
  fi
  if [ $((tick % CKPT_INTERVAL)) -eq 0 ]; then
    (curl -s -m 120 -X POST http://127.0.0.1:8080/__flush > /stats/flush.json 2>&1 &)
  fi
  sleep 1 & wait $!
done
echo "[supervisor] workerd exited"
