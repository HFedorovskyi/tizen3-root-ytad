# tizen3-root-ytad

Root на Samsung TV 2017 (Tizen 3.0, прошивка `T-KTMDEUC`, проверено на `UE55MU6179`) и стоковый YouTube без рекламы. Два независимых пакета, работают поверх sdb и одного systemd-юнита.

```
tizenroot/   root-инжектор: uid 0, джоб-раннер, автоподъём после ребута, хуки
ytadpatch/   патч YouTube: DNS-пиннинг + TLS-MITM, реклама вырезается из ответов
```

## Как это работает

**Доступ.** Шелл `appcmd` даёт `uid 5001 (owner)` и используется только для файловых операций. Root появляется через системный D-Bus метод `ExecuteUserShell` (jpmsd): он срабатывает лишь из контекста Smack `User`, поэтому вызов живёт в watchdog-скрипте под `systemd --user`, а не в sdb-шелле.

**Живучесть.** Юнит `rootinject.service` (`Restart=always`) стартует при загрузке, следит за heartbeat-файлом rootd и заново инжектит `/bin/sh < rootd.sh`, если процесс умер. `rootd.sh` — джоб-раннер: скрипты кладутся в `/tmp/root.cmd` (последняя строка `#END`), исполняются как root, вывод в `/tmp/root.out`. На старте rootd запускает все хуки `$BASE/hooks/*.sh`.

**YouTube.** `ytadpatch` кладёт хук `10-ytad.sh` и стек в `/opt/usr/home/owner/ytad/`:

- `hosts` пиннит `www.youtube.com`, `youtubei.googleapis.com`, `c.youtube.com`, `redirector.googlevideo.com` в `0.0.0.0` (= loopback), `/etc/hosts` bind-mount;
- `dnsd.js` поднимается на `127.0.0.1:53`, DNAT перенаправляет туда запросы к шлюзу;
- `srv.js` слушает `127.0.0.1:443`, терминирует TLS своим листом, ходит на реальный backend по DoH, вырезает рекламные ключи из JSON, блокирует `onesie /initplayback` и переписывает запрос `/youtubei/v1/player` на WEB-клиент (в TV-ответе реклама приходит через SSDAI и не режется);
- `alt-svc` вырезается из ответов, UDP 443/80 дропается — иначе Chromium уходит в HTTP/3 мимо прокси.

## Требования

- TV 2017 на Tizen 3.0 с Developer mode; `Host PC IP` = адрес ПК; порт `26101` доступен.
- Node.js 18+.
- `sdb` (в пакете не лежит; путь передаётся `--sdb`, либо `sdb` в `PATH`).
- OpenSSL в `PATH` (генерация CA/листа при первом `ytadpatch install`).
- Windows: запускать из Git Bash, для `push/pull` с путями `/opt/...` нужен `MSYS_NO_PATHCONV=1`.

## Быстрый старт

```sh
# 1. root + автоподъём после ребута
node tizenroot/tizenroot.js --serial 192.168.1.50:26101 install

# 2. патч YouTube (первый запуск генерирует CA/лист в ytadpatch/tv/tls/)
node ytadpatch/ytadpatch.js --serial 192.168.1.50:26101 install
```

`ytadpatch install` соберёт на ТВ три trust-бандла из штатных файлов Samsung + ваш CA и положит CA для CaBox. Если в логе/на экране появится `alert 48 unknown_ca` — импортировать `/opt/usr/home/owner/share/xwalk_cert/phantom_ca.pem` через CaBox и перезапустить YouTube.

Проверка: `node ytadpatch/ytadpatch.js status`, в `/tmp/tlssrv.log` должны идти `TLS_OK` и `POST /youtubei/v1/player … adrm=N`, запросов `/api/stats?el=adunit` быть не должно.

## Команды

```sh
node tizenroot/tizenroot.js  probe | sh <cmd> | job <file> | push | pull | hook <file> | install | uninstall | status
node ytadpatch/ytadpatch.js  install | start | uninstall [--purge] | status | logs [n]
```

`uninstall` снимает DNAT, QUIC-DROP, bind-монтирования и хук; `uninstall --purge` ещё удаляет `/opt/usr/home/owner/ytad`.

## Структура

```
tizenroot/
  tizenroot.js              CLI: appcmd-шелл, base64-транспорт, root-джобы, установка
  tv/rootd.sh               root job runner + запуск хуков
  tv/rootinject.sh          watchdog (инжект при старте/смерти rootd)
  tv/rootinject.service     systemd --user unit
ytadpatch/
  ytadpatch.js              CLI: деплой стека и хука
  tv/10-ytad.sh             boot-хук: bind-монтирования, dnsd/srv, DNAT, QUIC-DROP
  tv/dnsd.js                DNS-прокси на 127.0.0.1:53
  tv/srv.js                 TLS-MITM + вырезание рекламы
  tv/hosts                  пиннинг YouTube + блоклист телеметрии/OTA
  tv/hijack                 те же имена → 0.0.0.0 (для dnsd)
  certs/make_certs.sh       генерация CA/листа (в git не попадают)
```

## Особенности этой прошивки

- **Хуки и скрипты — только через stdin:** `sh /opt/.../hook.sh` зависает навсегда, `sh < hook.sh` работает. То же с `sh -n`.
- `appcmd` иногда возвращает пустой вывод — команды стоит дробить, клиент ретраит.
- Файл, созданный root, из owner-шелла не переименовать (VDFS): установщик сверяет md5 и при расхождении делает замену root-джобой.
- Большая заливка через `appcmd` (сотни чанков) может подвесить демон sdb целиком — помогает только цикл питания. В клиенте есть md5-скип и паузы.
- `app_launcher -t` не убивает живое приложение; надёжно — `kill -9` по pid из `ps -ef`.

## Восстановление

- sdb «closed»/offline, завис UI → выдернуть питание на 10 с. После загрузки юнит сам поднимет rootd и хук.
- Чёрный экран YouTube → проверить, что `srv.js` слушает: `grep 0100007F:01BB /proc/net/tcp`; имя пиннится в loopback, без прокси приложение не откроется.
- Реклама вернулась → `node ytadpatch/ytadpatch.js status`: должен быть `alt-svc`-фикс (в логе нет QUIC-ошибок), DROP UDP/443 и `adrm` в player-ответе.

## Сертификаты

CA и лист генерируются на каждую установку (`ytadpatch/certs/make_certs.sh`), в репозитории их нет. `certs/ca.key` — приватный: он подписывает лист, которому доверяет ТВ. `tv/tls/*`, `certs/ca.key`, `certs/*.srl` в `.gitignore`.

## Лицензия

MIT, см. [LICENSE](LICENSE).
