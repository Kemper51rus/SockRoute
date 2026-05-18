#!/bin/sh
set -eu

RAW_BASE="${SOCKROUTE_RAW_BASE:-https://raw.githubusercontent.com/Kemper51rus/SockRoute/main}"
BACKUP_ROOT="${SOCKROUTE_BACKUP_ROOT:-/root/sockroute-backups}"
TMP_DIR="/tmp/sockroute-install.$$"

log() {
	printf '%s\n' "$*"
}

have() {
	command -v "$1" >/dev/null 2>&1
}

fetch() {
	url="$1"
	dst="$2"

	mkdir -p "$(dirname "$dst")"
	if have wget; then
		wget -qO "$dst" "$url"
	elif have curl; then
		curl -fsSL "$url" -o "$dst"
	else
		log "ERROR: wget or curl is required"
		exit 1
	fi
}

install_packages() {
	packages="sing-box curl ca-bundle"

	if have apk; then
		apk update || true
		apk add --no-cache $packages luci-base rpcd uhttpd || true
	elif have opkg; then
		opkg update || true
		opkg install $packages luci-base rpcd uhttpd || true
	else
		log "WARN: no apk/opkg found, skipping package installation"
	fi
}

backup_existing() {
	ts="$(date +%Y%m%d-%H%M%S)"
	backup_dir="$BACKUP_ROOT/$ts"
	mkdir -p "$backup_dir"

	for path in \
		/etc/config/sockroute \
		/etc/config/sockroute_api \
		/etc/init.d/sockroute \
		/usr/libexec/sockroute \
		/usr/libexec/sockroute-api \
		/www/cgi-bin/sockroute-api \
		/usr/share/luci/menu.d/luci-app-sockroute.json \
		/usr/share/rpcd/acl.d/luci-app-sockroute.json \
		/www/luci-static/resources/view/sockroute.js
	do
		if [ -e "$path" ]; then
			mkdir -p "$backup_dir$(dirname "$path")"
			cp -p "$path" "$backup_dir$path"
		fi
	done

	log "Backup: $backup_dir"
}

install_file() {
	rel="$1"
	mode="$2"
	dst="/$rel"
	tmp="$TMP_DIR/$rel"

	fetch "$RAW_BASE/files/$rel" "$tmp"
	mkdir -p "$(dirname "$dst")"
	cp -f "$tmp" "$dst"
	chmod "$mode" "$dst"
}

install_files() {
	mkdir -p "$TMP_DIR"

	install_file "etc/init.d/sockroute" 755
	install_file "usr/libexec/sockroute" 755
	install_file "usr/libexec/sockroute-api" 755
	install_file "www/cgi-bin/sockroute-api" 755
	install_file "usr/share/luci/menu.d/luci-app-sockroute.json" 644
	install_file "usr/share/rpcd/acl.d/luci-app-sockroute.json" 644
	install_file "www/luci-static/resources/view/sockroute.js" 644

	if [ ! -e /etc/config/sockroute ]; then
		install_file "etc/config/sockroute" 644
	fi
	if [ ! -e /etc/config/sockroute_api ]; then
		install_file "etc/config/sockroute_api" 644
	fi
}

detect_lan_if() {
	uci -q get network.lan.device 2>/dev/null ||
		uci -q get network.lan.ifname 2>/dev/null ||
		printf 'br-lan'
}

detect_lan_cidr() {
	iface="$(detect_lan_if)"
	ip -4 addr show dev "$iface" 2>/dev/null | awk '/inet / { print $2; exit }'
}

detect_allowed_source() {
	set -- ${SSH_CLIENT:-}
	if [ -n "${1:-}" ]; then
		printf '%s' "$1"
	else
		printf '192.168.1.2'
	fi
}

