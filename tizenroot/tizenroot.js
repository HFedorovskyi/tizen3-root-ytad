#!/usr/bin/env node
'use strict';
// Tizen root injector / remote shell for Tizen 3.0 TVs.
//
// Two primitives, both proven on UE55MU6179 (Tizen 3.0, T-KTMDEUC):
//   1. the sdb `appcmd` service leaks a shell:  appcmd:runapp:<junk>; <cmd>
//      runs <cmd> synchronously as uid 5001 (owner) with Smack label "System",
//      output returned after a NUL separator and an `appcmd_exitcode:N` tail.
//   2. the system D-Bus method <svc>.ExecuteUserShell (jpmsd) spawns a detached
//      root process. It only works from the "User" Smack context, i.e. from the
//      systemd --user watchdog, never from the appcmd shell ("System" label ->
//      jpmsd fails to exec and answers 0:-1:EMPTY:EMPTY).
//
// Primitive 1 gives reliable file IO. Primitive 2 lives inside rootinject.sh: the
// user unit restarts on boot and keeps re-injecting /bin/sh < rootd.sh. rootd is a
// job runner: scripts pushed to /tmp/root.cmd (last line "#END") execute as uid 0,
// output read from /tmp/root.out. Boot hooks are $BASE/hooks/*.sh, run by rootd.
//
// Commands: probe | sh | job | push | pull | hook | install | uninstall | status | help

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE = process.env.TV_BASE || '/opt/usr/home/owner';
const UNIT_DIR = process.env.TV_UNIT_DIR || '/home/owner/.config/systemd/user';
const UNIT_NAME = 'rootinject.service';
const APP_CMD = 'appcmd:runapp:x';

const opt = {
  serial: process.env.TV_SERIAL || '',
  port: Number(process.env.SDB_PORT || 26099),
  sdb: process.env.SDB || '',
  timeout: 25000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => { console.error('error: ' + m); process.exit(1); };

// Git Bash rewrites /tmp/... into the Windows temp dir before node sees it.
function toRemote(p) {
  const t = os.tmpdir().replace(/\\/g, '/').toLowerCase();
  const q = String(p).replace(/\\/g, '/');
  if (q.toLowerCase().startsWith(t + '/')) return '/tmp/' + q.slice(t.length + 1);
  return p;
}

// ---------- host sdb server ----------

function findSdb() {
  const cands = [
    opt.sdb,
    path.join(__dirname, '..', 'sdbtool', 'data', 'tools', 'sdb.exe'),
    path.join(__dirname, '..', '..', 'sdbtool', 'data', 'tools', 'sdb.exe'),
    'sdb',
  ].filter(Boolean);
  for (const c of cands) {
    if (c === 'sdb') {
      const r = spawnSync('sdb', ['version'], { encoding: 'utf8' });
      if (!r.error) return 'sdb';
      continue;
    }
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

function sdbRun(args, timeout) {
  const sdb = findSdb();
  if (!sdb) return null;
  const r = spawnSync(sdb, args, { encoding: 'utf8', timeout: timeout || 10000 });
  return r.stdout || '';
}

function portOpen(ms) {
  return new Promise((resolve) => {
    const s = net.connect(opt.port, '127.0.0.1');
    const done = (v) => { try { s.destroy(); } catch (e) {} resolve(v); };
    const t = setTimeout(() => done(false), ms || 700);
    s.on('connect', () => { clearTimeout(t); done(true); });
    s.on('error', () => { clearTimeout(t); done(false); });
  });
}

async function ensureServer() {
  if (await portOpen()) return;
  if (!findSdb()) die('sdb binary not found (pass --sdb <path> or set SDB)');
  sdbRun(['start-server']);
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    if (await portOpen()) return;
  }
  die('sdb server did not start on 127.0.0.1:' + opt.port);
}

function deviceList() {
  return sdbRun(['devices']).split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^List of devices/.test(l))
    .map((l) => l.split(/\s+/))
    .filter((p) => p[1] === 'device')
    .map((p) => p[0]);
}

async function ensureDevice() {
  await ensureServer();
  let list = deviceList();
  if (!opt.serial) {
    if (list.length === 1) opt.serial = list[0];
    else if (!list.length) die('no TV: enable Developer mode, set "Host PC IP" to this PC, then sdb connect <tv>:26101');
    else die('multiple devices: pass --serial ' + list.join('|'));
  }
  if (!list.includes(opt.serial)) {
    sdbRun(['connect', opt.serial]);
    for (let i = 0; i < 40; i++) { await sleep(500); if (deviceList().includes(opt.serial)) return; }
    die('device ' + opt.serial + ' is not connected');
  }
}

function frame(s) {
  return Buffer.from(s.length.toString(16).padStart(4, '0') + s, 'binary');
}

function svc(service, timeout) {
  return new Promise((resolve, reject) => {
    let acc = '';
    let phase = 0;
    let buf = Buffer.alloc(0);
    let finished = false;
    const s = net.connect(opt.port, '127.0.0.1', () => s.write(frame('host:transport:' + opt.serial)));
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(t);
      try { s.destroy(); } catch (e) {}
      resolve(acc);
    };
    const t = setTimeout(finish, timeout || opt.timeout);
    s.on('data', (d) => {
      if (phase === 0) {
        buf = Buffer.concat([buf, d]);
        if (buf.length < 4) return;
        const st = buf.subarray(0, 4).toString();
        const rest = buf.subarray(4);
        if (st !== 'OKAY') { acc += 'FAIL:' + rest.toString(); return finish(); }
        phase = 1;
        s.write(frame(service));
        if (rest.length) acc += rest.toString('utf8');
        return;
      }
      acc += d.toString('utf8');
      if (acc.indexOf('appcmd_exitcode:') >= 0) finish();
    });
    s.on('close', finish);
    s.on('error', (e) => { acc += 'ERR ' + (e.code || e.message); finish(); });
  });
}

