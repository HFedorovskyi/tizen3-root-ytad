# tizen3-ytad

Стоковый YouTube без рекламы на Samsung TV 2017 (Tizen 3.0). Локальный TLS-MITM: приложение думает, что говорит с YouTube, прокси вырезает рекламу из ответов. Поверх стокового приложения ничего не ставится — ни sideload-виджетов, ни замены клиента.

Требует root-инжектор [tizen3-root](https://github.com/HFedorovskyi/tizen3-root) (пакет `tizenroot`).

**English version:** [README.md](README.md)

## Что происходит на ТВ

1. `/etc/hosts` (bind-mount из `$Y/hosts`) пиннит `www.youtube.com`, `youtubei.googleapis.com`, `c.youtube.com`, `redirector.googlevideo.com` в `0.0.0.0`, то есть в loopback. Резолв работает даже раньше DNS-прокси.
2. `dnsd.js` слушает `127.0.0.1:53`; `iptables -t nat` перенаправляет на него UDP/53 к шлюзу. Он же отдаёт sinkhole-адреса для телеметрии Samsung и OTA (список в `tv/hosts`).
3. `srv.js` слушает `127.0.0.1:443`, принимает TLS с листом, подписанным локальным CA, и проксирует к настоящему Google по DoH. В ответах:
   - из JSON вырезаются `adPlacements`, `playerAds`, `adSlots`, `adSlotRenderer`, `promoted*` и т.п.;
   - запрос `/youtubei/v1/player` переписывается на WEB-клиент (без `authorization`), потому что TVHTML5 отдаёт рекламу через SSDAI прямо в стрим;
   - `onesie /initplayback` отвечает 503, чтобы плеер вернулся к обычному player-запросу;
   - `alt-svc` вырезается, UDP/443 и UDP/80 дропаются — иначе Chromium переходит на HTTP/3 в обход прокси.
4. `10-ytad.sh` (boot-хук из tizenroot) делает bind-монтирования, поднимает оба демона, ставит DNAT/DROP и перезапускает YouTube, если тот стартовал до готовности стека.

## Установка

Клонируйте оба репозитория рядом — патчер ищет `../tizen3-root/tizenroot.js`:

```sh
git clone https://github.com/HFedorovskyi/tizen3-root.git
git clone https://github.com/HFedorovskyi/tizen3-ytad.git
```

Сначала инжектор, потом патч:

```sh
node tizen3-root/tizenroot.js --serial 192.168.1.50:26101 install
node tizen3-ytad/ytadpatch.js --serial 192.168.1.50:26101 install
```

Если репозитории лежат не рядом, путь задаётся переменной `TIZENROOT=/path/to/tizenroot.js`.

Что делает `ytadpatch install`:

1. Если в `tv/tls/` нет пары — генерирует CA и лист (`certs/make_certs.sh`, нужен openssl).
2. Заливает стек в `/opt/usr/home/owner/ytad/` и хук в `/opt/usr/home/owner/hooks/10-ytad.sh` (md5-скип: неизменившееся не пересылается).
3. Собирает на ТВ три trust-бандла из **штатных** файлов Samsung + ваш CA (`/usr/share/cert/{webapp,ca,webbrowser}.pem`); если наш бандл уже смонтирован, делает `umount`, чтобы увидеть оригинал, и защищается от самодописывания проверкой inode.
4. Кладёт CA в `$BASE/share/xwalk_cert/phantom_ca.pem` — оттуда его импортирует CaBox.
5. Гасит старый стек, запускает хук.

## Доверие сертификату

CA уникален для установки; в репозитории ключей нет, а trust-бандлы собираются на самом ТВ. После первого запуска:

- CaBox обычно импортирует `phantom_ca.pem` сам;
- если приложение отвечает `alert 48 unknown_ca` — открыть CaBox и импортировать этот файл, затем перезапустить YouTube (`kill -9 <pid>` + `app_launcher -s`, либо просто ребут);
- сменили CA (`certs/make_certs.sh` вручную) — старый импорт больше не действует, повторить импорт.

`certs/ca.key` — приватный ключ: он подписывает лист, которому доверяет ТВ. В git его нет и быть не должно.

## Проверка

```sh
node ytadpatch.js status      # монтирования, процессы, iptables, флаги, хвост логов
node ytadpatch.js logs 40
```

Признаки нормы:

- `/tmp/tlssrv.log`: `TLS_OK sni=www.youtube.com`, `POST /youtubei/v1/player … adrm=4`;
- нет строк `/api/stats?…el=adunit` (счётчик `grep -c adunit` = 0);
- `watchtime … state=playing`;
- `grep 0100007F:01BB /proc/net/tcp` — прокси слушает.

## Диагностика

| Симптом | Причина / что смотреть |
|---|---|
| Чёрный экран или вылет YouTube после ребута | `srv.js` не запущен, а имя уже пиннится в loopback. Проверить `ps -ef \| grep srv.js`, `tail /tmp/tlssrv.err`, наличие `$Y/srv.js` (не `$Y/tls/srv.js`) |
| Реклама вернулась | приложение ушло в HTTP/3: нет ли `alt-svc` в ответах, стоит ли DROP UDP/443; либо player-запрос прошёл мимо прокси — искать `/youtubei/v1/player` в логе |
| `alert 48 unknown_ca` | CA не в trust store ТВ: импорт через CaBox (см. выше) |
| Бесконечная загрузка после смены конфигурации | живой экземпляр держит старые сокеты: `kill -9` приложения и запустить заново (`app_launcher -s`) |
| Нет звука/картинки, но трафик идёт | player-ответ получен с TVHTML5/SSDAI: проверить, что rewrite на WEB сработал (`adrm` > 0) |

## Удаление

```sh
node ytadpatch.js uninstall          # снять стек, монтирования, правила, хук
node ytadpatch.js uninstall --purge  # плюс удалить /opt/usr/home/owner/ytad
```

Удаление не откатывает trust: импортированный CA остаётся в хранилище ТВ, пока его не убрать через CaBox.

## Лицензия

MIT, см. [LICENSE](LICENSE).
