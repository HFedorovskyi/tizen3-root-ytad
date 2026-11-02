// YouTube TLS MITM for Tizen: terminates TLS for the pinned YouTube hosts,
// forwards to the real backend over DoH, strips ad JSON, and rewrites the
// /youtubei/v1/player request to a WEB client so the response carries normal
// client-side ad fields (which are then stripped) instead of SSDAI-stitched
// streams. Also blocks the "onesie" initplayback redirect path so the player
// falls back to /youtubei/v1/player.
var https = require('https');
var tls = require('tls');
var fs = require('fs');
var zlib = require('zlib');

var DIR = process.env.YTAD_DIR || '/opt/usr/home/owner/ytad';
var KEY = process.env.YTAD_KEY || DIR + '/tls/leaf.key';
var CRT = process.env.YTAD_CRT || DIR + '/tls/leaf.pem';
var LOG = '/tmp/tlssrv.log';
var REAL = 'www.youtube.com';
var MAXBODY = 16 * 1024 * 1024;
var PORT = Number(process.env.YTAD_PORT || 443);

var ALLOWED = { 'www.youtube.com': 1, 'youtubei.googleapis.com': 1 };

var ONESIE_FLAG = process.env.YTAD_ONESIE_FLAG || DIR + '/block_onesie';

function blockOnesie() {
  try { return fs.existsSync(ONESIE_FLAG); } catch (e) { return false; }
}

function allowed(host) {
  if (ALLOWED[host] === 1) return true;
  if (host === 'c.youtube.com') return true;
  if (host === 'redirector.googlevideo.com') return true;
  return host.length > 14 && host.slice(-14) === '.c.youtube.com';
}

var ADKEYS = {
  adplacements: 1, playerads: 1, adslots: 1, adbreakparams: 1, adbreaks: 1,
  adbreakheartbeatparams: 1, adparams: 1, playeradparams: 1, adcuepoints: 1,
  adsponsorships: 1, adsignalsinfo: 1, adloggingdata: 1
};

var ADRENDERERS = {
  adslotrenderer: 1, displayadrenderer: 1, advertisementslotrenderer: 1,
  promotedsparklestextrenderer: 1, promotedsparkleswebrenderer: 1,
  promotedvideorenderer: 1, compactpromotedvideorenderer: 1,
  brandvideoshelfrenderer: 1, brandvideosingletonrenderer: 1,
  adsengagementpanelrenderer: 1
};

function log(s) {
  try { fs.appendFileSync(LOG, Math.floor(Date.now() / 1000) + ' ' + s + '\n'); } catch (e) {}
}

var ipCache = {};
var ipExp = {};

function resolveReal(host, cb) {
  if (ipCache[host] && Date.now() < ipExp[host]) return cb(null, ipCache[host]);
  var req = https.request({
    host: '8.8.8.8', port: 443, method: 'GET',
    path: '/resolve?name=' + host + '&type=A',
    servername: 'dns.google',
    headers: { Host: 'dns.google' }
  }, function (res) {
    var b = '';
    res.setEncoding('utf8');
    res.on('data', function (c) { b += c; });
    res.on('end', function () {
      var ips = [];
      try {
        var j = JSON.parse(b);
        if (j.Answer) for (var i = 0; i < j.Answer.length; i++) {
          if (j.Answer[i].type === 1) ips.push(j.Answer[i].data);
        }
      } catch (e) {}
      if (!ips.length) { log('DOH_ERR no answer ' + host); return cb(new Error('no answer')); }
      ipCache[host] = ips[Math.floor(Math.random() * ips.length)];
      ipExp[host] = Date.now() + 120000;
      log('DOH ' + host + ' -> ' + ipCache[host]);
      cb(null, ipCache[host]);
    });
  });
  req.on('error', function (e) { log('DOH_ERR ' + host + ' ' + e.message); cb(e); });
  req.setTimeout(5000, function () { req.abort(); });
  req.end();
}

function adNodeName(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  var ks = Object.keys(o);
  if (ks.length !== 1) return null;
  return ADRENDERERS[ks[0].toLowerCase()] === 1 ? ks[0] : null;
}