// Run a shell line as uid 5001 (owner, Smack "System"). Returns {code, out}.
// The appcmd launcher occasionally answers exit -1 with no output when it is
// still tearing down the previous app slot; a single retry clears it.
async function shRaw(cmd, timeout) {
  const raw = await svc(APP_CMD + '; ' + cmd, timeout);
  if (raw.startsWith('FAIL:')) die('sdb service failed: ' + raw.slice(0, 200));
  let body = raw.replace(/^OKAY/, '');
  const m = body.match(/appcmd_exitcode:(-?\d+)\s*$/);
  const code = m ? Number(m[1]) : null;
  if (m) body = body.slice(0, m.index);
  const segs = body.split('\u0000');
  if (segs.length > 1 && /^The app with ID:/.test(segs[0])) segs.shift();
  const out = segs.map((s) => s.replace(/\r/g, '')).join('');
  return { code, out };
}

async function sh(cmd, timeout) {
  let r = await shRaw(cmd, timeout);
  for (let t = 1; t <= 3 && r.code !== 0 && !r.out.trim(); t++) {
    await sleep(250 * t);
    r = await shRaw(cmd, timeout);
  }
  return r;
}

// ---------- file transfer (no sdb push: it is flaky on retail firmware) ----------

async function statSize(remote) {
  for (let t = 0; t < 5; t++) {
    const r = await sh(`stat -c %s ${remote} 2>/dev/null`);
    const m = r.out.match(/\d+/);
    if (m) return parseInt(m[0], 10);
    await sleep(200);
  }
  return NaN;
}

