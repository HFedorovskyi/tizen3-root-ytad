#!/usr/bin/env node
'use strict';
// ytadpatch - YouTube ad patcher for Tizen 3.0 TVs.
//
// Deploys a boot hook into tizenroot's rootd: DNS pinning (hosts + dnsd),
// a TLS MITM for the YouTube hosts (ad JSON stripped, player request rewritten
// to a WEB client, "onesie" initplayback redirect blocked), and a precise
// restart of an instance that started before the stack was ready.
//
// The CA and leaf are generated per installation (certs/make_certs.sh) and the
// three trust bundles are built on the TV from its stock bundles plus that CA.
// Nothing secret is distributed; after a fresh install the CA must be trusted by
// the TV (CaBox imports $BASE/share/xwalk_cert/phantom_ca.pem).
//
// Requires tizenroot:  node ../tizenroot/tizenroot.js install
//
// Commands: install | start | uninstall [--purge] | status | logs [n]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TR_PATH = process.env.TIZENROOT || path.join(__dirname, '..', 'tizenroot', 'tizenroot.js');
let tr;
try { tr = require(TR_PATH); } catch (e) {
  console.error('error: tizenroot not found at ' + TR_PATH + ' (set TIZENROOT)');
  process.exit(1);
}

const BASE = tr.BASE;
const Y = BASE + '/ytad';
const HOOK = BASE + '/hooks/10-ytad.sh';
const TLS = path.join(__dirname, 'tv', 'tls');

const die = (m) => { console.error('error: ' + m); process.exit(1); };
const sh = tr.sh;

// The CA/leaf are per installation (the repo carries no keys). Generate them on
// the host once, then every TV build derives its trust bundles from them.
function ensureCerts() {
  fs.mkdirSync(TLS, { recursive: true });
  const have = ['ca.pem', 'leaf.pem', 'leaf.key'].every((f) => fs.existsSync(path.join(TLS, f)));
  if (have) return;
  console.log('no local certs: generating a CA and a leaf (certs/make_certs.sh)');
  const r = spawnSync('sh', [path.join(__dirname, 'certs', 'make_certs.sh')], { stdio: 'inherit' });
  if (r.status !== 0) die('certificate generation failed (openssl required in PATH)');
}

function files() {
  const list = [
    ['tv/hosts', Y + '/hosts', '644'],
    ['tv/hijack', Y + '/hijack', '644'],
    ['tv/dnsd.js', Y + '/dnsd.js', '644'],
    ['tv/srv.js', Y + '/srv.js', '644'],
    ['tv/tls/ca.pem', Y + '/tls/ca.pem', '644'],
    ['tv/tls/leaf.pem', Y + '/tls/leaf.pem', '644'],
    ['tv/tls/leaf.key', Y + '/tls/leaf.key', '600'],
    ['tv/10-ytad.sh', HOOK, '755'],
  ];
  for (const f of list) {
    if (!fs.existsSync(path.join(__dirname, f[0]))) die('package file missing: ' + f[0]);
  }
  return list;
}

async function rootdAlive() {
  const r = await sh('p=$(cat /tmp/rootd.pid 2>/dev/null); [ -n "$p" ] && [ -d /proc/$p ] && echo yes');
  return /yes/.test(r.out);
}

