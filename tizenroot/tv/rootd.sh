#!/bin/sh
# root job runner. started as uid 0 by the boot watchdog.
# jobs: script pushed to /tmp/root.cmd whose last line is "#END"; output: /tmp/root.out.
# boot hooks: every executable */sh under $BASE/hooks runs in the background on start.
BASE=/opt/usr/home/owner
OUT=/tmp/root.out
CMD=/tmp/root.cmd
JOB=/tmp/root.job
HB=$BASE/rootd.beat

if [ -e /tmp/rootd.pid ]; then
  op=$(cat /tmp/rootd.pid 2>/dev/null)
  if [ -n "$op" ] && kill -0 "$op" 2>/dev/null; then exit 0; fi
fi
echo $$ > /tmp/rootd.pid

# hooks go in through stdin: on this firmware `sh /opt/.../script` (path under
# $BASE as an argument) hangs the shell in a kernel wait, while `sh < script` works
if [ -d "$BASE/hooks" ]; then
  ( for h in "$BASE"/hooks/*.sh; do [ -f "$h" ] && sh < "$h"; done ) >> /tmp/hooks.log 2>&1 &
fi

echo "=== rootd up pid=$$ ===" >> "$OUT"
n=0
while true; do
  if [ -s "$CMD" ] && [ "$(tail -1 "$CMD" 2>/dev/null)" = "#END" ]; then
    mv "$CMD" "$JOB" 2>/dev/null
    echo "=== job ===" >> "$OUT"
    ( /bin/sh < "$JOB" >> "$OUT" 2>&1; echo "__rc=$?" >> "$OUT" ) &
  fi
  n=$((n + 1))
  if [ $((n % 10)) -eq 0 ] && [ -e "$HB" ]; then echo "$n" > "$HB"; fi
  sleep 1
done