async function push(local, remote, mode) {
  const data = fs.readFileSync(local);
  const b64 = data.toString('base64');
  const CH = 3500; // the appcmd service string is capped at 4096 bytes
  if (!b64.length) {
    const t = await sh(`> ${remote}`);
    if (t.code !== 0) die('cannot create ' + remote);
    return 0;
  }
  // chunks land as separate files and are concatenated at the end, so a failed
  // chunk can be retried without risking a duplicated tail
  const dir = '/tmp/.push' + process.pid + Date.now().toString(36);
  let r = await sh(`mkdir -p ${dir}`);
  if (r.code !== 0) die('cannot create ' + dir + ': ' + r.out.trim());
  for (let i = 0, n = 0; i < b64.length; i += CH, n++) {
    const part = b64.slice(i, i + CH);
    const name = dir + '/p' + String(n).padStart(5, '0');
    const want = Math.floor(part.length * 3 / 4) - (part.endsWith('==') ? 2 : part.endsWith('=') ? 1 : 0);
    let ok = false;
    for (let t = 0; t < 4 && !ok; t++) {
      if (t) await sleep(300 * t);
      r = await sh(`printf '%s' '${part}' | base64 -d > ${name}`);
      ok = r.code === 0 && (await statSize(name)) === want;
    }
    if (!ok) die('push chunk failed at ' + i + ': ' + r.out.trim());
    // long transfers run hundreds of appcmd shells; give the service a breather or
    // it stops answering mid-file (seen on a ~400 KB bundle)
    if (n % 25 === 24) await sleep(60);
  }
  for (let t = 0; t < 4; t++) {
    if (t) await sleep(300 * t);
    r = await sh(`cat ${dir}/p* > ${remote}; rc=$?; [ $rc -eq 0 ] && rm -rf ${dir}; [ $rc -eq 0 ]`);
    if (r.code === 0) break;
  }
  if (r.code !== 0) die('cannot write ' + remote + ': ' + r.out.trim());
  const size = await statSize(remote);
  if (size !== data.length) die(`push size mismatch ${remote}: ${size} != ${data.length}`);
  if (mode) await sh(`chmod ${mode} ${remote}`);
  return size;
}

async function pull(remote, local, chunk) {
  const CH = chunk || 4096;
  const size = await statSize(remote);
  if (isNaN(size)) die('cannot stat ' + remote);
  const parts = [];
  for (let skip = 0; skip * CH < size; skip++) {
    const r = await sh(`dd if=${remote} bs=${CH} skip=${skip} count=1 2>/dev/null | base64`, 60000);
    parts.push(Buffer.from(r.out.replace(/\s+/g, ''), 'base64'));
  }
  const data = Buffer.concat(parts);
  if (data.length !== size) die(`pull size mismatch: ${data.length} != ${size}`);
  fs.writeFileSync(local, data);
  return size;
}

// re-pushing a large unchanged file is what wedged the appcmd service once;
// compare md5 first and only transfer what actually differs (returns -1 if same)
async function pushIfChanged(local, remote, mode) {
  const want = require('crypto').createHash('md5').update(fs.readFileSync(local)).digest('hex');
  const r = await sh(`md5sum ${remote} 2>/dev/null`);
  const m = r.out.match(/[0-9a-f]{32}/);
  if (m && m[0] === want) return -1;
  return push(local, remote, mode);
}

// ---------- root job runner ----------

async function job(script, timeoutMs) {
  const nonce = 'j' + Date.now().toString(36);
  let txt = script.replace(/\r\n/g, '\n');
  if (!txt.endsWith('\n')) txt += '\n';
  txt += `echo "__done_${nonce}__"\n#END\n`;
  const tmp = path.join(os.tmpdir(), 'tizenroot-job.sh');
  fs.writeFileSync(tmp, txt, 'utf8');
  const before = await sh('stat -c %s /tmp/root.out 2>/dev/null || echo 0');
  const off = parseInt(before.out.trim(), 10) || 0;
  // rootd consumes /tmp/root.cmd with mv on its 1 s tick; a direct push races
  // that mv and the post-transfer stat lands on a vanished path. Upload beside
  // it and publish with a rename instead.
  await push(tmp, '/tmp/root.cmd.new');
  const mv = await sh('mv -f /tmp/root.cmd.new /tmp/root.cmd');
  if (mv.code !== 0) die('cannot publish /tmp/root.cmd: ' + mv.out.trim());
  const deadline = Date.now() + (timeoutMs || 60000);
  let out = '';
  while (Date.now() < deadline) {
    const r = await sh(`tail -c +${off + 1} /tmp/root.out 2>/dev/null`);
    out = r.out;
    if (out.indexOf(`__done_${nonce}__`) >= 0) break;
    await sleep(700);
  }
  return out.split(`__done_${nonce}__`)[0];
}