async function install() {
  await tr.ensureDevice();
  if (!(await rootdAlive())) die('rootd is not running - install the injector first: node ../tizenroot/tizenroot.js install');
  ensureCerts();

  const mk = await sh(`mkdir -p ${Y}/tls ${BASE}/hooks`);
  if (mk.code !== 0) die('cannot create ' + Y + ': ' + mk.out.trim());

  for (const [src, remote, mode] of files()) {
    const n = await tr.pushIfChanged(path.join(__dirname, src), remote, mode);
    console.log(n < 0 ? `${src} -> ${remote} (unchanged)` : `${src} -> ${remote} (${n} B)`);
  }

  // Trust bundles are derived, never distributed: stock Samsung bundle + our CA,
  // built on the TV. If our bundle is already mounted over the stock file, the
  // umount exposes the real one; the inode guard refuses to self-append.
  const trust = await tr.job(`
mkdir -p ${Y}/tls ${BASE}/share/xwalk_cert
ca=${Y}/tls/ca.pem
mark=$(sed -n '2p' "$ca")
for pair in webapp:webapp_mitm.pem ca:ca_plus.pem webbrowser:webbrowser_plus.pem; do
  src=/usr/share/cert/$(echo "$pair" | cut -d: -f1).pem
  dst=${Y}/tls/$(echo "$pair" | cut -d: -f2)
  if [ -f "$dst" ] && grep -qF "$mark" "$dst"; then echo "bundle $(basename "$dst") keep"; continue; fi
  umount "$src" 2>/dev/null
  if [ ! -f "$src" ]; then echo "bundle $(basename "$dst") MISSING $src"; continue; fi
  if [ "$(stat -c %d:%i "$src")" = "$(stat -c %d:%i "$dst")" ]; then echo "bundle $(basename "$dst") BUSY"; continue; fi
  cp "$src" "$dst" && cat "$ca" >> "$dst" && echo "bundle $(basename "$dst") built $(wc -c < "$dst") B"
done
a=$(md5sum "$ca" | awk '{print $1}')
b=$(md5sum ${BASE}/share/xwalk_cert/phantom_ca.pem 2>/dev/null | awk '{print $1}')
[ "$a" = "$b" ] || cp "$ca" ${BASE}/share/xwalk_cert/phantom_ca.pem
echo "ca $a"
`, 60000);
  console.log(trust.trim());

  // kill a legacy stack (paths from the pre-package deployment); the hook respawns from $Y
  await tr.job(`
for p in $(ps -ef | awk '/[s]rv\\.js|[d]nsd\\.js/{print $2}'); do
  pp=$(awk '/^PPid:/{print $2}' /proc/$p/status 2>/dev/null)
  kill -9 $p 2>/dev/null
  cl=$(tr '\\0' ' ' < /proc/$pp/cmdline 2>/dev/null)
  case "$cl" in /bin/sh*) kill -9 $pp 2>/dev/null;; esac
done
echo legacy-clean
`);

  await sh(`[ -e ${Y}/block_onesie ] || > ${Y}/block_onesie`);
  // the hook needs root: mounts, iptables, process restarts. It is fed through
  // stdin: `sh /opt/.../hook.sh` hangs this firmware's shell.
  const out = await tr.job(`sh < ${HOOK}\necho hook-done`, 120000);
  console.log(out.trim().split('\n').slice(-3).join('\n'));

  const caLocal = require('crypto').createHash('md5')
    .update(fs.readFileSync(path.join(__dirname, 'tv/tls/ca.pem'))).digest('hex');
  const caTv = await sh(`md5sum ${BASE}/share/xwalk_cert/phantom_ca.pem 2>/dev/null | awk '{print $1}'`);
  const same = caTv.out.trim() === caLocal;
  console.log('CA (PhantomTV Root CA) ' + caLocal + (same ? ' - matches the installed trust file' : ' - DIFFERS from the TV copy'));
  console.log('the CaBox imports ' + BASE + '/share/xwalk_cert/phantom_ca.pem itself;');
  console.log('if the app answers alert 48 unknown_ca, re-import that file through CaBox and relaunch YouTube.');
  console.log('hook started; watch it with: node ytadpatch.js status');
}

async function uninstall(purge) {
  await tr.ensureDevice();
  if (await rootdAlive()) {
    await tr.job(`
for p in $(ps -ef | awk '/[s]rv\\.js|[d]nsd\\.js/{print $2}'); do
  pp=$(awk '/^PPid:/{print $2}' /proc/$p/status 2>/dev/null)
  kill -9 $p 2>/dev/null
  cl=$(tr '\\0' ' ' < /proc/$pp/cmdline 2>/dev/null)
  case "$cl" in /bin/sh*) kill -9 $pp 2>/dev/null;; esac
done
for r in $(iptables -t nat -S OUTPUT 2>/dev/null | grep -- '--dport 53' | grep -o '\\-d [0-9.]*'); do
  set -- $r
  iptables -t nat -D OUTPUT -p udp -d "$2" --dport 53 -j DNAT --to-destination 127.0.0.1:53 2>/dev/null
done
iptables -t nat -D OUTPUT -p tcp -d 203.0.113.7 --dport 443 -j DNAT --to-destination 127.0.0.1:443 2>/dev/null
iptables -D OUTPUT -p udp --dport 443 -j DROP 2>/dev/null
iptables -D OUTPUT -p udp --dport 80 -j DROP 2>/dev/null
umount /usr/share/cert/webapp.pem 2>/dev/null
umount /usr/share/cert/ca.pem 2>/dev/null
umount /usr/share/cert/webbrowser.pem 2>/dev/null
umount /etc/hosts 2>/dev/null
umount /etc/resolv.conf 2>/dev/null
umount /opt/etc/resolv.conf 2>/dev/null
echo uninstalled
`);
  }
  await sh(`rm -f ${HOOK}`);
  if (purge) await sh(`rm -rf ${Y}`);
  console.log('hook removed, proxy/dnsd stopped, mounts released' + (purge ? ', ' + Y + ' deleted' : ''));
}

