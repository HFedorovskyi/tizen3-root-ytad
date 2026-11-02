#!/bin/sh
# ytad boot hook - runs as root from rootd ($BASE/hooks/*.sh).
# Pins YouTube DNS to loopback, mounts the MITM trust bundles, starts the
# dnsd/srv supervisors, installs the DNS redirect, then restarts YouTube if it
# was already running before the stack was ready.
BASE=/opt/usr/home/owner
Y=$BASE/ytad
LOG=/tmp/hooks.log
YT=9Ur5IzDKqV.TizenYouTube
IPT=/usr/sbin/iptables

say() { echo "$(date +%s) ytad: $*" >> "$LOG"; }

bind() {
  [ -f "$1" ] || return 0
  [ -e "$2" ] || return 0
  grep -q " $2 " /proc/mounts && return 0
  mount --bind "$1" "$2" 2>/dev/null && say "bind $2"
}

[ -d "$Y" ] || { say "missing $Y"; exit 1; }
say start

# 1. resolv.conf: first nameserver = gateway (redirected to dnsd below), second = fallback
GW=$(node -e '
var fs=require("fs"),l=fs.readFileSync("/proc/net/route","utf8").split("\n");
for(var i=1;i<l.length;i++){var p=l[i].trim().split(/\s+/);
if(p[1]==="00000000"&&p[2]!=="00000000"){var h=parseInt(p[2],16);
console.log([h&255,(h>>8)&255,(h>>16)&255,(h>>24)&255].join("."));break;}}' 2>/dev/null)
[ -n "$GW" ] || GW=8.8.8.8
printf 'nameserver %s\nnameserver 8.8.8.8\n' "$GW" > "$Y/resolv.conf.new" && mv "$Y/resolv.conf.new" "$Y/resolv.conf"

# 2. pin the youtube hosts in /etc/hosts before anything can resolve them
bind "$Y/hosts" /etc/hosts
bind "$Y/resolv.conf" /etc/resolv.conf
bind "$Y/resolv.conf" /opt/etc/resolv.conf

# 3. web engine trust: extra bundles + the CA the CaBox imports on its own
bind "$Y/tls/webapp_mitm.pem" /usr/share/cert/webapp.pem
bind "$Y/tls/ca_plus.pem" /usr/share/cert/ca.pem
bind "$Y/tls/webbrowser_plus.pem" /usr/share/cert/webbrowser.pem
mkdir -p "$BASE/share/xwalk_cert" 2>/dev/null
[ -f "$BASE/share/xwalk_cert/phantom_ca.pem" ] || cp "$Y/tls/ca.pem" "$BASE/share/xwalk_cert/phantom_ca.pem" 2>/dev/null

# 4. daemons (respawn loops)
if ! ps -ef | grep -q '[d]nsd\.js'; then
  ( while true; do node -e "eval(require('fs').readFileSync('$Y/dnsd.js','utf8'))" >>/tmp/dnsd.err 2>&1; sleep 1; done & )
  say "start dnsd"
fi
if ! ps -ef | grep -q '[s]rv\.js'; then
  ( while true; do node -e "eval(require('fs').readFileSync('$Y/srv.js','utf8'))" >>/tmp/tlssrv.err 2>&1; sleep 2; done & )
  say "start srv"
fi

# 5. redirect the resolver at dnsd (the app sdk has its own resolver, hosts alone is not enough)
$IPT -t nat -C OUTPUT -p udp -d "$GW" --dport 53 -j DNAT --to-destination 127.0.0.1:53 2>/dev/null || \
  $IPT -t nat -A OUTPUT -p udp -d "$GW" --dport 53 -j DNAT --to-destination 127.0.0.1:53 2>/dev/null
# drop stale redirects to other gateways after a network change
for r in $($IPT -t nat -S OUTPUT 2>/dev/null | grep -- '--dport 53' | grep -v -- "-d $GW " | grep -o '\-d [0-9.]*'); do
  set -- $r
  $IPT -t nat -D OUTPUT -p udp -d "$2" --dport 53 -j DNAT --to-destination 127.0.0.1:53 2>/dev/null
done

# 5a. legacy pin: a hosts file that maps the youtube names to the fake 203.0.113.7
$IPT -t nat -C OUTPUT -p tcp -d 203.0.113.7 --dport 443 -j DNAT --to-destination 127.0.0.1:443 2>/dev/null || \
  $IPT -t nat -A OUTPUT -p tcp -d 203.0.113.7 --dport 443 -j DNAT --to-destination 127.0.0.1:443 2>/dev/null

# 5b. kill QUIC. Chromium picks up alt-svc from the proxied responses and then
# opens HTTP/3 straight to Google, bypassing this MITM (ads come back). srv.js
# strips alt-svc, but a cached entry or a hardcoded endpoint still tries UDP 443.
$IPT -C OUTPUT -p udp --dport 443 -j DROP 2>/dev/null || $IPT -I OUTPUT 1 -p udp --dport 443 -j DROP 2>/dev/null
$IPT -C OUTPUT -p udp --dport 80 -j DROP 2>/dev/null || $IPT -I OUTPUT 2 -p udp --dport 80 -j DROP 2>/dev/null
say "quic off"

# 6. wait for the proxy listener, then restart an instance that predates it
n=0
while [ $n -lt 30 ] && ! grep -q "0100007F:01BB 00000000:0000 0A" /proc/net/tcp; do
  sleep 1; n=$((n + 1))
done
say "listener t=${n}s"

pids=$(ps -ef | grep "[a]pps_rw/9Ur5IzDKqV" | awk '{print $2}')
if [ -n "$pids" ]; then
  say "restart yt $pids"
  for p in $pids; do kill -9 "$p" 2>/dev/null; done
  sleep 2
  /usr/bin/app_launcher -s "$YT" >> "$LOG" 2>&1
fi
say done
