#!/bin/bash
# Memory/startup of N sandboxed workerd processes (one tiny SQLite DO each).
# usage: measure.sh APPROACH N     (needs CAP_SYS_PTRACE to read other uids' smaps_rollup)
set -u
. /sb/lib.sh
A=$1; N=$2; export NET=${NET:-unshare}
now_ms() { date +%s%3N; }
kb() { awk -v k="$1:" '$1==k {print $2}' "$2" 2>/dev/null; }
rm -rf "$TENANTS"; mkdir -p "$TENANTS"
sync; echo 1 > /proc/sys/vm/drop_caches 2>/dev/null
cg0=$(cat /sys/fs/cgroup/memory.current)
starts=
for i in $(seq 1 "$N"); do
  t=t$i; setup_tenant $t "unix:$TENANTS/$t/run/http.sock"
  t0=$(now_ms)
  /sb/lib.sh wrap "$A" $t /usr/local/bin/workerd serve "$TENANTS/$t/config.capnp" --experimental >/tmp/wd-$t.log 2>&1 &
  until curl -sf -m 1 --unix-socket "$TENANTS/$t/run/http.sock" "http://$t/?name=a" >/dev/null 2>&1; do sleep 0.005; done
  starts="$starts $(( $(now_ms) - t0 ))ms"
  for _ in 1 2 3; do curl -s --unix-socket "$TENANTS/$t/run/http.sock" "http://$t/?name=a" >/dev/null; done
done
sleep 3
cg1=$(cat /sys/fs/cgroup/memory.current)
echo "approach=$A N=$N first-request latency per instance:$starts"
printf '%-8s %-6s %-7s %9s %9s %9s %9s %9s %9s\n' comm user pid VmRSS RssAnon RssFile Pss Pss_Anon Pss_File
tot_rss=0; tot_pss=0
for pid in $(ps -eo pid=,comm= | awk '$2 ~ /^(workerd|bwrap|nsjail|unshare)$/ {print $1}'); do
  s=/proc/$pid/status; r=/proc/$pid/smaps_rollup
  rss=$(kb VmRSS $s); pss=$(kb Pss $r)
  printf '%-8s %-6s %-7s %9s %9s %9s %9s %9s %9s\n' "$(cat /proc/$pid/comm)" "$(ps -o user= -p $pid)" $pid "$rss" "$(kb RssAnon $s)" "$(kb RssFile $s)" "${pss:-EPERM}" "$(kb Pss_Anon $r)" "$(kb Pss_File $r)"
  tot_rss=$((tot_rss + ${rss:-0})); tot_pss=$((tot_pss + ${pss:-0}))
done
echo "TOTAL kB: VmRSS=$tot_rss PSS=$tot_pss  cgroup memory.current delta=$(( (cg1 - cg0) / 1024 )) kB"
pkill -x workerd; pkill -x nsjail; pkill -x bwrap; sleep 0.2
