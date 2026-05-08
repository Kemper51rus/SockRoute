# Справочник SockRoute

SockRoute - это веб-сервис для LuCI на OpenWrt: он даёт страницу `Сервисы -> SockRoute`, локальный HTTP API и отдельную runtime-службу для ручной маршрутизации выбранных LAN-клиентов через SOCKS outbound без перезапуска основного прокси-стека.

Схема:

- `sockroute` держит отдельный прозрачный `sing-box` на порту `1042`;
- выбранные IP лежат в nft set `sockroute_clients`;
- TCP/UDP трафик этих IP перенаправляется в `1042`;
- DNS клиентов SockRoute при `realip_dns=1` перехватывается в локальный DNS handler на `dns_port`, чтобы UDP/53 не уходил в выбранный SOCKS outbound как обычный UDP;
- `sing-box` отправляет внешний трафик в настраиваемый SOCKS outbound, по умолчанию `127.0.0.1:1080`;
- SOCKS outbound можно хранить как именованные профили и быстро выбирать глобально или для отдельного клиента;
- для отдельного клиента можно переопределить SOCKS через LuCI `Edit` или CLI;
- домашняя сеть `192.168.1.0/24` остаётся напрямую.

## Файлы

Основные пути:

```text
/etc/config/sockroute
/etc/config/sockroute_api
/etc/init.d/sockroute
/usr/libexec/sockroute
/usr/libexec/sockroute-api
/www/cgi-bin/sockroute-api
```

## Веб-сервис LuCI

```text
Сервисы -> SockRoute
```

Страница содержит:

- список клиентов с `ON/OFF`, `Edit`, проверкой клиента и удалением;
- источник клиента: `profile` или `runtime only`;
- живые счётчики nft по клиентам: объём и пакеты, которые реально попали в `sockroute_clients`;
- сохранённые SOCKS профили с именами, endpoint, внешним IP через `ident.me`, использованием профиля клиентами и кнопками `По умолчанию`, `Проверить`, `Edit`, `Удалить`;
- настройку глобального SOCKS outbound через сохранённый профиль, найденный SOCKS-кандидат или ручной IP/порт;
- быстрый выбор SOCKS outbound прямо в таблице клиентов и расширенный SOCKS override в `Edit`;
- 5 лёгких карточек статуса: страница открывается без ожидания полного health-check, а диагностика обновляет карточки уже после отрисовки;
- кнопку `Диагностика`, которая по требованию открывает модалку с проверкой сервиса, nft hook-правил, transparent port, SOCKS outbound и API;
- автоматическую проверку внешнего IP через каждый сохранённый SOCKS: `curl https://ident.me` обновляет таблицу SOCKS outbound в фоне каждые 30 секунд;
- одиночное добавление клиента из закреплённой DHCP host-записи и массовый импорт из того же списка;
- блок `API` с разрешёнными IP, CIDR-сетью допустимых клиентов и optional token;
- раскрываемые `Как пользоваться API` и примеры API URL с copy-кнопками;
- раскрываемый блок `Home Assistant command_line`, который генерируется по текущему списку клиентов и умеет копировать YAML.

## API

Endpoint:

```text
http://192.168.1.1/cgi-bin/sockroute-api?ip=192.168.1.100&action=status
```

Параметры:

- `ip=192.168.1.X` - IP клиента;
- `action=status|on|off|toggle`;
- `outbound=...` - опционально для `on`/`toggle` при включении: имя сохранённого SOCKS профиля, его section или endpoint `HOST:PORT`; `default` очищает клиентский override;
- `format=json` - опционально, вместо текстового `ON/OFF`;
- `token=...` - если задан `sockroute_api.main.token`.

Доступ к HTTP API разрешён только с IP из `sockroute_api.main.allowed_source_ip`. По умолчанию это `192.168.1.2`. Если задан `sockroute_api.main.token`, запрос должен передать тот же token параметром `token=...` или заголовком `X-SockRoute-Token`.

Примеры:

```sh
curl -fsS "http://192.168.1.1/cgi-bin/sockroute-api?ip=192.168.1.100&action=status"
curl -fsS "http://192.168.1.1/cgi-bin/sockroute-api?ip=192.168.1.100&action=on"
curl -fsS "http://192.168.1.1/cgi-bin/sockroute-api?ip=192.168.1.100&action=on&outbound=Tor"
curl -fsS "http://192.168.1.1/cgi-bin/sockroute-api?ip=192.168.1.100&action=off"
```

Без `outbound` API меняет только наличие IP в runtime nft set. Разные SOCKS outbound хранятся в профиле клиента и используются только когда клиент включён в SockRoute. Если `outbound` передан, API обновляет профиль клиента и перезапускает только `sockroute`, не основной прокси-стек.