// ---------- persistence ----------

// D-Bus injection is context-bound: it works only from the watchdog (Smack "User").
// The installer therefore drives the systemd --user unit and uses rootd itself to
// retire an old instance; `systemctl --user` does work from the appcmd shell.

async function rootdPid() {
  const r = await sh('p=$(cat /tmp/rootd.pid 2>/dev/null); [ -n "$p" ] && [ -d /proc/$p ] && echo $p');
  const m = r.out.match(/^\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : 0;
}

async function waitRootd(ms) {
  const deadline = Date.now() + (ms || 30000);
  while (Date.now() < deadline) {
    const pid = await rootdPid();
    if (pid) return pid;
    await sleep(500);
  }
  return 0;
}

// watchdog instances started by hand (`sh < rootinject.sh`) are plain /bin/sh
// with stdin on the script; the systemd unit is stopped separately.
async function stopStrays() {
  await sh(`for p in $(ls -l /proc/[0-9]*/fd/0 2>/dev/null | awk '/rootinject\\.sh/{split($9,a,"/"); print a[3]}'); do kill "$p" 2>/dev/null; done`);
}

async function unitState() {
  const r = await sh('systemctl --user is-active rootinject.service 2>/dev/null');
  return r.out.trim() || 'unknown';
}

async function install() {
  await ensureDevice();
  const id = await sh('id');
  if (!/uid=\d+\(/.test(id.out)) die('sdb shell unavailable (got: ' + id.out.trim() + ')');
  console.log('shell: ' + id.out.trim().split(/\s+/).slice(0, 4).join(' '));

  await sh(`mkdir -p ${BASE}/hooks`);
  // replace through a new inode: a running instance keeps reading the old file.
  // A file left root-owned by an older install cannot be renamed from the owner
  // shell (VDFS), so the live rootd does the swap in that case.
  for (const f of ['rootd.sh', 'rootinject.sh']) {
    const local = path.join(__dirname, 'tv', f);
    const n = await push(local, `${BASE}/${f}.new`);
    await sh(`chmod 755 ${BASE}/${f}.new && mv -f ${BASE}/${f}.new ${BASE}/${f}`);
    const want = require('crypto').createHash('md5').update(fs.readFileSync(local)).digest('hex');
    const got = (await sh(`md5sum ${BASE}/${f} 2>/dev/null`)).out.match(/[0-9a-f]{32}/);
    if (got && got[0] === want) {
      console.log(`pushed ${BASE}/${f} (${n} B)`);
      continue;
    }
    if (!(await rootdPid())) die(`cannot replace ${BASE}/${f}: file is root-owned and rootd is down`);
    const out = await job(`chmod 755 ${BASE}/${f}.new\nmv -f ${BASE}/${f}.new ${BASE}/${f}\nmd5sum ${BASE}/${f}\necho swapped`, 20000);
    if (out.indexOf('swapped') < 0) die(`root swap of ${BASE}/${f} failed`);
    console.log(`pushed ${BASE}/${f} (${n} B, root swap)`);
  }

  const unitTxt = fs.readFileSync(path.join(__dirname, 'tv', UNIT_NAME), 'utf8').replace(/@BASE@/g, BASE);
  const unitTmp = path.join(os.tmpdir(), UNIT_NAME);
  fs.writeFileSync(unitTmp, unitTxt, 'utf8');
  const un = await sh(`mkdir -p ${UNIT_DIR}/default.target.wants`);
  if (un.code !== 0) die('cannot create ' + UNIT_DIR + ': ' + un.out.trim());
  const unSz = await push(unitTmp, `${UNIT_DIR}/${UNIT_NAME}`);
  await sh(`chmod 644 ${UNIT_DIR}/${UNIT_NAME} && ln -sf ../${UNIT_NAME} ${UNIT_DIR}/default.target.wants/${UNIT_NAME}`);
  console.log(`pushed ${UNIT_DIR}/${UNIT_NAME} (${unSz} B), enabled for default.target`);

  // the heartbeat must carry the "User" label or the owner watchdog cannot read it
  await sh(`[ -s ${BASE}/rootd.beat ] || { echo 0 > ${BASE}/rootd.beat; chsmack -a User ${BASE}/rootd.beat 2>/dev/null; }`);

  // stop every injector before swapping rootd, otherwise a watchdog respawns the
  // old instance between the kill and the pid-file reset
  await sh('systemctl --user stop rootinject.service 2>/dev/null');
  await stopStrays();
  await sleep(500);

  // the owner shell cannot signal root processes (Smack); the old rootd kills
  // itself through its own job runner. The job keeps running after the kill, so it
  // also clears the root-owned pid file in sticky /tmp (owner cannot unlink it).
  const old = await rootdPid();
  if (old) {
    const out = await job(`kill -9 ${old}\nsleep 1\nrm -f /tmp/rootd.pid\necho killed`, 20000);
    if (out.indexOf('killed') < 0) console.log('warning: old rootd did not confirm the kill');
    for (let i = 0; i < 40 && (await rootdPid()); i++) await sleep(250);
  }

  await sh('systemctl --user daemon-reload 2>/dev/null');
  const st = await sh('systemctl --user start rootinject.service', 60000);
  if (st.code !== 0) die('systemctl --user start failed: ' + st.out.trim());
  const pid = await waitRootd(40000);
  if (!pid) die('rootd did not come up - see ' + BASE + '/rootinject.log');

  const hooks = (await sh(`ls -1 ${BASE}/hooks 2>/dev/null`)).out.trim().split('\n').filter(Boolean);
  console.log(`rootd pid ${pid}, unit ${await unitState()}, hooks: ${hooks.join(' ') || '(none)'}`);
}

async function uninstall() {
  await ensureDevice();
  await sh('systemctl --user disable --now rootinject.service 2>/dev/null');
  await stopStrays();
  const old = await rootdPid();
  if (old) {
    await job(`kill -9 ${old}\nsleep 1\nrm -f /tmp/rootd.pid\necho killed`, 20000);
    for (let i = 0; i < 40 && (await rootdPid()); i++) await sleep(250);
  }
  await sh(`rm -f ${UNIT_DIR}/default.target.wants/${UNIT_NAME} ${UNIT_DIR}/${UNIT_NAME} ${BASE}/rootinject.pid`);
  await sh('systemctl --user daemon-reload 2>/dev/null');
  console.log('rootd and watchdog stopped, boot unit removed (files under ' + BASE + ' kept)');
}

async function status() {
  await ensureDevice();
  const r = await sh([
    'id',
    'p=$(cat /tmp/rootd.pid 2>/dev/null); if [ -n "$p" ] && [ -d /proc/$p ]; then echo "rootd alive pid=$p"; else echo "rootd not running"; fi',
    'echo "unit: $(systemctl --user is-active rootinject.service 2>/dev/null)"',
    `p=$(cat ${BASE}/rootinject.pid 2>/dev/null); [ -n "$p" ] && [ -d /proc/$p ] && echo "watchdog pid=$p"`,
    `tail -3 ${BASE}/rootinject.log 2>/dev/null`,
    `ls -l ${UNIT_DIR}/${UNIT_NAME} ${UNIT_DIR}/default.target.wants/${UNIT_NAME} 2>&1`,
    `echo "hooks:"; ls -1 ${BASE}/hooks 2>/dev/null`,
  ].join('\n'));
  console.log(`device: ${opt.serial}`);
  console.log(r.out.replace(/\n{2,}/g, '\n').trim());
}

// ---------- cli ----------

function usage() {
  console.log(`tizenroot - root injector for Tizen 3.0 TVs

usage: node tizenroot.js [options] <command> [args]

options
  --serial IP:PORT   device (default: auto-detect via "sdb devices")
  --sdb PATH         sdb binary (default: ../sdbtool/data/tools/sdb.exe, then PATH)
  --port N           host sdb server port (default 26099 / $SDB_PORT)
  --timeout MS       per-command timeout (default 25000)

commands
  probe              shell identity + uptime
  sh <cmd>           run <cmd> as uid 5001 through the sdb appcmd service
  job <script>       run a local script as uid 0 through rootd, print its output
  push <local> <remote> [mode]
  pull <remote> <local> [chunk]
  hook <script.sh> [name]  install a boot hook into ${BASE}/hooks and run it now
  install            deploy rootd + boot watchdog (systemd --user) and start them
  uninstall          stop rootd/watchdog, remove the boot unit
  status             rootd/watchdog/hook state

hooks are ${BASE}/hooks/*.sh; rootd runs each one as uid 0 on every start.
prerequisite: TV developer mode on, "Host PC IP" = this PC, port 26101 reachable.`);
}

async function main() {
  const args = process.argv.slice(2);
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--serial') opt.serial = args[++i];
    else if (a === '--sdb') opt.sdb = args[++i];
    else if (a === '--port') opt.port = Number(args[++i]);
    else if (a === '--timeout') opt.timeout = Number(args[++i]);
    else rest.push(a);
  }
  const cmd = rest.shift();
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') return usage();

  if (cmd === 'probe') {
    await ensureDevice();
    const r = await sh('id; printf "smack: "; tr "\\0" " " < /proc/self/attr/current; echo; printf "uptime: "; cut -d. -f1 /proc/uptime');
    console.log(`device: ${opt.serial}`);
    console.log(r.out.trim());
    return;
  }
  if (cmd === 'sh') {
    if (!rest.length) die('usage: sh <command>');
    await ensureDevice();
    const r = await sh(rest.join(' '), opt.timeout);
    process.stdout.write(r.out);
    process.exit(r.code === 0 ? 0 : 1);
  }
  if (cmd === 'job') {
    if (!rest.length) die('usage: job <script file>');
    await ensureDevice();
    process.stdout.write(await job(fs.readFileSync(rest[0], 'utf8')));
    return;
  }
  if (cmd === 'push') {
    await ensureDevice();
    const n = await push(rest[0], toRemote(rest[1]), rest[2]);
    console.log(`${rest[0]} -> ${toRemote(rest[1])} (${n} B)`);
    return;
  }
  if (cmd === 'pull') {
    await ensureDevice();
    const n = await pull(toRemote(rest[0]), rest[1], Number(rest[2] || 4096));
    console.log(`${toRemote(rest[0])} -> ${rest[1]} (${n} B)`);
    return;
  }
  if (cmd === 'hook') {
    if (!rest.length) die('usage: hook <script.sh> [name]');
    await ensureDevice();
    const name = rest[1] || path.basename(rest[0]);
    const n = await push(rest[0], `${BASE}/hooks/${name}`);
    await sh(`chmod 755 ${BASE}/hooks/${name}`);
    if (!(await rootdPid())) die('rootd is not running - cannot execute the hook as root');
    const out = await job(`sh < ${BASE}/hooks/${name}\necho hook-done`, 180000);
    console.log(`${rest[0]} -> ${BASE}/hooks/${name} (${n} B)`);
    process.stdout.write(out.trim().split('\n').slice(-5).join('\n') + '\n');
    return;
  }
  if (cmd === 'install') return install();
  if (cmd === 'uninstall') return uninstall();
  if (cmd === 'status') return status();
  usage();
}

if (require.main === module) {
  main().catch((e) => die(e && e.stack ? e.stack : String(e)));
}

module.exports = { opt, BASE, ensureDevice, sh, push, pushIfChanged, pull, job, rootdPid, waitRootd };
