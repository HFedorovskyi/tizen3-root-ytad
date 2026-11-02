# tizen3-ytad

Ad-free stock YouTube on Samsung 2017 TVs (Tizen 3.0). A local TLS MITM: the app believes it is talking to YouTube while the proxy strips ads out of the responses. Nothing is installed over the stock app — no sideloaded widgets, no replacement client.

Requires the [tizen3-root](https://github.com/HFedorovskyi/tizen3-root) injector (package `tizenroot`).

**Русская версия:** [README.ru.md](README.ru.md)

## What happens on the TV

1. `/etc/hosts` (a bind mount of `$Y/hosts`) pins `www.youtube.com`, `youtubei.googleapis.com`, `c.youtube.com` and `redirector.googlevideo.com` to `0.0.0.0`, which is loopback. Resolution works even before the DNS proxy is up.
2. `dnsd.js` listens on `127.0.0.1:53`; `iptables -t nat` redirects the gateway's UDP/53 to it. The same service answers with sinkhole addresses for Samsung telemetry and OTA hosts (list in `tv/hosts`).
3. `srv.js` listens on `127.0.0.1:443`, terminates TLS with a leaf signed by a local CA and proxies to the real Google backend over DoH. In responses:
   - `adPlacements`, `playerAds`, `adSlots`, `adSlotRenderer`, `promoted*` and friends are removed from JSON;
   - the `/youtubei/v1/player` request is rewritten to the WEB client (without `authorization`), because TVHTML5 delivers ads through SSDAI straight inside the stream;
   - `onesie /initplayback` answers 503 so the player falls back to a regular player call;
   - `alt-svc` is stripped and UDP/443 + UDP/80 are dropped, otherwise Chromium switches to HTTP/3 and bypasses the proxy.
4. `10-ytad.sh` (a boot hook from tizenroot) sets up the bind mounts, starts both daemons, installs the DNAT/DROP rules and restarts YouTube if it started before the stack was ready.

## Install

Clone both repositories side by side — the patcher looks for `../tizen3-root/tizenroot.js`:

```sh
git clone https://github.com/HFedorovskyi/tizen3-root.git
git clone https://github.com/HFedorovskyi/tizen3-ytad.git
```

Install the injector first, then the patch:

```sh
node tizen3-root/tizenroot.js --serial 192.168.1.50:26101 install
node tizen3-ytad/ytadpatch.js --serial 192.168.1.50:26101 install
```

`TIZENROOT=/path/to/tizenroot.js` overrides the lookup if the checkouts live elsewhere.

What `ytadpatch install` does:

1. if `tv/tls/` has no key pair, generates a CA and a leaf (`certs/make_certs.sh`, needs openssl);
2. uploads the stack to `/opt/usr/home/owner/ytad/` and the hook to `/opt/usr/home/owner/hooks/10-ytad.sh` (md5 skip: unchanged files are not transferred);
3. builds three trust bundles on the TV from the **stock** Samsung files plus your CA (`/usr/share/cert/{webapp,ca,webbrowser}.pem`); if our bundle is already mounted it unmounts first to see the original, and guards against appending the CA twice by comparing inodes;
4. copies the CA to `$BASE/share/xwalk_cert/phantom_ca.pem`, where CaBox picks it up;
5. stops the old stack and runs the hook.

## Certificate trust

The CA is unique to each installation; the repository ships no keys, and the trust bundles are derived on the TV. After the first run:

- CaBox usually imports `phantom_ca.pem` on its own;
- if the app answers `alert 48 unknown_ca`, open CaBox, import that file, then restart YouTube (`kill -9 <pid>` plus `app_launcher -s`, or simply reboot);
- if you regenerate the CA (`certs/make_certs.sh`), the old import stops working — import again.

`certs/ca.key` is the private key that signs the leaf your TV trusts. It is not in git and must never be.

## Verify

```sh
node ytadpatch.js status      # mounts, processes, iptables, flags, log tail
node ytadpatch.js logs 40
```

Signs of a healthy setup:

- `/tmp/tlssrv.log`: `TLS_OK sni=www.youtube.com`, `POST /youtubei/v1/player … adrm=4`;
- no `/api/stats?…el=adunit` lines (`grep -c adunit` returns 0);
- `watchtime … state=playing`;
- `grep 0100007F:01BB /proc/net/tcp` — the proxy is listening.

## Troubleshooting

| Symptom | Cause / what to check |
|---|---|
| Black screen or YouTube crash after reboot | `srv.js` is not running while the hostname already points to loopback. Check `ps -ef \| grep srv.js`, `tail /tmp/tlssrv.err`, and that `$Y/srv.js` exists (not `$Y/tls/srv.js`) |
| Ads are back | the app switched to HTTP/3: check that `alt-svc` is absent and the UDP/443 DROP rule exists; or the player call bypassed the proxy — look for `/youtubei/v1/player` in the log |
| `alert 48 unknown_ca` | the CA is not in the TV trust store: import through CaBox (see above) |
| Endless loading after a config change | the live instance holds stale sockets: `kill -9` the app and launch it again (`app_launcher -s`) |
| No sound or picture, but traffic flows | the player response came from TVHTML5/SSDAI: verify the WEB rewrite fired (`adrm` > 0) |

## Uninstall

```sh
node ytadpatch.js uninstall          # stack, mounts, iptables rules, hook
node ytadpatch.js uninstall --purge  # also removes /opt/usr/home/owner/ytad
```

Removing does not undo trust: the imported CA stays in the TV store until you delete it in CaBox.

## License

MIT, see [LICENSE](LICENSE).