configure_nft_hooks() {
	if nft list chain inet passwall2 PSW2_NAT >/dev/null 2>&1 &&
		nft list chain inet passwall2 PSW2_MANGLE >/dev/null 2>&1; then
		uci set sockroute.main.nft_table='passwall2'
		uci set sockroute.main.nft_nat_hook_chain='PSW2_NAT'
		uci set sockroute.main.nft_mangle_hook_chain='PSW2_MANGLE'
		uci set sockroute.main.dns_hijack_table='passwall2'
		uci set sockroute.main.dns_hijack_set='sockroute_clients'
		uci set sockroute.main.dns_hijack_chain='dstnat'
	elif nft list chain inet fw4 dstnat >/dev/null 2>&1 &&
		nft list chain inet fw4 mangle_prerouting >/dev/null 2>&1; then
		uci set sockroute.main.nft_table='fw4'
		uci set sockroute.main.nft_nat_hook_chain='dstnat'
		uci set sockroute.main.nft_mangle_hook_chain='mangle_prerouting'
		uci set sockroute.main.dns_hijack_table='fw4'
		uci set sockroute.main.dns_hijack_set='sockroute_dns_clients'
		uci set sockroute.main.dns_hijack_chain='dstnat'
	else
		log "WARN: no known nft hook chains found; configure sockroute.main.nft_table and hook chains manually"
	fi
}

ensure_config() {
	uci -q get sockroute.main >/dev/null 2>&1 || uci set sockroute.main='service'
	uci set sockroute.main.enabled='1'
	uci set sockroute.main.sing_box_bin='/usr/bin/sing-box'
	uci set sockroute.main.sing_box_config='/etc/sockroute/sing-box.json'
	uci set sockroute.main.log_file='/tmp/sockroute.log'
	uci set sockroute.main.lan_if="$(detect_lan_if)"
	lan_cidr="$(detect_lan_cidr || true)"
	[ -n "$lan_cidr" ] || lan_cidr="$(uci -q get sockroute.main.lan_cidr 2>/dev/null || printf '192.168.1.0/24')"
	uci set "sockroute.main.lan_cidr=$lan_cidr"
	uci -q get sockroute.main.realip_dns >/dev/null 2>&1 || uci set sockroute.main.realip_dns='1'
	uci -q get sockroute.main.realip_dns_addr >/dev/null 2>&1 || uci set sockroute.main.realip_dns_addr='1.1.1.1'
	uci -q get sockroute.main.default_dns_server >/dev/null 2>&1 || uci set sockroute.main.default_dns_server="udp://$(uci -q get sockroute.main.realip_dns_addr 2>/dev/null || printf '1.1.1.1')"
	uci -q get sockroute.main.auto_apply >/dev/null 2>&1 || uci set sockroute.main.auto_apply='0'
	uci -q get sockroute.main.check_loop >/dev/null 2>&1 || uci set sockroute.main.check_loop='0'
	uci -q get sockroute.main.boot_wait_timeout >/dev/null 2>&1 || uci set sockroute.main.boot_wait_timeout='180'
	uci -q get sockroute.main.socks_check_interval >/dev/null 2>&1 || uci set sockroute.main.socks_check_interval='30'
	uci -q get sockroute.main.dns_check_interval >/dev/null 2>&1 || uci set sockroute.main.dns_check_interval='30'
	uci -q get sockroute.main.dns_standard_label >/dev/null 2>&1 || uci set sockroute.main.dns_standard_label='DNS standard'
	uci -q get sockroute.main.dns_standard_server >/dev/null 2>&1 || uci set sockroute.main.dns_standard_server='udp://100.100.0.217'
	uci -q get sockroute.main.dns_unblock_label >/dev/null 2>&1 || uci set sockroute.main.dns_unblock_label='DNS unblock'
	uci -q get sockroute.main.dns_unblock_server >/dev/null 2>&1 || uci set sockroute.main.dns_unblock_server='udp://100.100.0.156'
	uci -q get sockroute.main.dns_port >/dev/null 2>&1 || uci set sockroute.main.dns_port='1053'
	uci -q get sockroute.main.transparent_port >/dev/null 2>&1 || uci set sockroute.main.transparent_port="$(uci -q get sockroute.main.listen_port 2>/dev/null || printf '1042')"
	uci -q get sockroute.main.listen_port >/dev/null 2>&1 || uci set sockroute.main.listen_port='1042'
	uci -q get sockroute.main.socks_host >/dev/null 2>&1 || uci set sockroute.main.socks_host='127.0.0.1'
	uci -q get sockroute.main.socks_port >/dev/null 2>&1 || uci set sockroute.main.socks_port='1080'
	uci set sockroute.main.nft_family='inet'
	uci set sockroute.main.nft_set='sockroute_clients'
	uci set sockroute.main.nft_nat_chain='SOCKROUTE_NAT'
	uci set sockroute.main.nft_mangle_chain='SOCKROUTE_MANGLE'
	uci set sockroute.main.nft_mark='0x50535732'
	uci -q get sockroute.main.dns_hijack_family >/dev/null 2>&1 || uci set sockroute.main.dns_hijack_family='inet'
	uci -q get sockroute.main.dns_hijack_table >/dev/null 2>&1 || uci set sockroute.main.dns_hijack_table='fw4'
	uci -q get sockroute.main.dns_hijack_set >/dev/null 2>&1 || uci set sockroute.main.dns_hijack_set='sockroute_dns_clients'
	uci -q get sockroute.main.dns_hijack_chain >/dev/null 2>&1 || uci set sockroute.main.dns_hijack_chain='dstnat'
	configure_nft_hooks
	uci commit sockroute

	uci -q get sockroute_api.main >/dev/null 2>&1 || uci set sockroute_api.main='general'
	uci set sockroute_api.main.backend='sockroute'
	uci set "sockroute_api.main.allowed_target_cidr=$lan_cidr"
	if ! uci -q get sockroute_api.main.allowed_source_ip >/dev/null 2>&1; then
		uci add_list "sockroute_api.main.allowed_source_ip=$(detect_allowed_source)"
	fi
	uci commit sockroute_api

	if ! uci show sockroute 2>/dev/null | grep -q '=socks'; then
		host="$(uci -q get sockroute.main.socks_host)"
		port="$(uci -q get sockroute.main.socks_port)"
		section="socks_$(printf '%s' "$host" | tr '.' '_')_$port"
		uci set "sockroute.$section=socks"
		uci set "sockroute.$section.label=Local SOCKS $port"
		uci set "sockroute.$section.host=$host"
		uci set "sockroute.$section.port=$port"
		uci set "sockroute.main.socks_ref=$section"
		uci commit sockroute
	fi

	if ! uci show sockroute 2>/dev/null | grep -q '=dns'; then
		uci set sockroute.dns_standard='dns'
		uci set sockroute.dns_standard.label="$(uci -q get sockroute.main.dns_standard_label 2>/dev/null || printf 'DNS standard')"
		uci set sockroute.dns_standard.server="$(uci -q get sockroute.main.dns_standard_server 2>/dev/null || printf 'udp://100.100.0.217')"
		uci set sockroute.dns_unblock='dns'
		uci set sockroute.dns_unblock.label="$(uci -q get sockroute.main.dns_unblock_label 2>/dev/null || printf 'DNS unblock')"
		uci set sockroute.dns_unblock.server="$(uci -q get sockroute.main.dns_unblock_server 2>/dev/null || printf 'udp://100.100.0.156')"
		uci -q get sockroute.main.dns_ref >/dev/null 2>&1 || uci set sockroute.main.dns_ref='dns_standard'
		uci commit sockroute
	fi
}