async function status() {
  await tr.ensureDevice();
  const q = `
echo "=== mounts ==="
grep -E " /etc/hosts | /etc/resolv.conf | /opt/etc/resolv.conf | /usr/share/cert/(webapp|ca|webbrowser)\\.pem " /proc/mounts | awk '{print $1" -> "$2}'
echo "=== procs ==="
ps -ef | awk '/[s]rv\\.js|[d]nsd\\.js/{print $2" "$8" "$9" "$10}'
echo "=== iptables ==="
iptables -t nat -S OUTPUT 2>/dev/null | grep -- '--dport 53'
echo "=== flags ==="
ls -l ${Y}/block_onesie 2>&1
echo "=== hooks log ==="
tail -5 /tmp/hooks.log 2>/dev/null
echo "=== proxy tail ==="
grep -c 'TLS_OK' /tmp/tlssrv.log 2>/dev/null | sed 's/^/TLS_OK /'
grep -E 'BLOCK_ONESIE|adrm=|ADK ' /tmp/tlssrv.log 2>/dev/null | tail -6
echo "=== dns tail ==="
grep -E 'HIJACK|BLOCK' /tmp/dnsd.log 2>/dev/null | tail -4
`;
  const root = await rootdAlive();
  const r = root ? { out: await tr.job(q, 60000) } : await sh(q);
  if (!root) console.log('(rootd down - showing the unprivileged view)');
  console.log(r.out.replace(/\n{2,}/g, '\n').trim());
}

async function logs(n) {
  await tr.ensureDevice();
  const r = await sh(`tail -${Number(n) || 30} /tmp/tlssrv.log 2>/dev/null; echo "--- hooks ---"; tail -${Number(n) || 30} /tmp/hooks.log 2>/dev/null`);
  process.stdout.write(r.out);
}

async function start() {
  await tr.ensureDevice();
  if (!(await rootdAlive())) die('rootd is not running - install the injector first: node ../tizenroot/tizenroot.js install');
  const out = await tr.job(`sh < ${HOOK}\necho hook-done`, 120000);
  console.log(out.trim().split('\n').slice(-3).join('\n'));
}

function usage() {
  console.log(`ytadpatch - YouTube ad patcher for Tizen 3.0 TVs

usage: node ytadpatch.js [options] <command>

options
  --serial IP:PORT   device (default: auto-detect)
  --sdb PATH         sdb binary
  --port N           host sdb server port (default 26099)

commands
  install            deploy the patch + boot hook and start it
  start              run the boot hook now (stack up / restart after a change)
  uninstall [--purge] stop the patch, release mounts, remove the hook
  status             mounts, processes, rules, recent log lines
  logs [n]           tail of the proxy and hook logs

requires the root injector: node ../tizenroot/tizenroot.js install`);
}

async function main() {
  const args = process.argv.slice(2);
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--serial') tr.opt.serial = args[++i];
    else if (a === '--sdb') tr.opt.sdb = args[++i];
    else if (a === '--port') tr.opt.port = Number(args[++i]);
    else rest.push(a);
  }
  const cmd = rest.shift();
  if (cmd === 'install') return install();
  if (cmd === 'start') return start();
  if (cmd === 'uninstall') return uninstall(rest.includes('--purge'));
  if (cmd === 'status') return status();
  if (cmd === 'logs') return logs(rest[0]);
  usage();
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
