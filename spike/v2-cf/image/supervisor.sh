#!/bin/sh
# Starts workerd, publishes VM CPU/memory stats to /stats/proc.json every second.
# (Cloudflare Containers run as VMs: no cgroup files, so we read /proc/stat and /proc/meminfo.)
mkdir -p /stats /data
workerd serve /app/config.docker.capnp --experimental &
WPID=$!
trap 'kill -TERM $WPID; wait $WPID; exit 0' TERM INT
CFENV=$(env | grep -E '^CLOUDFLARE_(LOCATION|REGION|NODE_ID)=' | awk -F= '{printf "%s\"%s\":\"%s\"", (NR>1?",":""), $1, $2}')
(bash /app/probe.sh > /stats/probe.txt 2>&1 &)
prev=""
while kill -0 $WPID 2>/dev/null; do
  cur=$(awk '/^cpu / {idle=$5+$6; tot=0; for(i=2;i<=NF;i++) tot+=$i; print tot, idle}' /proc/stat)
  ncpu=$(nproc)
  if [ -n "$prev" ]; then
    cpu=$(echo "$prev $cur $ncpu" | awk '{dt=$3-$1; di=$4-$2; if (dt>0) printf "%.3f", (dt-di)/dt*$5; else print 0}')
  else cpu=0; fi
  prev=$cur
  mem=$(awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {printf "{\"totalKb\":%d,\"usedKb\":%d}", t, t-a}' /proc/meminfo)
  rss=$(awk '/VmRSS/ {print $2}' /proc/$WPID/status 2>/dev/null || echo 0)
  printf '{"cpuCores":%s,"mem":%s,"workerdRssKb":%s,"nproc":%s,"cf":{%s},"ts":%s}' "$cpu" "$mem" "${rss:-0}" "$ncpu" "$CFENV" "$(date +%s)" > /stats/proc.json.tmp && mv /stats/proc.json.tmp /stats/proc.json
  sleep 1 & wait $!
done
