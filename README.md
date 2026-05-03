# SockRoute

SockRoute is a small OpenWrt service for manually routing selected LAN clients through a chosen SOCKS outbound without restarting the main proxy stack.

It provides:

- a separate transparent `sing-box` instance;
- nftables set based client switching;
- a LuCI page under `Services -> SockRoute`;
- a local HTTP API for Home Assistant or other LAN automation;
- named SOCKS outbound profiles;
- live nft counters for routed clients.

## Quick Install

Run on the OpenWrt router:

```sh
wget -O /tmp/sockroute-install.sh https://raw.githubusercontent.com/Kemper51rus/SockRoute/main/install.sh
sh /tmp/sockroute-install.sh
```

Short form:

```sh
wget -O - https://raw.githubusercontent.com/Kemper51rus/SockRoute/main/install.sh | sh
```

The installer:

- installs required packages with `apk` or `opkg`;
- backs up existing SockRoute files to `/root/sockroute-backups/<timestamp>`;
- installs service, API and LuCI files;
- creates `/etc/config/sockroute` and `/etc/config/sockroute_api` if they do not exist;
- detects `passwall2` hooks when available, otherwise uses standard `fw4` hooks;
- enables and starts `/etc/init.d/sockroute`;
- clears LuCI caches and restarts `rpcd`/`uhttpd`.

## Requirements

- OpenWrt with nftables/firewall4.
- `sing-box`.
- A reachable SOCKS5 endpoint. It can be local, for example `127.0.0.1:1080`, or on another LAN host.
- Existing nft hook chains:
  - preferred: `inet passwall2 PSW2_NAT` and `inet passwall2 PSW2_MANGLE`;
  - fallback: `inet fw4 dstnat` and `inet fw4 mangle_prerouting`.

## Configure

Open LuCI:

```text
Services -> SockRoute
```

Or use CLI:

```sh
/usr/libexec/sockroute socks-list
/usr/libexec/sockroute set-socks 127.0.0.1 1080
/etc/init.d/sockroute restart
```

Add a client:

```sh
/usr/libexec/sockroute add-named 192.168.1.100 "Client"
```

Remove a client from runtime routing:

```sh
/usr/libexec/sockroute del 192.168.1.100
```

Delete a client from the saved profile:

```sh
/usr/libexec/sockroute delete-client 192.168.1.100
```

## HTTP API

Default endpoint:

```text
http://192.168.1.1/cgi-bin/sockroute-api?ip=192.168.1.100&action=status
```

Actions:

- `status`
- `on`
- `off`
- `toggle`

Optional outbound override:

```text
http://192.168.1.1/cgi-bin/sockroute-api?ip=192.168.1.100&action=on&outbound=Tor
http://192.168.1.1/cgi-bin/sockroute-api?ip=192.168.1.100&action=on&outbound=192.168.1.10:1080
http://192.168.1.1/cgi-bin/sockroute-api?ip=192.168.1.100&action=on&outbound=default
```

API access is restricted by `/etc/config/sockroute_api`:

```sh
uci add_list sockroute_api.main.allowed_source_ip='192.168.1.2'
uci set sockroute_api.main.allowed_target_cidr='192.168.1.0/24'
uci commit sockroute_api
```

If `sockroute_api.main.token` is set, pass it as `token=...` or `X-SockRoute-Token`.

## Home Assistant

The LuCI page generates `command_line` YAML for current clients.

Example:

```yaml
command_line:
  - switch:
      name: "Client SockRoute"
      unique_id: sockroute_client
      command_state: >-
        curl -fsS --max-time 10 "http://192.168.1.1/cgi-bin/sockroute-api?ip=192.168.1.100&action=status"
      value_template: "{{ value == 'ON' }}"
      command_on: >-
        curl -fsS --max-time 15 "http://192.168.1.1/cgi-bin/sockroute-api?ip=192.168.1.100&action=on"
      command_off: >-
        curl -fsS --max-time 15 "http://192.168.1.1/cgi-bin/sockroute-api?ip=192.168.1.100&action=off"
```

After changing `configuration.yaml`, run:

```sh
ha core check
ha core restart
```

## Diagnostics

```sh
/etc/init.d/sockroute status
/usr/libexec/sockroute health
/usr/libexec/sockroute list
/usr/libexec/sockroute check-client 192.168.1.100
nft list set inet fw4 sockroute_clients
logread -e sockroute
logread -e sockroute-api
```

## Uninstall

```sh
/etc/init.d/sockroute stop
/etc/init.d/sockroute disable
/usr/libexec/sockroute teardown
rm -f /etc/init.d/sockroute /usr/libexec/sockroute /usr/libexec/sockroute-api /www/cgi-bin/sockroute-api
rm -f /usr/share/luci/menu.d/luci-app-sockroute.json
rm -f /usr/share/rpcd/acl.d/luci-app-sockroute.json
rm -f /www/luci-static/resources/view/sockroute.js
```

Configs are intentionally not removed by the command above:

```sh
rm -f /etc/config/sockroute /etc/config/sockroute_api
```

## Details

See [docs/reference.md](docs/reference.md).