CLI-режим не проверяет IP источника и удобен для диагностики:

```sh
/usr/libexec/sockroute-api 192.168.1.100 status
/usr/libexec/sockroute-api 192.168.1.100 on
/usr/libexec/sockroute-api 192.168.1.100 off
```

## Сервис

Проверка и ручное управление:

```sh
/etc/init.d/sockroute running
/usr/libexec/sockroute list
/usr/libexec/sockroute add-named 192.168.1.114 "Мой клиент"
/usr/libexec/sockroute rename 192.168.1.114 "Новое имя"
/usr/libexec/sockroute del 192.168.1.114
/usr/libexec/sockroute delete-client 192.168.1.114
/usr/libexec/sockroute check-client 192.168.1.114
/usr/libexec/sockroute dhcp-list
/usr/libexec/sockroute health
```

SOCKS outbound:

```sh
/usr/libexec/sockroute socks-list
/usr/libexec/sockroute socks-profiles
/usr/libexec/sockroute set-socks-profile - "Локальный SOCKS 1080" 127.0.0.1 1080
/usr/libexec/sockroute test-socks-profile socks_127_0_0_1_1080
/usr/libexec/sockroute set-socks-ref socks_127_0_0_1_1080
/usr/libexec/sockroute set-socks 127.0.0.1 1080
/usr/libexec/sockroute test-socks 127.0.0.1 1080
/usr/libexec/sockroute test-socks-ident 127.0.0.1 1080
/usr/libexec/sockroute set-client-socks-ref 192.168.1.100 socks_127_0_0_1_1080
/usr/libexec/sockroute set-client-socks 192.168.1.100 192.168.1.10 1080
/usr/libexec/sockroute clear-client-socks 192.168.1.100
/etc/init.d/sockroute restart
```

`set-socks-profile - ...` создаёт новый профиль, сразу делает быструю проверку через `curl --socks5-hostname` и сохраняет результат в UCI (`last_check`, `last_check_detail`, `last_check_time`). Сырой текст проверки остаётся во всплывающей подсказке колонки `Проверка`. Если endpoint уже есть, новый профиль получает суффикс UCI-section вида `_2`, `_3`; редактирование существующей записи идёт по её section.

Колонка `Использование` показывает, где профиль задействован в текущей таблице клиентов: `N клиентов / объём трафика` или `не используется`. Объём суммируется из runtime nft-счётчиков клиентов, которые сейчас назначены на этот SOCKS profile; подробные пакеты/байты доступны во всплывающей подсказке. Для профиля по умолчанию счётчик включает клиентов без индивидуального override и клиентов, где этот профиль выбран явно; сам default уже отмечен меткой рядом с названием.

LuCI-страница сначала открывается по лёгким данным из UCI и статусу init-скрипта, а runtime set, DHCP host-записи и найденные SOCKS endpoint дозагружает после первого отображения. После загрузки работают два фоновых цикла только пока открыта страница: трафик клиентов обновляется через команду только для чтения `/usr/libexec/sockroute list` раз в 5 секунд, а сохранённые SOCKS профили последовательно проверяются через `test-socks-ident HOST PORT` раз в 30 секунд. Эти проверки не пишут UCI, не пересоздают nft setup и не перезапускают сервисы; `ident.me` делает сетевой запрос через каждый сохранённый SOCKS. Счётчики трафика существуют только в runtime: они не пишутся на диск и могут обнулиться после пересоздания nft set, перезапуска SockRoute или перезагрузки роутера.

Действия LuCI-страницы не вызывают полную перезагрузку браузера. После добавления, удаления, редактирования клиента, изменения default SOCKS, сохранения API или обслуживания SockRoute страница заново читает `sockroute`, `sockroute_api` и runtime-данные, затем мягко заменяет содержимое `#sockroute-root`; открытые раскрывающиеся блоки сохраняют своё состояние.

### LuCI cache после обновления страницы

LuCI загружает `/www/luci-static/resources/view/sockroute.js` как JS-модуль с версией из URL: `sockroute.js?v=<resource_version>`. На OpenWrt 25/26 с apk эта версия берётся из `mtime` файла `/lib/apk/db/installed`, а на opkg-системах - из `/usr/lib/opkg/status`. Если заменить `sockroute.js` вручную через `scp`, но не обновить этот timestamp, браузер может продолжать использовать старый JS-модуль, и новые поля/стили не появятся даже после очистки `/tmp/luci-*` и перезапуска `uhttpd`.

После ручной замены LuCI-файлов выполняй cache-bust так:

```sh
[ -e /lib/apk/db/installed ] && touch /lib/apk/db/installed
[ -e /usr/lib/opkg/status ] && touch /usr/lib/opkg/status
rm -f /tmp/luci-indexcache* /tmp/luci-requirecache* /tmp/luci-modulecache*
rm -rf /tmp/luci-* /tmp/lib/luci-* /tmp/luci-sessions
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart
```

