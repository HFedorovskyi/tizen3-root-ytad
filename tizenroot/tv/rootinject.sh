#!/bin/sh
# root re-injection watchdog. runs as owner (uid 5001) under systemd --user forever.
# rootd bumps $BASE/rootd.beat every 10s. A pid file that points at nothing, or a
# beat that has not moved for ~35s, means rootd is gone and gets re-injected.
BASE=/opt/usr/home/owner
LOG=$BASE/rootinject.log
HB=$BASE/rootd.beat

echo "watchdog start pid=$$" >> "$LOG"
[ -e "$HB" ] || { echo 0 > "$HB"; chsmack -a User "$HB" 2>/dev/null; }
echo $$ > "$BASE/rootinject.pid"

# the only call that still spawns uid 0: jpmsd's ExecuteUserShell from the "User"
# context (this watchdog). From the appcmd shell the same call is a no-op.
inject() {
  C=$(printf "\072")
  busctl call com.jackpack.migration /com/jackpack/migration com.jackpack.migration ExecuteUserShell s "0${C}/bin/sh < $BASE/rootd.sh >/dev/null 2>&1 &" >/dev/null 2>&1
  i=0
  while [ $i -lt 15 ]; do
    p=$(cat /tmp/rootd.pid 2>/dev/null)
    [ -n "$p" ] && [ -d "/proc/$p" ] && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

alive() {
  p=$(cat /tmp/rootd.pid 2>/dev/null)
  [ -n "$p" ] && [ -d "/proc/$p" ]
}

# /tmp is tmpfs: missing pid file means the first watchdog run after boot.
if ! alive; then
  if inject; then echo "inject boot" >> "$LOG"; else echo "inject boot failed" >> "$LOG"; fi
fi

last=""
lastchg=$(date +%s)
while true; do
  now=$(date +%s)
  v=$(cat "$HB" 2>/dev/null)
  if [ -n "$v" ] && [ "$v" != "$last" ]; then last="$v"; lastchg=$now; fi
  if ! alive; then
    if inject; then echo "inject pid gone" >> "$LOG"; else echo "inject failed pid gone" >> "$LOG"; fi
    lastchg=$(date +%s)
  elif [ $((now - lastchg)) -ge 35 ]; then
    if inject; then echo "inject beat=$v stale" >> "$LOG"; else echo "inject failed beat=$v stale" >> "$LOG"; fi
    lastchg=$(date +%s)
  fi
  sleep 10
done
