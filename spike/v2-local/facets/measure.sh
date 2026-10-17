#!/bin/sh
# Usage: measure.sh <container> <port>. Prints RSS (RssAnon) after each step of loader tests.
C=${1:-v2-facets}; B=localhost:${2:-18783}
rss() { docker exec $C sh -c 'awk "/VmRSS|RssAnon/ {printf \"%s=%sMB \", \$1, int(\$2/1024)}" /proc/1/status'; echo; }
echo "baseline: $(rss)"
curl -s $B/t/m1/v1/hit >/dev/null; echo "1 runner+facet: $(rss)"
for spec in "1 a" "10 b" "100 c"; do set -- $spec
  echo "named load n=$1: $(curl -s "$B/load?n=$1&prefix=$2")"; echo "   -> $(rss)"; done
echo "named reload n=100 (cached): $(curl -s "$B/load?n=100&prefix=c")"; echo "   -> $(rss)"
