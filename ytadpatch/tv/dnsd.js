var dgram = require('dgram');
var fs = require('fs');

var DIR = process.env.YTAD_DIR || '/opt/usr/home/owner/ytad';
var BF = process.env.YTAD_HOSTS || DIR + '/hosts';
var HF = process.env.YTAD_HIJACK || DIR + '/hijack';
var LOG = '/tmp/dnsd.log';
var UP = process.env.YTAD_DNS_UP || '8.8.8.8';
var UPPORT = 53;
var LPORT = Number(process.env.DNS_PORT || 53);

var blk = [];
var bmtime = -1;
var hij = [];
var hmtime = -1;

function load() {
  var st, t;
  try { st = fs.statSync(BF); } catch (e) { st = null; }
  if (st) {
    var m = +st.mtime;
    if (m !== bmtime) {
      try { t = fs.readFileSync(BF, 'utf8').split('\n'); } catch (e) { t = null; }
      if (t) {
        var out = [];
        for (var i = 0; i < t.length; i++) {
          var l = t[i].trim();
          if (!l || l.charAt(0) === '#') continue;
          var p = l.split(/\s+/);
          var d = p.length > 1 ? p[1] : p[0];
          if (d && d !== 'localhost' && d.indexOf('.') > 0) out.push(d.toLowerCase());
        }
        blk = out;
        bmtime = m;
      }
    }
  }
  var hs;
  try { hs = fs.statSync(HF); } catch (e) { hs = null; }
  if (!hs) { hij = []; hmtime = -1; return; }
  var hm = +hs.mtime;
  if (hm === hmtime) return;
  try { t = fs.readFileSync(HF, 'utf8').split('\n'); } catch (e) { return; }
  var ho = [];
  for (var j = 0; j < t.length; j++) {
    var hl = t[j].trim();
    if (!hl || hl.charAt(0) === '#') continue;
    var hp = hl.split(/\s+/);
    var hd = hp[0].toLowerCase();
    if (hd.indexOf('.') > 0) ho.push({ d: hd, ip: hp[1] || '127.0.0.1' });
  }
  hij = ho;
  hmtime = hm;
}

function blocked(n) {
  for (var i = 0; i < blk.length; i++) {
    var b = blk[i];
    if (n === b) return true;
    if (n.length > b.length + 1 && n.slice(-(b.length + 1)) === '.' + b) return true;
  }
  return false;
}

function hijacked(n) {
  for (var i = 0; i < hij.length; i++) {
    var b = hij[i].d;
    if (n === b) return hij[i];
    if (n.length > b.length + 1 && n.slice(-(b.length + 1)) === '.' + b) return hij[i];
  }
  return null;
}

function qname(m) {
  var i = 12, o = [];
  while (i < m.length && m[i]) {
    var l = m[i];
    if (i + 1 + l > m.length) return null;
    o.push(m.slice(i + 1, i + 1 + l).toString('ascii'));
    i += 1 + l;
  }
  if (i + 5 > m.length) return null;
  return { name: o.join('.'), end: i + 5, type: (m[i + 1] << 8) | m[i + 2] };
}

function answer(p, q, ip) {
  var n = q.end;
  var r = new Buffer(n + 28);
  r.fill(0);
  p.copy(r, 0, 0, n);
  r[2] = p[2] | 0x80;
  r[3] = (p[3] & 0x01) | 0x80;
  var an = 0;
  if (q.type === 1) an = 1;
  else if (q.type === 28 && !ip) an = 1;
  r[6] = 0; r[7] = an;
  r[8] = 0; r[9] = 0; r[10] = 0; r[11] = 0;
  if (an) {
    r[n++] = 0xC0; r[n++] = 0x0C;
    r[n++] = 0; r[n++] = q.type === 1 ? 1 : 28;
    r[n++] = 0; r[n++] = 1;
    r[n++] = 0; r[n++] = 0; r[n++] = 0; r[n++] = 60;
    if (q.type === 1) {
      var o = ip ? ip.split('.') : [0, 0, 0, 0];
      r[n++] = 0; r[n++] = 4;
      for (var k = 0; k < 4; k++) r[n++] = Number(o[k]) || 0;
    } else {
      r[n++] = 0; r[n++] = 16;
      for (var i = 0; i < 16; i++) r[n++] = 0;
    }
  }
  return r.slice(0, n);
}

function logline(s) {
  try { fs.appendFileSync(LOG, Math.floor(Date.now() / 1000) + ' ' + s + '\n'); } catch (e) {}
}

var srv = dgram.createSocket('udp4');
var up = dgram.createSocket('udp4');
var pend = {};

srv.on('message', function (m, r) {
  var q = null;
  try { q = qname(m); } catch (e) {}
  logline('Q ' + (q ? q.name + ' t=' + q.type : 'len=' + m.length + ' h=' + m.slice(0, 4).toString('hex')));
  if (q && blocked(q.name.toLowerCase())) {
    logline('BLOCK ' + q.name);
    var rb = answer(m, q);
    try { srv.send(rb, 0, rb.length, r.port, r.address); } catch (e) {}
    return;
  }
  var h = q ? hijacked(q.name.toLowerCase()) : null;
  if (h) {
    logline('HIJACK ' + q.name + ' -> ' + h.ip + ' t=' + q.type);
    var rh = answer(m, q, h.ip);
    try { srv.send(rh, 0, rh.length, r.port, r.address); } catch (e) {}
    return;
  }
  var id = (m[0] << 8) | m[1];
  var k = id + ':' + r.port;
  pend[k] = { a: r.address, p: r.port, t: Date.now() };
  try { up.send(m, 0, m.length, UPPORT, UP); } catch (e) {}
  var now = Date.now();
  for (var kk in pend) if (now - pend[kk].t > 6000) delete pend[kk];
});

up.on('message', function (m) {
  if (m.length < 12) return;
  var id = (m[0] << 8) | m[1];
  for (var kk in pend) {
    var parts = kk.split(':');
    if (Number(parts[0]) === id) {
      try { srv.send(m, 0, m.length, pend[kk].p, pend[kk].a); } catch (e) {}
      delete pend[kk];
      return;
    }
  }
});

srv.on('error', function (e) { logline('ERR ' + e.message); process.exit(1); });
load();
setInterval(load, 30000);
srv.bind(LPORT, '127.0.0.1');
logline('up port=' + LPORT + ' blk=' + blk.length + ' hij=' + hij.length);
