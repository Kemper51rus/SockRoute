#!/usr/bin/env python3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "files/usr/libexec/sockroute"
LUCI = ROOT / "files/www/luci-static/resources/view/sockroute.js"
CONFIG = ROOT / "files/etc/config/sockroute"
INSTALLER = ROOT / "install.sh"


def read(path):
    return path.read_text(encoding="utf-8")


class SockRouteFeatureTests(unittest.TestCase):
    def test_realip_dns_in_sample_config_and_installer(self):
        self.assertIn("option realip_dns '1'", read(CONFIG))
        self.assertIn("option realip_dns_addr '1.1.1.1'", read(CONFIG))
        self.assertIn("sockroute.main.realip_dns", read(INSTALLER))
        self.assertIn("sockroute.main.realip_dns_addr", read(INSTALLER))

    def test_helper_has_no_fakeip_bypass_backend(self):
        helper = read(HELPER)
        for removed in (
            "bypass_cidr",
            "bypass_cidrs()",
            "set-bypass-cidr",
            "set_bypass_cidr",
            "sockroute_tcp_bypass",
            "sockroute_udp_bypass",
            "fakeip-bypass",
            "add_bypass_return_rules",
            "198.18.0.0/15",
        ):
            self.assertNotIn(removed, helper)
        self.assertNotIn("bypass_cidr", read(CONFIG))
        self.assertNotIn("bypass_cidr", read(INSTALLER))

    def test_helper_supports_per_client_dns_servers(self):
        helper = read(HELPER)
        self.assertIn("client_dns_servers()", helper)
        self.assertIn("validate_dns_server_spec()", helper)
        self.assertIn("set_client_dns", helper)
        self.assertIn("clear_client_dns", helper)
        self.assertIn("dns_server_tag()", helper)
        self.assertIn('"type": "udp"', helper)
        self.assertIn("tls://*) proto=tls", helper)
        self.assertIn("https://*) proto=https", helper)
        self.assertIn('"type": "$dns_proto"', helper)
        self.assertIn('"action": "hijack-dns"', helper)
        self.assertIn('"source_ip_cidr": [', helper)
        self.assertIn('"server": "$dns_tag"', helper)
        self.assertIn('"domain_resolver": "default_dns"', helper)
        self.assertIn('"default_domain_resolver": "default_dns"', helper)
        self.assertIn("dns_server_port", helper)
        self.assertIn("dns_server_host", helper)
        self.assertIn("default_dns_server()", helper)
        self.assertIn("default_dns_value=", helper)
        self.assertIn("set_default_dns", helper)
        self.assertIn("dns_profile_sections()", helper)
        self.assertIn("dns_profile_exists()", helper)
        self.assertIn("dns_profile_server()", helper)
        self.assertIn("list_dns_profiles", helper)
        self.assertIn("test_dns_profile", helper)
        self.assertIn("delete_dns_profile", helper)
        self.assertIn("set_dns_ref", helper)
        self.assertIn("set_dns_profile", helper)
        self.assertIn("set_client_dns_ref", helper)
        self.assertIn("client_effective_dns_servers()", helper)
        self.assertIn("check_dns_server_through_socks()", helper)
        self.assertIn("dns_check_domain()", helper)
        self.assertIn('"tag": "check_socks"', helper)
        self.assertIn('"detour": "$detour"', helper)
        self.assertNotIn('dns_proto="$1"; server="$2"; port="$3"', helper)
        self.assertIn("SOCKROUTE_DNS_HIJACK_COMMENT", helper)
        self.assertIn("add_sockroute_dns_hijack_rules()", helper)
        self.assertIn('udp dport 53 \\\n\t\tcounter return comment "$SOCKROUTE_DNS_HIJACK_COMMENT"', helper)
        self.assertIn('counter redirect to ":$port" comment "$SOCKROUTE_DNS_UDP_COMMENT"', helper)
        self.assertIn('"tag": "dns_in",\n      "listen": "::"', helper)
        self.assertIn("dns_port()", helper)
        self.assertIn("transparent_port()", helper)
        self.assertIn("transparent_listen_port", helper)

    def test_luci_exposes_per_client_dns_without_fakeip_bypass_controls(self):
        luci = read(LUCI)
        for present in (
            "sockroute-edit-dns-servers",
            "DNS серверы",
            "DNS профили",
            "DNS standard",
            "DNS unblock",
            "UDP/TLS/HTTPS",
            "set-client-dns",
            "set-client-dns-ref",
            "set-dns-profile",
            "set-dns-ref",
            "test-dns-profile",
            "delete-dns-profile",
            "clear-client-dns",
            "client.dnsServers",
            "client.dnsRef",
            "handleEditDnsProfile",
            "handleSettingsModal",
            "handleAddClientModal",
            "auto_apply",
            "check_loop",
            "socks_check_interval",
            "dns_check_interval",
        ):
            self.assertIn(present, luci)
        for removed in (
            "sockroute-bypass-cidr",
            "handleSaveRouting",
            "Bypass/FakeDNS",
            "Маршрутизация и FakeDNS",
            "FakeDNS bypass включён",
            "Сохранить bypass",
            "PassWall2 default",
            "set-bypass-cidr",
            "198.18.0.0/15",
        ):
            self.assertNotIn(removed, luci)


if __name__ == "__main__":
    unittest.main()