function stripAd(o, hits) {
  var n = 0;
  if (!o || typeof o !== 'object') return 0;
  if (Array.isArray(o)) {
    for (var i = 0; i < o.length; i++) {
      var name = adNodeName(o[i]);
      if (name) {
        if (hits) hits.push('node:' + name);
        o.splice(i, 1); i--; n++; continue;
      }
      n += stripAd(o[i], hits);
    }
    return n;
  }
  for (var k in o) {
    if (!o.hasOwnProperty(k)) continue;
    if (ADKEYS[k.toLowerCase()] === 1) {
      if (hits) hits.push(k + ':' + (JSON.stringify(o[k]) || '').length);
      delete o[k]; n++; continue;
    }
    n += stripAd(o[k], hits);
  }
  return n;
}

function decode(raw, enc, cb) {
  enc = (enc || '').toLowerCase();
  if (enc.indexOf('gzip') >= 0) return zlib.gunzip(raw, cb);
  if (enc.indexOf('deflate') >= 0) return zlib.inflate(raw, cb);
  cb(null, raw);
}

var agent = new https.Agent({ keepAlive: true, maxSockets: 8 });

var KEYDATA = fs.readFileSync(KEY), CRTDATA = fs.readFileSync(CRT);
var defctx = tls.createSecureContext({ key: KEYDATA, cert: CRTDATA });
var srv = https.createServer({
  key: KEYDATA, cert: CRTDATA,
  SNICallback: function (name, cb) { log('SNI_REQ ' + name); cb(null, defctx); }
}, function (req, res) {
  var sni = (req.socket && req.socket.servername) || '';
  var host = sni || REAL;
  if (!allowed(host)) {
    log('DROP sni=' + sni + ' ' + req.url);
    try { req.socket.destroy(); } catch (e) {}
    return;
  }
  if (req.url.indexOf('/initplayback') === 0 && blockOnesie()) {
    log('BLOCK_ONESIE ' + host + ' ' + req.url.slice(0, 100));
    try { res.writeHead(503); res.end(); } catch (e) {}
    return;
  }
  resolveReal(host, function (err, ip) {
    if (err) { try { res.writeHead(502); res.end(); } catch (e) {} return; }
    var hdrs = {};
    for (var k in req.headers) {
      var lk = k.toLowerCase();
      if (lk === 'host' || lk === 'connection' || lk === 'accept-encoding' ||
          lk === 'proxy-connection' || lk === 'upgrade') continue;
      hdrs[k] = req.headers[k];
    }
    hdrs.host = host;
    hdrs['accept-encoding'] = 'identity';

    var pre = null;
    if (req.method === 'POST' || req.method === 'PUT') {
      pre = [];
      req.on('data', function (c) { pre.push(c); });
      req.on('end', function () {
        var b = Buffer.concat(pre);
        if (req.url.indexOf('/youtubei/v1/player') >= 0) {
          try {
            var rj = JSON.parse(b.toString('utf8'));
            if (rj && rj.context && rj.context.client) {
              rj.context.client.clientName = 'WEB';
              rj.context.client.clientVersion = '2.20241126.01.00';
              b = new Buffer(JSON.stringify(rj), 'utf8');
              hdrs['x-youtube-client-name'] = '1';
              hdrs['x-youtube-client-version'] = '2.20241126.01.00';
              delete hdrs['authorization'];
              delete hdrs['Authorization'];
            }
          } catch (e) { log('REQ_RW_ERR ' + e.message); }
        }
        send(b);
      });
    } else {
      send(null);
    }

    function send(body) {
      if (body) hdrs['content-length'] = body.length;
      var up = https.request({
        host: ip, port: 443, method: req.method, path: req.url, headers: hdrs,
        servername: host, agent: agent,
        checkServerIdentity: function (h, cert) { return tls.checkServerIdentity(host, cert); }
      }, function (ur) {
        var ct = (ur.headers['content-type'] || '').toLowerCase();
        var ce = (ur.headers['content-encoding'] || '').toLowerCase();
        var isJson = ct.indexOf('json') >= 0;
        log('UP ' + host + ' ' + req.method + ' ' + req.url + ' -> ' + ur.statusCode + ' ' + ct);
        if (!isJson) {
          var oh = {};
          for (var h in ur.headers) {
            if (h.toLowerCase() === 'alt-svc') continue;
            oh[h] = ur.headers[h];
          }
          res.writeHead(ur.statusCode, oh);
          ur.pipe(res);
          return;
        }
        var chunks = [], size = 0, dead = false;
        ur.on('data', function (c) {
          if (dead) return;
          chunks.push(c); size += c.length;
          if (size > MAXBODY) { dead = true; try { res.writeHead(502); res.end(); } catch (e) {} ur.destroy(); }
        });
        ur.on('end', function () {
          if (dead) return;
          var raw = Buffer.concat(chunks);
          decode(raw, ce, function (de, plain) {
            if (de) {
              log('DEC_ERR ' + de.message);
              try { res.writeHead(502); res.end(); } catch (e) {}
              return;
            }
            var obj = null, txt = plain.toString('utf8');
            try { obj = JSON.parse(txt); } catch (e) {}
            var n = 0, hits = [];
            if (obj) { n = stripAd(obj, hits); txt = JSON.stringify(obj); }
            if (hits.length) log('ADK ' + req.url + ' ' + hits.join(', '));
            if (obj && plain.length < 4 * 1024 * 1024) {
              if (req.url.indexOf('/youtubei/v1/player') >= 0) {
                try { fs.writeFileSync('/tmp/yt_player.json', plain); } catch (e) {}
              } else if (req.url.indexOf('/youtubei/v1/browse') >= 0) {
                try { fs.writeFileSync('/tmp/yt_browse.json', plain); } catch (e) {}
              }
            }
            var out = new Buffer(txt, 'utf8');
            var oh = {};
            for (var h in ur.headers) {
              var lh = h.toLowerCase();
              if (lh === 'content-length' || lh === 'transfer-encoding' ||
                  lh === 'content-encoding' || lh === 'connection' || lh === 'alt-svc') continue;
              oh[h] = ur.headers[h];
            }
            oh['content-length'] = out.length;
            res.writeHead(ur.statusCode, oh);
            res.end(out);
            log('JSON ' + req.method + ' ' + req.url + ' ' + ur.statusCode + ' ce=' + ce +
                ' ' + raw.length + '/' + plain.length + '->' + out.length + ' adrm=' + n);
          });
        });
        ur.on('error', function (e) { log('UPSTREAM_RD_ERR ' + e.message); });
      });
      up.on('error', function (e) {
        log('UP_ERR ' + req.method + ' ' + req.url + ' ' + e.message);
        try { res.writeHead(502); res.end(); } catch (x) {}
      });
      up.setTimeout(60000, function () { up.abort(); });
      if (body) up.end(body); else up.end();
    }
  });
});