Проверка, что версия реально изменилась:

```sh
curl -s http://127.0.0.1/cgi-bin/luci | sed -n '/luci.js?v=/p' | head -1
curl -s 'http://127.0.0.1/luci-static/resources/view/sockroute.js?v=NEW_VERSION' | grep 'DNS по умолчанию'
```

Если страница уже открыта в браузере, закрой вкладку и открой `Сервисы -> SockRoute` заново: текущая LuCI-страница держит уже загруженный JS-модуль в памяти.

`socks-list` не хранит подписи вручную. Helper читает поддерживаемые UCI/runtime-файлы proxy stack, поэтому источник SOCKS показывается по фактическому состоянию роутера. Типичные варианты:

- routing SOCKS основного proxy stack: может проходить через его geo/shunt-правила;
- отдельный SOCKS inbound из UCI: может быть привязан к конкретной proxy-node и слушать не только localhost;
- `127.0.0.1:1080` - локальный SOCKS endpoint по умолчанию для чистой установки.

Счётчики:

```sh
/usr/libexec/sockroute list
nft list set inet fw4 sockroute_clients
```

В новых runtime-правилах `sockroute_clients` создаётся с `counter`, а TCP/UDP правила имеют `counter` перед redirect/tproxy. Счётчики помогают увидеть, что конкретный IP действительно попадает в SockRoute. Они существуют только в runtime и могут обнулиться после пересоздания nft set или перезапуска сервиса.

DNS-перехват:

```sh
/usr/libexec/sockroute check-client 192.168.1.100
nft list chain inet fw4 SOCKROUTE_NAT
nft list chain inet fw4 SOCKROUTE_MANGLE
```

При включённом `realip_dns` в обеих цепочках должен быть комментарий `sockroute_dns_hijack`: в `SOCKROUTE_MANGLE` UDP/53 возвращается из tproxy-цепочки, а в `SOCKROUTE_NAT` UDP/TCP 53 перенаправляется на `:<dns_port>`. Это важно для outbound, где SOCKS endpoint не обслуживает UDP DNS стабильно.

При сохранении `dns_server` для клиента SockRoute проверяет каждый указанный DNS через временный локальный `sing-box` и тот же SOCKS outbound, который назначен этому клиенту. Если хотя бы один DNS не отвечает через этот SOCKS, список не сохраняется. В рабочем `/etc/sockroute/sing-box.json` DNS-серверы клиента получают `detour` на тот же SOCKS outbound.

```sh
/usr/libexec/sockroute set-client-dns 192.168.1.100 https://example.com/dns-query tls://dns.example.net
```

Домен и таймаут проверки настраиваются через `sockroute.main.dns_check_domain` и `sockroute.main.dns_check_timeout`.

Откат сервиса:

```sh
/etc/init.d/sockroute stop
/etc/init.d/sockroute disable
/usr/libexec/sockroute teardown
```

## Home Assistant

В LuCI блок `Home Assistant command_line` генерирует YAML по текущим клиентам. Пример одного switch:

```yaml
command_line:
  - switch:
      name: "Клиент SockRoute"
      unique_id: sockroute_client
      command_state: >-
        curl -fsS --max-time 10 "http://192.168.1.1/cgi-bin/sockroute-api?ip=192.168.1.100&action=status"
      value_template: "{{ value == 'ON' }}"
      command_on: >-
        curl -fsS --max-time 15 "http://192.168.1.1/cgi-bin/sockroute-api?ip=192.168.1.100&action=on"
      command_off: >-
        curl -fsS --max-time 15 "http://192.168.1.1/cgi-bin/sockroute-api?ip=192.168.1.100&action=off"
```

Генератор использует чистые SockRoute `unique_id` вида `sockroute_<name>`. После изменения `command_line` в `configuration.yaml` Home Assistant должен перечитать YAML. Для `command_line` самый надёжный вариант - `ha core check`, затем `ha core restart`; иначе HA может продолжать выполнять старую версию YAML.

## Диагностика

```sh
logread -e sockroute
logread -e sockroute-api
/etc/init.d/sockroute running
/usr/libexec/sockroute list
/usr/libexec/sockroute health
/usr/libexec/sockroute check-client 192.168.1.100
/usr/libexec/sockroute socks-list
nft list set inet fw4 sockroute_clients
```

Если SockRoute подключён не к стандартной `fw4` table, текущие nft table/hook chains можно посмотреть так:

```sh
uci -q get sockroute.main.nft_table
uci -q get sockroute.main.nft_nat_hook_chain
uci -q get sockroute.main.nft_mangle_hook_chain
```
