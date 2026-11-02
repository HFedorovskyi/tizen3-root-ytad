# tizenroot

Root-инжектор для Samsung TV 2017 (Tizen 3.0). Даёт root-шелл, устойчивый к ребуту, и механизм хуков, на котором держится [tizen3-ytad](https://github.com/HFedorovskyi/tizen3-ytad).

Проверено на `UE55MU6179` (`T-KTMDEUC`, Tizen 3.0). На других Tizen 3.0-моделях, скорее всего, работает так же, но D-Bus-сервис и особенности шелла ниже привязаны к модели.

**English version:** [README.md](README.md)

## Модель доступа

| Канал | Кто | Что может |
|---|---|---|
| `appcmd:runapp:x; <cmd>` через sdb | `uid 5001 (owner)`, Smack `System` | файлы, чтение `/proc`, `systemctl --user`, запуск root-джоб |
| `ExecuteUserShell` (D-Bus, jpmsd) | `uid 0`, Smack `System` | всё; **работает только из контекста `User`** (watchdog), из appcmd возвращает `0:-1:EMPTY:EMPTY` |

Root-команды идут не напрямую, а джобами через живой `rootd`:

```sh
node tizenroot.js job ./script.sh     # скрипт исполняется как uid 0
node tizenroot.js sh 'id'             # uid 5001, для файловых операций
```

Протокол джобы: содержимое пишется в `/tmp/root.cmd`, последняя строка `#END`; rootd переносит файл в `/tmp/root.job` и исполняет `sh < job`, вывод дописывается в `/tmp/root.out`.

## Установка

```sh
node tizenroot.js --serial 192.168.1.50:26101 install
```

Что делает:

1. заливает `rootd.sh` и `rootinject.sh` в `/opt/usr/home/owner/` (если старый файл принадлежит root — заменяет root-джобой, сверяя md5);
2. кладёт `rootinject.service` в `/home/owner/.config/systemd/user/` и включает его в `default.target`;
3. останавливает watchdog, убивает старый rootd его же джобой (`kill -9` + чистка pid-файла);
4. `systemctl --user start rootinject.service`, ждёт новый pid, проверяет юнит.

Watchdog:

- при старте, если pid-файла нет — инжект сразу (окно после ребута ~1–3 с);
- раз в 10 с: pid мёртв → инжект; heartbeat не менялся 35 с → инжект;
- инжект с проверкой: успех только если `/tmp/rootd.pid` указывает на живой процесс.

Heartbeat `$BASE/rootd.beat` создаёт сам watchdog (метка Smack `User`), rootd только перезаписывает inode.

## Хуки

`$BASE/hooks/*.sh` исполняются rootd при каждом старте, по одному, в фоне, вывод в `/tmp/hooks.log`:

```sh
( for h in "$BASE"/hooks/*.sh; do [ -f "$h" ] && sh < "$h"; done ) >> /tmp/hooks.log 2>&1 &
```

`sh < "$h"`, а не `sh "$h"`: на этой прошивке запуск скрипта путём под `$BASE` аргументом вешает шелл. Установить и сразу прогнать хук:

```sh
node tizenroot.js hook ./myhook.sh myhook
```

## Команды

```
probe                 кто мы и uptime
sh <cmd>              команда как owner
job <file>            скрипт как root (таймаут по умолчанию 60 с)
push <local> <remote> [mode]   base64-транспорт (sdb push на retail не работает)
pull <remote> <local> [chunk]
hook <file> [name]    установить хук и выполнить сейчас
install / uninstall / status
```

Опции: `--serial`, `--sdb PATH`, `--port`, `--timeout`.

## Файлы на ТВ

```
/opt/usr/home/owner/rootd.sh          джоб-раннер
/opt/usr/home/owner/rootinject.sh     watchdog
/opt/usr/home/owner/rootinject.pid    pid watchdog (пишет сам скрипт)
/opt/usr/home/owner/rootd.beat        heartbeat
/opt/usr/home/owner/hooks/            boot-хуки
/tmp/root.cmd /tmp/root.job           очередь джоб
/tmp/root.out /tmp/hooks.log          вывод
```

Юнит: `/home/owner/.config/systemd/user/rootinject.service`
(`ExecStart=/bin/sh -c "sh < /opt/usr/home/owner/rootinject.sh"`, `Restart=always`).

## Отладка

```sh
node tizenroot.js status
node tizenroot.js sh 'tail -5 /opt/usr/home/owner/rootinject.log'
node tizenroot.js sh 'systemctl --user status rootinject.service'
```

- нет нового pid после `install` → `rootinject.log` (ошибка D-Bus), `systemctl --user status`;
- юнит `active`, rootd мёртв → watchdog перезапустит за ≤10 с; руками: `systemctl --user restart rootinject.service`;
- sdb перестал отвечать на всё → цикл питания, после загрузки цепочка поднимется сама.

## Ограничения

- `sh -n <file>` на устройстве зависает — синтаксис проверять локально.
- Файлы, созданные root, из owner-шелла не переименовать; заменять root-джобой.
- `appcmd` ограничен ~4096 байт на команду и иногда отдаёт пустой ответ — транспорт дробит файлы на чанки и ретраит.
- Не трогать `kfactoryd SetData`, WAS-базу и `mount -o remount,rw /`.

## Лицензия

MIT, см. [LICENSE](LICENSE).
