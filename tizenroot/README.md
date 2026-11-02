# tizenroot

Root injector for Samsung 2017 TVs running Tizen 3.0. It gives a root shell that survives reboots and a hook mechanism, which [tizen3-ytad](https://github.com/HFedorovskyi/tizen3-ytad) builds on.

Tested on `UE55MU6179` (`T-KTMDEUC`, Tizen 3.0). Other Tizen 3.0 models are likely to work the same way, but the D-Bus service and the shell quirks below are model-specific.

**Русская версия:** [README.ru.md](README.ru.md)

## Access model

| Channel | Who | What it can do |
|---|---|---|
| `appcmd:runapp:x; <cmd>` over sdb | `uid 5001 (owner)`, Smack `System` | files, `/proc`, `systemctl --user`, start root jobs |
| `ExecuteUserShell` (D-Bus, jpmsd) | `uid 0`, Smack `System` | everything; **only works from the `User` context** (the watchdog); from appcmd it returns `0:-1:EMPTY:EMPTY` |

Root commands never run directly — they go through the live `rootd` as jobs:

```sh
node tizenroot.js job ./script.sh     # runs as uid 0
node tizenroot.js sh 'id'             # uid 5001, for file operations
```

Job protocol: the script is uploaded to `/tmp/root.cmd` with `#END` as the last line; rootd renames it to `/tmp/root.job` and runs `sh < job`, output is appended to `/tmp/root.out`.

## Install

```sh
node tizenroot.js --serial 192.168.1.50:26101 install
```

What it does:

1. uploads `rootd.sh` and `rootinject.sh` into `/opt/usr/home/owner/` (a root-owned file left by a previous install is replaced through a root job after an md5 check);
2. writes `rootinject.service` to `/home/owner/.config/systemd/user/` and enables it in `default.target`;
3. stops the watchdog and kills the old rootd with its own job (`kill -9` plus pid cleanup);
4. `systemctl --user start rootinject.service`, waits for the new pid and checks the unit.

The watchdog:

- on start, if there is no pid file, it injects immediately (about 1–3 s after boot);
- every 10 s: pid dead → inject; heartbeat unchanged for 35 s → inject;
- an injection only counts as successful when `/tmp/rootd.pid` points to a live process.

The heartbeat file `$BASE/rootd.beat` is created by the watchdog itself (Smack label `User`); rootd only rewrites the existing inode.

## Hooks

`$BASE/hooks/*.sh` run as root every time rootd starts, one by one, in the background, with output in `/tmp/hooks.log`:

```sh
( for h in "$BASE"/hooks/*.sh; do [ -f "$h" ] && sh < "$h"; done ) >> /tmp/hooks.log 2>&1 &
```

`sh < "$h"` and not `sh "$h"`: on this firmware running a script located under `$BASE` as an argument hangs the shell forever. Install a hook and run it right away:

```sh
node tizenroot.js hook ./myhook.sh myhook
```

## Commands

```
probe                 who we are and uptime
sh <cmd>              run a command as owner
job <file>            run a script as root (60 s timeout by default)
push <local> <remote> [mode]   base64 transport (sdb push does not work on retail)
pull <remote> <local> [chunk]
hook <file> [name]    install a hook and run it now
install / uninstall / status
```

Options: `--serial`, `--sdb PATH`, `--port`, `--timeout`.

## Files on the TV

```
/opt/usr/home/owner/rootd.sh          job runner
/opt/usr/home/owner/rootinject.sh     watchdog
/opt/usr/home/owner/rootinject.pid    watchdog pid (written by the script itself)
/opt/usr/home/owner/rootd.beat        heartbeat
/opt/usr/home/owner/hooks/            boot hooks
/tmp/root.cmd /tmp/root.job           job queue
/tmp/root.out /tmp/hooks.log          output
```

Unit: `/home/owner/.config/systemd/user/rootinject.service`
(`ExecStart=/bin/sh -c "sh < /opt/usr/home/owner/rootinject.sh"`, `Restart=always`).

## Debugging

```sh
node tizenroot.js status
node tizenroot.js sh 'tail -5 /opt/usr/home/owner/rootinject.log'
node tizenroot.js sh 'systemctl --user status rootinject.service'
```

- no new pid after `install` → `rootinject.log` (D-Bus error), `systemctl --user status`;
- unit `active` but rootd is dead → the watchdog restarts it within 10 s; manually: `systemctl --user restart rootinject.service`;
- sdb stopped answering everything → power cycle; the chain comes back on its own.

## Limits

- `sh -n <file>` hangs on the device — check syntax locally.
- A file created by root cannot be renamed from the owner shell; replace it with a root job.
- `appcmd` is capped at ~4096 bytes per command and sometimes returns an empty answer — the transport chunks files and retries.
- Do not touch `kfactoryd SetData`, the WAS database, or `mount -o remount,rw /`.

## License

MIT, see [LICENSE](LICENSE).
