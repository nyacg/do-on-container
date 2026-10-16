#!/bin/bash
# Run every sandbox approach in this container and report what works.
# usage: run-tests.sh [approach...]     env: NET=share|unshare, NSJ_SECCOMP=1
set -u
. /sb/lib.sh
APPROACHES=${*:-none setpriv unshare-root unshare-userns bwrap bwrap-suid nsjail nsjail-nouserns nsjail-unpriv}
NET=${NET:-unshare}; export NET
now_ms() { date +%s%3N; }

echo "== outer ns(mnt,net,user,pid)=$(readlink /proc/self/ns/mnt /proc/self/ns/net /proc/self/ns/user /proc/self/ns/pid | tr -dc '0-9\n' | tr '\n' ',')"
echo "== container: $(grep -E '^(CapEff|Seccomp|NoNewPrivs):' /proc/self/status | tr -s '\t\n' '  ') userns_max=$(cat /proc/sys/user/max_user_namespaces) NET=$NET NSJ_SECCOMP=${NSJ_SECCOMP:-0}"
for a in $APPROACHES; do
  rm -rf "$TENANTS"; mkdir -p "$TENANTS"; chmod 755 "$TENANTS"
  if [ "$NET" = share ]; then addr1="*:8101"; else addr1="unix:$TENANTS/t1/run/http.sock"; fi
  setup_tenant t1 "$addr1"; setup_tenant t2 "unix:$TENANTS/t2/run/http.sock"

  # 1) shell escape probe inside the sandbox
  shell=$(timeout 10 /sb/lib.sh wrap "$a" t1 /bin/sh -c '
      echo "uid=$(id -u) cat_t2=[$(cat /tenants/t2/secret 2>&1 | head -c 80)] own=[$(cat /tenants/t1/secret 2>&1)] ls_tenants=[$(ls /tenants 2>&1 | tr "\n" " ")] root=[$(ls / | tr "\n" " ")] pids_visible=$(ls /proc 2>/dev/null | grep -c "^[0-9]") ns=$(readlink /proc/self/ns/mnt /proc/self/ns/net /proc/self/ns/user /proc/self/ns/pid 2>&1| tr -dc "0-9\n" | tr "\n" ",")"' 2>&1 | tail -3 | tr '\n' ' ')
  echo "-- [$a] shell: $shell"

  # 2) workerd under the sandbox
  log=/tmp/wd-$a.log
  t0=$(now_ms)
  /sb/lib.sh wrap "$a" t1 /usr/local/bin/workerd serve "$TENANTS/t1/config.capnp" --experimental >"$log" 2>&1 &
  wpid=$!
  if [ "$NET" = share ]; then C=(curl -s -m 2 http://127.0.0.1:8101); else C=(curl -s -m 2 --unix-socket "$TENANTS/t1/run/http.sock" http://t1); fi
  ok=; for _ in $(seq 1 500); do
    r=$("${C[@]}/?name=a" 2>/dev/null) && [ -n "$r" ] && { ok=1; break; }
    kill -0 $wpid 2>/dev/null || break; sleep 0.01
  done
  t1=$(now_ms)
  if [ -n "$ok" ]; then
    "${C[@]}/?name=a" >/dev/null; r=$("${C[@]}/?name=a")
    pid=$(pgrep -n -x workerd)
    st=$(grep -E '^(Uid|NSpid|Seccomp|CapEff|NoNewPrivs):' /proc/$pid/status | awk '{print $1$2 ($3?","$3:"")}' | tr '\n' ' ')
    nscmp() { local x; x=$(readlink /proc/$pid/ns/$1 2>/dev/null) || { echo "EPERM(no CAP_SYS_PTRACE)"; return; }; [ "$x" = "$(readlink /proc/self/ns/$1)" ] && echo shared || echo own; }
    mnt=$(nscmp mnt); net=$(nscmp net); usr=$(nscmp user)
    tree=$(ps -eo user=,rss=,comm= | awk '$3 ~ /workerd|bwrap|nsjail|unshare|setpriv|lib.sh/ {print $3"/"$1"/rss="$2"k"}' | tr '\n' ' ')
    rd2=$("${C[@]}/read?p=/tenants/t2/secret" | tr '\n' ' ' | head -c 120)
    rd1=$("${C[@]}/read?p=/tenants/t1/secret" | tr '\n' ' ' | head -c 80)
    rdr=$("${C[@]}/read?p=/" | tr '\n' ' ' | head -c 200)
    echo "   [$a] workerd OK first_req=$((t1-t0))ms resp=$r $st mntns=$mnt netns=$net userns=$usr wrapper=[$tree]"
    echo "   [$a] disk-escape t2: $rd2"
    echo "   [$a] disk own t1:    $rd1"
    echo "   [$a] disk ls /:      $rdr"
  else
    echo "   [$a] workerd FAILED after $((t1-t0))ms: $(tail -5 "$log" | tr '\n' ' ' | head -c 600)"
    [ -f /tmp/nsjail-t1.log ] && echo "   [$a] nsjail log: $(grep -E '\[(E|F|W)\]' /tmp/nsjail-t1.log | tail -4 | tr '\n' ' ' | head -c 600)"
  fi
  kill $wpid 2>/dev/null; pkill -x workerd 2>/dev/null; pkill -x nsjail 2>/dev/null; pkill -x bwrap 2>/dev/null; sleep 0.2
  rm -f /tmp/nsjail-t1.log
done