reload_luci() {
	# LuCI app views are loaded as JS modules with ?v=<package-db-mtime>.
	# When files are installed manually, package managers do not update this
	# mtime, so browsers can keep an old /view/sockroute.js even after cache
	# files and uhttpd are restarted.
	[ -e /lib/apk/db/installed ] && touch /lib/apk/db/installed 2>/dev/null || true
	[ -e /usr/lib/opkg/status ] && touch /usr/lib/opkg/status 2>/dev/null || true
	rm -f /tmp/luci-indexcache* /tmp/luci-requirecache* /tmp/luci-modulecache* 2>/dev/null || true
	rm -rf /tmp/luci-* /tmp/lib/luci-* /tmp/luci-sessions 2>/dev/null || true
	[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd restart 2>/dev/null || true
	[ -x /etc/init.d/uhttpd ] && /etc/init.d/uhttpd restart 2>/dev/null || true
}

start_service() {
	/etc/init.d/sockroute enable 2>/dev/null || true
	if /etc/init.d/sockroute running >/dev/null 2>&1; then
		/etc/init.d/sockroute restart
	else
		/etc/init.d/sockroute start
	fi
}

main() {
	install_packages
	backup_existing
	install_files
	ensure_config
	start_service || log "WARN: SockRoute did not start; check /usr/libexec/sockroute health"
	reload_luci

	log "SockRoute installed."
	log "LuCI: Services -> SockRoute"
	log "Health: /usr/libexec/sockroute health"
	log "Docs: https://github.com/Kemper51rus/SockRoute"
}

main "$@"