srv.on('secureConnection', function (s) {
  var proto = '-', cip = '-', alpn = '-';
  try { if (s.getProtocol) proto = s.getProtocol(); } catch (e) {}
  try { var c = s.getCipher(); if (c && c.name) cip = c.name; } catch (e) {}
  try { if (s.alpnProtocol) alpn = s.alpnProtocol; } catch (e) {}
  log('TLS_OK sni=' + (s.servername || '-') + ' proto=' + proto + ' cipher=' + cip + ' alpn=' + alpn);
  s.on('error', function (e) { log('SOCK_ERR ' + (e && e.message)); });
});

srv.on('clientError', function (e, sock) {
  log('CLIENT_ERR sni=' + ((sock && sock.servername) || '-') + ' ' + (e && e.message));
  try { sock.destroy(); } catch (x) {}
});

srv.on('tlsClientError', function (e, sock) {
  log('TLS_ERR sni=' + ((sock && sock.servername) || '-') + ' ' + (e && e.message));
});

srv.on('error', function (e) {
  if (e && e.message && e.message.indexOf('EADDRINUSE') >= 0) process.exit(0);
  log('ERR ' + e.message); process.exit(1);
});

srv.listen(PORT, '127.0.0.1', function () { log('listening ' + PORT + ' proxy'); });
