'use strict';
'require fs';
'require uci';
'require ui';
'require view';

var helperPath = '/usr/libexec/sockroute';
var initPath = '/etc/init.d/sockroute';

function asList(value) {
	if (Array.isArray(value))
		return value;
	if (typeof(value) === 'string' && value.length)
		return value.split(/\s+/);
	return [];
}

function validateIp4(value) {
	var parts = String(value || '').trim().split('.');

	if (parts.length !== 4)
		return false;

	for (var i = 0; i < parts.length; i++) {
		if (!/^[0-9]+$/.test(parts[i]))
			return false;

		var n = Number(parts[i]);
		if (n < 0 || n > 255)
			return false;
	}

	return true;
}

function splitList(value) {
	return String(value || '').split(/[\s,;]+/).filter(function(item) {
		return item.length > 0;
	});
}

function validateCidr4(value) {
	var parts = String(value || '').trim().split('/');
	var bits;

	if (parts.length !== 2 || !validateIp4(parts[0]) || !/^[0-9]+$/.test(parts[1]))
		return false;

	bits = Number(parts[1]);
	return bits >= 0 && bits <= 32;
}

function validatePort(value) {
	if (!/^[0-9]+$/.test(String(value || '').trim()))
		return false;

	var port = Number(value);
	return port >= 1 && port <= 65535;
}

function validateIntervalSeconds(value) {
	if (!/^[0-9]+$/.test(String(value || '').trim()))
		return false;

	var seconds = Number(value);
	return seconds >= 5 && seconds <= 3600;
}

function intervalSeconds(value, fallback) {
	return validateIntervalSeconds(value) ? Number(value) : fallback;
}

function validateHostname(value) {
	return /^[A-Za-z0-9.-]+$/.test(String(value || '')) && String(value || '').indexOf('.') > 0;
}

function validateDnsServerSpec(value) {
	var spec = String(value || '').trim();
	var proto = 'udp';
	var server = spec;
	var port = '';
	var slash;

	if (!spec)
		return false;
	if (server.indexOf('udp://') === 0)
		server = server.substr(6);
	else if (server.indexOf('tls://') === 0) {
		proto = 'tls';
		server = server.substr(6);
	}
	else if (server.indexOf('https://') === 0) {
		proto = 'https';
		server = server.substr(8);
	}
	else if (server.indexOf('://') >= 0)
		return false;

	if (proto === 'https') {
		slash = server.indexOf('/');
		if (slash >= 0)
			server = server.substr(0, slash);
	}
	if (server.indexOf(':') >= 0) {
		port = server.split(':').pop();
		server = server.substr(0, server.length - port.length - 1);
	}
	return (validateIp4(server) || validateHostname(server)) && (!port || validatePort(port));
}

function dnsProfilesFromUci() {
	var profiles = uci.sections('sockroute', 'dns').map(function(section) {
		return {
			section: sectionId(section),
			ref: sectionId(section),
			label: section.label || sectionId(section),
			server: section.server || '',
			lastCheck: section.last_check || 'unknown',
			lastCheckDetail: section.last_check_detail || '',
			lastCheckTime: section.last_check_time || ''
		};
	}).filter(function(profile) {
		return profile.section && validateDnsServerSpec(profile.server);
	}).sort(function(a, b) {
		return String(a.label).localeCompare(String(b.label));
	});

	if (!profiles.length) {
		profiles.push({
			section: 'standard',
			ref: 'standard',
			label: uci.get('sockroute', 'main', 'dns_standard_label') || 'DNS standard',
			server: uci.get('sockroute', 'main', 'dns_standard_server') || 'udp://100.100.0.217',
			lastCheck: 'unknown',
			lastCheckDetail: '',
			lastCheckTime: ''
		});
		profiles.push({
			section: 'unblock',
			ref: 'unblock',
			label: uci.get('sockroute', 'main', 'dns_unblock_label') || 'DNS unblock',
			server: uci.get('sockroute', 'main', 'dns_unblock_server') || 'udp://100.100.0.156',
			lastCheck: 'unknown',
			lastCheckDetail: '',
			lastCheckTime: ''
		});
	}

	return profiles;
}

function dnsProfileByRef(profiles, ref) {
	for (var i = 0; i < (profiles || []).length; i++) {
		if (profiles[i].ref === ref)
			return profiles[i];
	}
	return null;
}

function parseSocksCandidates(value) {
	var lines = String(value || '').split(/\n/);
	var seen = {};
	var candidates = [];

	for (var i = 0; i < lines.length; i++) {
		var parts = lines[i].split('\t');
		var host = parts[0] ? parts[0].trim() : '';
		var port = parts[1] ? parts[1].trim() : '';
		var key = host + ':' + port;

		if (!validateIp4(host) || !validatePort(port) || seen[key])
			continue;

		seen[key] = true;
		candidates.push({
			host: host,
			port: port,
			label: parts[2] ? parts[2].trim() : key,
			source: parts[3] ? parts[3].trim() : ''
		});
	}

	return candidates;
}

function sectionId(section) {
	return section && (section['.name'] || section.name) || '';
}

function socksProfileValue(profile) {
	return 'ref|' + profile.section;
}

function rawSocksValue(host, port) {
	return 'raw|' + host + '|' + port;
}

function clientSocksValue(client) {
	if (client && client.socksRef)
		return 'ref|' + client.socksRef;
	if (client && client.socksHost && client.socksPort)
		return rawSocksValue(client.socksHost, client.socksPort);
	return '';
}

function findSocksProfile(profiles, section) {
	for (var i = 0; i < (profiles || []).length; i++) {
		if (profiles[i].section === section)
			return profiles[i];
	}
	return null;
}

function endpointFromValue(value, profiles) {
	var parts = String(value || '').split('|');
	var profile;

	if (!value)
		return null;

	if (parts[0] === 'ref' && parts.length >= 2) {
		profile = findSocksProfile(profiles, parts[1]);
		if (profile)
			return { host: profile.host, port: profile.port };
		return null;
	}

	if (parts[0] === 'raw' && parts.length >= 3)
		return { host: parts[1], port: parts[2] };

	if (parts.length === 2)
		return { host: parts[0], port: parts[1] };

	return null;
}

function endpointFromText(value) {
	var text = String(value || '').trim();
	var parts;

	if (!text)
		return null;

	if (text.indexOf('|') >= 0)
		return endpointFromValue(text);

	parts = text.split(':');
	if (parts.length === 2)
		return { host: parts[0], port: parts[1] };

	return null;
}

function syncSocksEndpointInput(endpointId, hostId, portId, warnings, labels) {
	var endpointInput = document.getElementById(endpointId);
	var hostInput = document.getElementById(hostId);
	var portInput = document.getElementById(portId);
	var labelInput = document.getElementById('sockroute-socks-label');
	var value = endpointInput ? endpointInput.value.trim() : '';
	var endpoint = endpointFromText(value);

	if (!endpoint) {
		if (hostInput)
			hostInput.value = '';
		if (portInput)
			portInput.value = '';
		updateSocksWarning(null);
		return false;
	}

	if (hostInput)
		hostInput.value = endpoint.host;
	if (portInput)
		portInput.value = endpoint.port;

	updateSocksWarning(value && warnings ? warnings[value] : null);
	if (labelInput && !labelInput.value.trim() && labels && labels[value])
		labelInput.value = labels[value];

	return true;
}

function showSocksEndpointMenu(menuId) {
	var menu = document.getElementById(menuId);
	if (menu)
		menu.style.display = 'block';
}

function hideSocksEndpointMenu(menuId) {
	var menu = document.getElementById(menuId);
	if (menu)
		window.setTimeout(function() {
			menu.style.display = 'none';
		}, 120);
}

function filterSocksEndpointMenu(menuId, query) {
	var menu = document.getElementById(menuId);
	var needle = String(query || '').toLowerCase();
	var children;

	if (!menu)
		return;

	children = menu.children || [];
	for (var i = 0; i < children.length; i++) {
		var haystack = String(children[i].getAttribute('data-search') || '').toLowerCase();
		children[i].style.display = !needle || haystack.indexOf(needle) >= 0 ? 'block' : 'none';
	}
}

function chooseSocksEndpoint(endpointId, menuId, value, warnings, labels) {
	var input = document.getElementById(endpointId);
	if (input) {
		input.value = value;
		syncSocksEndpointInput(endpointId, 'sockroute-socks-host', 'sockroute-socks-port', warnings || {}, labels || {});
	}
	var menu = document.getElementById(menuId);
	if (menu)
		menu.style.display = 'none';
}

function fillSocksInputIds(value, hostId, portId, profiles) {
	var endpoint = endpointFromValue(value, profiles);
	var parts = String(value || '').split('|');
	var hostInput = document.getElementById(hostId);
	var portInput = document.getElementById(portId);

	if (!value) {
		if (hostInput)
			hostInput.value = '';
		if (portInput)
			portInput.value = '';
		return;
	}

	if (!endpoint && parts.length !== 2)
		return;

	if (hostInput)
		hostInput.value = endpoint ? endpoint.host : parts[0];
	if (portInput)
		portInput.value = endpoint ? endpoint.port : parts[1];
}

function fillSocksInputs(value) {
	var hostInput = document.getElementById('sockroute-socks-host');
	var portInput = document.getElementById('sockroute-socks-port');

	if (!value) {
		if (hostInput)
			hostInput.value = '';
		if (portInput)
			portInput.value = '';
		return;
	}

	fillSocksInputIds(value, 'sockroute-socks-host', 'sockroute-socks-port');
}

function fillSocksBuilder(value, warnings, labels) {
	var labelInput = document.getElementById('sockroute-socks-label');

	fillSocksInputs(value);
	updateSocksWarning(value ? warnings[value] : null);

	if (labelInput && !labelInput.value.trim() && labels && labels[value])
		labelInput.value = labels[value];
}

function fillClientFromDhcp(value) {
	var parts = String(value || '').split('|');
	var ipInput = document.getElementById('sockroute-ip');
	var labelInput = document.getElementById('sockroute-label');

	if (parts.length < 2)
		return;

	if (ipInput)
		ipInput.value = parts[0];
	if (labelInput)
		labelInput.value = parts.slice(1).join('|');
}

function ipSortValue(value) {
	var parts = String(value || '0.0.0.0').split('.');
	var total = 0;

	for (var i = 0; i < 4; i++)
		total = total * 256 + (Number(parts[i]) || 0);

	return total;
}

function escapeText(value) {
	return String(value == null ? '' : value);
}

function yamlQuote(value) {
	return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function apiRoot() {
	var origin = 'http://192.168.1.1';

	if (typeof(window) !== 'undefined' && window.location && window.location.protocol && window.location.host)
		origin = window.location.protocol + '//' + window.location.host;

	return origin + '/cgi-bin/sockroute-api';
}

function apiUrl(root, ip, action, token, extra) {
	var url = '%s?ip=%s&action=%s'.format(root, ip, action);

	if (extra) {
		Object.keys(extra).forEach(function(key) {
			if (extra[key] != null && extra[key] !== '')
				url += '&%s=%s'.format(encodeURIComponent(key), encodeURIComponent(extra[key]));
		});
	}

	if (token)
		url += '&token=%s'.format(encodeURIComponent(token));

	return url;
}

function validateApiToken(value) {
	return !value || /^[A-Za-z0-9._~-]{8,128}$/.test(value);
}

function generateApiToken() {
	var chars = '0123456789abcdef';
	var bytes = [];
	var value = '';

	if (typeof(window) !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
		var array = new Uint8Array(24);
		window.crypto.getRandomValues(array);
		for (var i = 0; i < array.length; i++)
			bytes.push(array[i]);
	}
	else {
		for (var j = 0; j < 24; j++)
			bytes.push(Math.floor(Math.random() * 256));
	}

	for (var k = 0; k < bytes.length; k++) {
		value += chars[(bytes[k] >> 4) & 15];
		value += chars[bytes[k] & 15];
	}

	return value;
}

function copyText(value, message) {
	function notify() {
		ui.addNotification(null, E('p', message || 'Скопировано.'), 'info');
	}

	function fallback() {
		var textarea = document.createElement('textarea');
		textarea.value = value;
		textarea.setAttribute('readonly', 'readonly');
		textarea.style.position = 'fixed';
		textarea.style.left = '-9999px';
		document.body.appendChild(textarea);
		textarea.select();
		document.execCommand('copy');
		document.body.removeChild(textarea);
		notify();
		return Promise.resolve();
	}

	if (typeof(navigator) !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText)
		return navigator.clipboard.writeText(value).then(notify).catch(fallback);

	return fallback();
}

function parseTabRows(value, columns) {
	var lines = String(value || '').split(/\n/);
	var rows = [];

	for (var i = 0; i < lines.length; i++) {
		if (!lines[i])
			continue;

		var parts = lines[i].split('\t');
		var row = {};
		for (var j = 0; j < columns.length; j++)
			row[columns[j]] = parts[j] ? parts[j].trim() : '';
		rows.push(row);
	}

	return rows;
}

function parseHealth(value) {
	return parseTabRows(value, [ 'name', 'status', 'detail' ]);
}

function parseDhcpHosts(value) {
	return parseTabRows(value, [ 'section', 'ip', 'label', 'mac' ]).filter(function(lease) {
		return validateIp4(lease.ip);
	});
}

function parseClientCounters(value) {
	var lines = String(value || '').split(/\n/);
	var block = '';
	var counters = {};

	for (var i = 0; i < lines.length; i++) {
		var line = lines[i];
		var parts;

		if (/^[a-z_]+:$/.test(line)) {
			block = line.replace(/:$/, '');
			continue;
		}

		if (block !== 'client_counters' || !line)
			continue;

		parts = line.split('\t');
		if (validateIp4(parts[0])) {
			counters[parts[0]] = {
				packets: Number(parts[1]) || 0,
				bytes: Number(parts[2]) || 0
			};
		}
	}

	return counters;
}

function packetText(value) {
	var count = Number(value) || 0;
	var mod10 = count % 10;
	var mod100 = count % 100;

	if (mod10 === 1 && mod100 !== 11)
		return count + ' пакет';
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
		return count + ' пакета';
	return count + ' пакетов';
}

function formatBytes(value) {
	var n = Number(value) || 0;
	var units = [ 'Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ' ];
	var idx = 0;

	while (n >= 1024 && idx < units.length - 1) {
		n = n / 1024;
		idx++;
	}

	if (idx === 0)
		return String(Math.round(n)) + ' ' + units[idx];
	return n.toFixed(1).replace('.', ',') + ' ' + units[idx];
}

function trafficData(value) {
	return {
		packets: Number(value && value.packets) || 0,
		bytes: Number(value && value.bytes) || 0
	};
}

function trafficTitle(value) {
	var data = trafficData(value);

	return '%s / %s'.format(packetText(data.packets), formatBytes(data.bytes));
}

function trafficCellContent(value) {
	var data = trafficData(value);

	return E('div', {
		'style': 'display:grid; grid-template-columns:minmax(5.8em, auto) minmax(6.8em, auto); gap:0 10px; align-items:baseline; min-width:13em;'
	}, [
		E('strong', { 'style': 'text-align:right; font-variant-numeric:tabular-nums;' }, [ formatBytes(data.bytes) ]),
		E('span', { 'style': 'text-align:right; opacity:.72; font-variant-numeric:tabular-nums;' }, [ packetText(data.packets) ])
	]);
}

function haUniqueId(client) {
	var label = String(client && client.label || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');

	return 'sockroute_' + (label || String(client.ip || '').replace(/\./g, '_'));
}

function buildHomeAssistantYaml(clients, root, token) {
	var lines = [ 'command_line:' ];
	var source = clients.length ? clients : [ { ip: '192.168.1.100', label: 'Client' } ];

	source.forEach(function(client) {
		var label = client.label || client.ip || 'Client';
		var ip = client.ip || '192.168.1.100';

		lines = lines.concat([
			'  - switch:',
			'      name: "%s SockRoute"'.format(yamlQuote(label)),
			'      unique_id: %s'.format(haUniqueId(client)),
			'      command_state: >-',
			'        curl -fsS --max-time 10 "%s"'.format(apiUrl(root, ip, 'status', token)),
			'      value_template: "{{ value == \'ON\' }}"',
			'      command_on: >-',
			'        curl -fsS --max-time 15 "%s"'.format(apiUrl(root, ip, 'on', token)),
			'      command_off: >-',
			'        curl -fsS --max-time 15 "%s"'.format(apiUrl(root, ip, 'off', token))
		]);
	});

	return lines.join('\n');
}

function apiExampleActions(socksProfiles) {
	var profile = socksProfiles && socksProfiles.length ? socksProfiles[0] : null;
	var actions = [
		{ action: 'status', label: 'Status' },
		{ action: 'on', label: 'ON' },
		{ action: 'off', label: 'OFF' },
		{ action: 'toggle', label: 'Toggle' },
		{ action: 'on', label: 'ON + default', extra: { outbound: 'default' } }
	];

	if (profile)
		actions.push({ action: 'on', label: 'ON + outbound', extra: { outbound: profile.label } });

	return actions;
}

function buildApiExamplesText(clients, socksProfiles, root, token) {
	var source = clients.length ? clients : [ { ip: '192.168.1.100', label: 'Client' } ];
	var actions = apiExampleActions(socksProfiles);
	var lines = [];

	source.forEach(function(client) {
		var label = client.label || client.ip || 'Client';
		var ip = client.ip || '192.168.1.100';

		actions.forEach(function(action) {
			lines.push('%s\t%s\t%s\t%s'.format(label, ip, action.label, apiUrl(root, ip, action.action, token, action.extra)));
		});
	});

	return lines.join('\n');
}

function buildApiExamplesTable(clients, socksProfiles, root, token) {
	var source = clients.length ? clients : [ { ip: '192.168.1.100', label: 'Client' } ];
	var actions = apiExampleActions(socksProfiles);
	var rowIndex = 0;
	var rows = [
		E('tr', stripedHeaderAttrs(), [
			E('th', {}, [ 'Клиент' ]),
			E('th', {}, [ 'IP' ]),
			E('th', {}, [ 'Действие' ]),
			E('th', {}, [ 'URL' ]),
			E('th', {}, [ '' ])
		])
	];

	source.forEach(function(client) {
		var label = client.label || client.ip || 'Client';
		var ip = client.ip || '192.168.1.100';

		actions.forEach(function(action) {
			var url = apiUrl(root, ip, action.action, token, action.extra);
			rows.push(E('tr', stripedRowAttrs(rowIndex++), [
				E('td', {}, [ label ]),
				E('td', {}, [ ip ]),
				E('td', {}, [ action.label ]),
				E('td', { 'style': 'word-break: break-all;' }, [
					E('code', {}, [ url ])
				]),
				E('td', { 'class': 'right' }, [
					E('button', {
						'class': 'btn cbi-button-action',
						'click': function() {
							return copyText(url, 'URL скопирован.');
						}
					}, [ 'Копировать' ])
				])
			]));
		});
	});

	return E('div', { 'style': 'max-height: 360px; overflow: auto;' }, [
		E('table', dataTableAttrs(), rows)
	]);
}

function buildApiHelpText(clients, socksProfiles, root, token) {
	var client = clients && clients.length ? clients[0] : { ip: '192.168.1.100', label: 'Client' };
	var profile = socksProfiles && socksProfiles.length ? socksProfiles[0] : null;
	var outbound = profile ? profile.label : 'Tor';
	var lines = [
		'Базовые действия:',
		apiUrl(root, client.ip, 'status', token),
		apiUrl(root, client.ip, 'on', token),
		apiUrl(root, client.ip, 'off', token),
		apiUrl(root, client.ip, 'toggle', token),
		'',
		'Включить клиента и назначить исходящий SOCKS:',
		apiUrl(root, client.ip, 'on', token, { outbound: outbound }),
		profile ? apiUrl(root, client.ip, 'on', token, { outbound: profile.section }) : apiUrl(root, client.ip, 'on', token, { outbound: 'socks_192_168_1_10_1080' }),
		profile ? apiUrl(root, client.ip, 'on', token, { outbound: '%s:%s'.format(profile.host, profile.port) }) : apiUrl(root, client.ip, 'on', token, { outbound: '192.168.1.10:1080' }),
		apiUrl(root, client.ip, 'on', token, { outbound: 'default' })
	];

	return lines.join('\n');
}

function buildApiHelp(clients, socksProfiles, root, token) {
	var text = buildApiHelpText(clients, socksProfiles, root, token);

	return E('details', { 'style': 'margin-top:12px;' }, [
		E('summary', { 'style': 'cursor:pointer; font-weight:bold;' }, [ 'Как пользоваться API' ]),
		E('div', { 'class': 'cbi-section-descr' }, [
			'Старые вызовы status/on/off/toggle совместимы и меняют только ON/OFF клиента в nft set. Параметр outbound необязательный: если его нет, профиль SOCKS клиента не меняется. Если outbound передан, API назначает клиенту SOCKS profile и перезапускает только sockroute.'
		]),
		E('ul', {}, [
			E('li', {}, [ E('code', {}, [ 'outbound=Имя' ]), ' - имя сохранённого SOCKS профиля, например ', E('code', {}, [ 'Tor' ]) ]),
			E('li', {}, [ E('code', {}, [ 'outbound=section' ]), ' - UCI section профиля, например ', E('code', {}, [ 'socks_100_100_0_154_1080' ]) ]),
			E('li', {}, [ E('code', {}, [ 'outbound=HOST:PORT' ]), ' - endpoint, например ', E('code', {}, [ '192.168.1.10:1080' ]) ]),
			E('li', {}, [ E('code', {}, [ 'outbound=default' ]), ' - очистить индивидуальный override клиента' ])
		]),
		E('button', {
			'class': 'btn cbi-button-action',
			'click': function() {
				return copyText(text, 'Справка API скопирована.');
			}
		}, [ 'Копировать примеры' ]),
		E('pre', { 'style': 'white-space:pre-wrap; max-height:260px; overflow:auto; margin-top:8px;' }, [ text ])
	]);
}

function statusBadge(status) {
	var color = status === 'ok' ? '#16a34a' : status === 'warn' ? '#facc15' : status === 'unknown' ? '#64748b' : '#dc2626';
	var text = status === 'ok' ? 'OK' : status === 'warn' ? 'WARN' : status === 'unknown' ? 'N/A' : 'FAIL';
	var fg = status === 'warn' ? '#111827' : '#fff';
	return E('span', {
		'style': 'display:inline-block; min-width:3.4em; padding:2px 8px; border-radius:999px; color:%s; background:%s; font-weight:700; text-align:center;'.format(fg, color)
	}, [ text ]);
}

function routeBadge(enabled) {
	return E('span', {
		'style': enabled
			? 'display:inline-block; min-width:3.4em; padding:2px 8px; border-radius:999px; color:#fff; background:#16a34a; font-weight:800; text-align:center;'
			: 'display:inline-block; min-width:3.4em; padding:2px 8px; border-radius:999px; color:#fff; background:#64748b; font-weight:800; text-align:center;'
	}, [ enabled ? 'ON' : 'OFF' ]);
}

function domId(value) {
	return String(value || '').replace(/[^A-Za-z0-9_-]/g, '_');
}

function replaceNodeContent(node, content) {
	while (node && node.firstChild)
		node.removeChild(node.firstChild);

	if (!node)
		return;

	if (Array.isArray(content)) {
		for (var i = 0; i < content.length; i++)
			node.appendChild(typeof(content[i]) === 'string' ? document.createTextNode(content[i]) : content[i]);
	}
	else {
		node.appendChild(typeof(content) === 'string' ? document.createTextNode(content) : content);
	}
}

function setNodeText(id, value, title) {
	var node = document.getElementById(id);
	if (!node)
		return;
	node.textContent = value || '-';
	if (title != null)
		node.title = title;
}

function setStatusBadge(id, status) {
	var node = document.getElementById(id);
	if (node)
		replaceNodeContent(node, statusBadge(status));
}

function identIpFromDetail(detail) {
	var value = String(detail || '').replace(/^ident\.me:\s*/, '').trim();

	if (!value || /^curl:/i.test(value) || /^bad /i.test(value) || /не ответил|не найден/i.test(value))
		return '-';

	return value;
}

function currentClock() {
	var now = new Date();
	var pad = function(value) {
		return value < 10 ? '0' + value : String(value);
	};

	return '%s:%s:%s'.format(pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds()));
}

function socksProfileCheckTitle(profile) {
	var detail = profile.lastCheckDetail || 'нет сохранённой проверки SOCKS endpoint';

	if (profile.lastCheckTime)
		detail += ' / ' + profile.lastCheckTime;

	return detail;
}

function dnsProfileCheckTitle(profile) {
	var detail = profile.lastCheckDetail || 'нет сохранённой проверки DNS';

	if (profile.lastCheckTime)
		detail += ' / ' + profile.lastCheckTime;

	return detail;
}

function clientCountText(count) {
	var mod10 = count % 10;
	var mod100 = count % 100;

	if (count === 0)
		return '0 клиентов';
	if (mod10 === 1 && mod100 !== 11)
		return count + ' клиент';
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
		return count + ' клиента';
	return count + ' клиентов';
}

function dataTableAttrs(extraClass) {
	return {
		'class': ('table' + (extraClass ? ' ' + extraClass : '')),
		'style': 'width:100%; border-collapse:separate; border-spacing:0 3px;'
	};
}

function stripedHeaderAttrs() {
	return {
		'class': 'tr table-titles',
		'style': 'background:rgba(127,127,127,.16);'
	};
}

function stripedRowAttrs(index, extraStyle) {
	return {
		'style': 'background:%s;%s'.format(index % 2 ? 'rgba(127,127,127,.08)' : 'rgba(127,127,127,.03)', extraStyle || '')
	};
}

function buildHealthTable(rows) {
	if (!rows.length)
		return E('em', {}, [ 'Нет данных диагностики.' ]);

	return E('table', dataTableAttrs(), [
		E('tr', stripedHeaderAttrs(), [
			E('th', {}, [ 'Проверка' ]),
			E('th', {}, [ 'Статус' ]),
			E('th', {}, [ 'Детали' ])
		])
	].concat(rows.map(function(row, index) {
		return E('tr', stripedRowAttrs(index), [
			E('td', {}, [ row.name ]),
			E('td', {}, [ statusBadge(row.status) ]),
			E('td', {}, [ row.detail ])
		]);
	})));
}

function healthRowByName(rows, name) {
	for (var i = 0; i < rows.length; i++) {
		if (rows[i].name === name)
			return rows[i];
	}
	return { name: name, status: 'warn', detail: 'нет данных' };
}

function compactRuntimeDetail(rows, expectedCount) {
	var portDetail = healthRowByName(rows, 'transparent-port').detail || '';
	var setDetail = healthRowByName(rows, 'nft-set').detail || '';
	var portMatch = portDetail.match(/порт\s+([0-9]+)/);
	var countMatch = setDetail.match(/elements:\s*([0-9]+)/);
	var actualCount = countMatch ? countMatch[1] : '';
	var parts = [];

	if (portMatch)
		parts.push('порт %s'.format(portMatch[1]));
	if (actualCount)
		parts.push(expectedCount != null ? 'IP %s/%s'.format(actualCount, expectedCount) : '%s IP в set'.format(actualCount));

	return parts.length ? parts.join(' / ') : '';
}

function mergedHealthCard(rows, names, expectedCount) {
	var detail = [];
	var status = 'ok';
	var compactRuntime = names.length === 2 && names[0] === 'transparent-port' && names[1] === 'nft-set';

	for (var i = 0; i < names.length; i++) {
		var row = healthRowByName(rows, names[i]);

		detail.push(row.detail);
		if (row.status === 'fail')
			status = 'fail';
		else if (row.status === 'warn' && status !== 'fail')
			status = 'warn';
	}

	return { status: status, detail: compactRuntime ? compactRuntimeDetail(rows, expectedCount) || detail.join(' / ') : detail.join(' / ') };
}

function aggregateProfilesStatus(profiles, label) {
	var status = 'unknown';
	var ok = 0;
	var fail = 0;
	var warn = 0;

	if (!(profiles || []).length)
		return { status: 'unknown', detail: 'нет профилей' };

	(profiles || []).forEach(function(profile) {
		var check = profile.lastCheck || 'unknown';
		if (check === 'ok')
			ok++;
		else if (check === 'fail')
			fail++;
		else if (check === 'warn')
			warn++;
	});

	if (fail)
		status = 'fail';
	else if (warn)
		status = 'warn';
	else if (ok === profiles.length)
		status = 'ok';

	return { status: status, detail: '%s: OK %d / FAIL %d / WARN %d / всего %d'.format(label, ok, fail, warn, profiles.length) };
}

function updateStatusCard(key, status, detail) {
	setStatusBadge('sockroute-status-%s-badge'.format(key), status || 'unknown');
	setNodeText('sockroute-status-%s-detail'.format(key), detail || '-', detail || '-');
}

function refreshStatusCardsInBackground(expectedClients) {
	return L.resolveDefault(fs.exec(helperPath, [ 'health' ]), { code: 1, stdout: '', stderr: '' }).then(function(res) {
		var rows = parseHealth(res.stdout || '');
		var runtime = mergedHealthCard(rows, [ 'transparent-port', 'nft-set' ], expectedClients);

		if (!rows.length)
			return;

		updateStatusCard('socks', healthRowByName(rows, 'socks-outbound').status, healthRowByName(rows, 'socks-outbound').detail);
		updateStatusCard('runtime', runtime.status, runtime.detail);
		updateStatusCard('api', healthRowByName(rows, 'api').status, healthRowByName(rows, 'api').detail);
	});
}

function refreshSocksProfileIdent(profile) {
	var key = domId(profile.section);

	setStatusBadge('sockroute-socks-status-%s'.format(key), 'warn');
	setNodeText('sockroute-socks-ident-%s'.format(key), 'проверка...', 'Проверка ident.me выполняется в фоне');

	return L.resolveDefault(fs.exec(helperPath, [ 'test-socks-ident', profile.host, profile.port ]), {
		code: 1,
		stdout: '',
		stderr: 'ошибка запуска проверки'
	}).then(function(res) {
		var rows = parseHealth(res.stdout || '');
		var row = healthRowByName(rows, 'ident');
		var detail = row.detail || res.stderr || 'нет вывода';
		var identIp = identIpFromDetail(detail);
		var status = row.status === 'ok' && identIp ? 'ok' : 'fail';

		if (!rows.length)
			detail = res.stderr || 'нет вывода';

		setStatusBadge('sockroute-socks-status-%s'.format(key), status);
		setNodeText(
			'sockroute-socks-ident-%s'.format(key),
			status === 'ok' ? identIp : 'FAIL',
			'%s / обновлено %s'.format(detail, currentClock())
		);
		return status;
	});
}

function refreshSocksProfilesInBackground(profiles, retryFailed) {
	var failedProfiles = [];
	var checks = [];

	if (!document.getElementById('sockroute-root')) {
		if (window.sockrouteSocksRefreshTimer)
			window.clearInterval(window.sockrouteSocksRefreshTimer);
		if (window.sockrouteSocksRetryTimer)
			window.clearTimeout(window.sockrouteSocksRetryTimer);
		return Promise.resolve();
	}

	if (window.sockrouteSocksRefreshBusy)
		return Promise.resolve();

	window.sockrouteSocksRefreshBusy = true;

	(profiles || []).forEach(function(profile) {
		checks.push(refreshSocksProfileIdent(profile).then(function(status) {
			profile.lastCheck = status;
			if (status !== 'ok')
				failedProfiles.push(profile);
			return status;
		}));
	});

	return Promise.all(checks).then(function() {
		var aggregate = aggregateProfilesStatus(profiles || [], 'SOCKS');
		updateStatusCard('socks', aggregate.status, aggregate.detail);
		window.sockrouteSocksRefreshBusy = false;
		if (retryFailed && failedProfiles.length && document.getElementById('sockroute-root')) {
			if (window.sockrouteSocksRetryTimer)
				window.clearTimeout(window.sockrouteSocksRetryTimer);
			window.sockrouteSocksRetryTimer = window.setTimeout(function() {
				refreshSocksProfilesInBackground(failedProfiles, true);
			}, 0);
		}
	}, function(err) {
		window.sockrouteSocksRefreshBusy = false;
		throw err;
	});
}

function refreshDnsProfileInBackground(profile) {
	var key = domId(profile.section);

	setStatusBadge('sockroute-dns-status-%s'.format(key), 'warn');
	setNodeText('sockroute-dns-detail-%s'.format(key), 'проверка...', 'Проверка DNS выполняется в фоне');

	return L.resolveDefault(fs.exec(helperPath, [ 'test-dns-profile', profile.section ]), {
		code: 1,
		stdout: '',
		stderr: 'ошибка запуска проверки'
	}).then(function(res) {
		var rows = parseHealth(res.stdout || '');
		var row = healthRowByName(rows, 'dns');
		var detail = row.detail || res.stderr || 'нет вывода';
		var status = row.status === 'ok' ? 'ok' : 'fail';

		if (!rows.length)
			detail = res.stderr || 'нет вывода';

		setStatusBadge('sockroute-dns-status-%s'.format(key), status);
		setNodeText('sockroute-dns-detail-%s'.format(key), status === 'ok' ? 'OK' : 'FAIL', '%s / обновлено %s'.format(detail, currentClock()));
		return status;
	});
}

function refreshDnsProfilesInBackground(profiles, retryFailed) {
	var failedProfiles = [];
	var checks = [];

	if (!document.getElementById('sockroute-root')) {
		if (window.sockrouteDnsRefreshTimer)
			window.clearInterval(window.sockrouteDnsRefreshTimer);
		if (window.sockrouteDnsRetryTimer)
			window.clearTimeout(window.sockrouteDnsRetryTimer);
		return Promise.resolve();
	}

	if (window.sockrouteDnsRefreshBusy)
		return Promise.resolve();

	window.sockrouteDnsRefreshBusy = true;

	(profiles || []).forEach(function(profile) {
		checks.push(refreshDnsProfileInBackground(profile).then(function(status) {
			profile.lastCheck = status;
			if (status !== 'ok')
				failedProfiles.push(profile);
			return status;
		}));
	});

	return Promise.all(checks).then(function() {
		var aggregate = aggregateProfilesStatus(profiles || [], 'DNS');
		updateStatusCard('dns', aggregate.status, aggregate.detail);
		window.sockrouteDnsRefreshBusy = false;
		if (retryFailed && failedProfiles.length && document.getElementById('sockroute-root')) {
			if (window.sockrouteDnsRetryTimer)
				window.clearTimeout(window.sockrouteDnsRetryTimer);
			window.sockrouteDnsRetryTimer = window.setTimeout(function() {
				refreshDnsProfilesInBackground(failedProfiles, true);
			}, 0);
		}
	}, function(err) {
		window.sockrouteDnsRefreshBusy = false;
		throw err;
	});
}

function updateClientTrafficCell(ip, counter) {
	var node = document.getElementById('sockroute-client-traffic-%s'.format(domId(ip)));
	var select = document.querySelector('select[data-sockroute-client-socks="%s"]'.format(ip));

	if (select) {
		select.setAttribute('data-packets', String(Number(counter && counter.packets) || 0));
		select.setAttribute('data-bytes', String(Number(counter && counter.bytes) || 0));
	}

	if (node) {
		node.title = trafficTitle(counter);
		replaceNodeContent(node, trafficCellContent(counter));
	}
}

function usageData() {
	return {
		clients: 0,
		packets: 0,
		bytes: 0
	};
}

function usageText(data) {
	data = data || usageData();

	if (!data.clients)
		return 'не используется';

	return '%s / %s'.format(clientCountText(data.clients), formatBytes(data.bytes));
}

function usageTitle(base, data) {
	data = data || usageData();
	base = base || '';

	if (!data.clients)
		return base + ' Трафик: нет клиентов.';

	return '%s Трафик: %s.'.format(base, trafficTitle(data));
}

function recalculateSocksUsage() {
	var selects = document.querySelectorAll('select[data-sockroute-client-socks]');
	var cells = document.querySelectorAll('[data-sockroute-socks-usage]');
	var usage = {};

	for (var i = 0; i < selects.length; i++) {
		var value = selects[i].value || selects[i].getAttribute('data-default-ref') || '';
		var ref = value.indexOf('ref|') === 0 ? value.split('|')[1] : '';

		if (ref) {
			if (!usage[ref])
				usage[ref] = usageData();
			usage[ref].clients++;
			usage[ref].packets += Number(selects[i].getAttribute('data-packets')) || 0;
			usage[ref].bytes += Number(selects[i].getAttribute('data-bytes')) || 0;
		}
	}

	for (var j = 0; j < cells.length; j++) {
		var cell = cells[j];
		var section = cell.getAttribute('data-section') || '';
		var data = usage[section] || usageData();
		var baseTitle = cell.getAttribute('data-title-base') || '';

		cell.textContent = usageText(data);
		cell.title = usageTitle(baseTitle, data);
	}
}

function refreshClientTrafficInBackground(clients) {
	if (!document.getElementById('sockroute-root')) {
		if (window.sockrouteTrafficRefreshTimer)
			window.clearInterval(window.sockrouteTrafficRefreshTimer);
		return Promise.resolve();
	}

	if (window.sockrouteTrafficRefreshBusy)
		return Promise.resolve();

	window.sockrouteTrafficRefreshBusy = true;

	return L.resolveDefault(fs.exec(helperPath, [ 'list' ]), { code: 1, stdout: '', stderr: '' }).then(function(res) {
		var counters = parseClientCounters(res.stdout || '');
		var runtimeNode = document.getElementById('sockroute-runtime-pre');

		if (runtimeNode)
			runtimeNode.textContent = res.stdout || res.stderr || 'Нет runtime-данных.';

		(clients || []).forEach(function(client) {
			updateClientTrafficCell(client.ip, counters[client.ip] || { packets: 0, bytes: 0 });
		});
		recalculateSocksUsage();
		window.sockrouteTrafficRefreshBusy = false;
	}, function(err) {
		window.sockrouteTrafficRefreshBusy = false;
		throw err;
	});
}

function scheduleBackgroundChecks(profiles, dnsProfiles, clients, socksInterval, dnsInterval, checkLoop, activeCount) {
	var snapshot = (profiles || []).map(function(profile) {
		return {
			section: profile.section,
			label: profile.label,
			host: profile.host,
			port: profile.port
		};
	});
	var dnsSnapshot = (dnsProfiles || []).map(function(profile) {
		return {
			section: profile.section,
			label: profile.label,
			server: profile.server
		};
	});
	var clientSnapshot = (clients || []).map(function(client) {
		return { ip: client.ip };
	});
	var socksIntervalMs = intervalSeconds(socksInterval, 30) * 1000;
	var dnsIntervalMs = intervalSeconds(dnsInterval, 30) * 1000;

	if (window.sockrouteSocksRefreshTimer)
		window.clearInterval(window.sockrouteSocksRefreshTimer);
	if (window.sockrouteTrafficRefreshTimer)
		window.clearInterval(window.sockrouteTrafficRefreshTimer);
	if (window.sockrouteSocksRefreshDelay)
		window.clearTimeout(window.sockrouteSocksRefreshDelay);
	if (window.sockrouteSocksRetryTimer)
		window.clearTimeout(window.sockrouteSocksRetryTimer);
	if (window.sockrouteDnsRefreshTimer)
		window.clearInterval(window.sockrouteDnsRefreshTimer);
	if (window.sockrouteDnsRefreshDelay)
		window.clearTimeout(window.sockrouteDnsRefreshDelay);
	if (window.sockrouteDnsRetryTimer)
		window.clearTimeout(window.sockrouteDnsRetryTimer);
	if (window.sockrouteTrafficRefreshDelay)
		window.clearTimeout(window.sockrouteTrafficRefreshDelay);
	if (window.sockrouteHealthRefreshDelay)
		window.clearTimeout(window.sockrouteHealthRefreshDelay);

	window.sockrouteHealthRefreshDelay = window.setTimeout(function() {
		refreshStatusCardsInBackground(activeCount);
	}, 800);
	if (clientSnapshot.length) {
		window.sockrouteTrafficRefreshDelay = window.setTimeout(function() {
			refreshClientTrafficInBackground(clientSnapshot);
		}, 1500);
		window.sockrouteTrafficRefreshTimer = window.setInterval(function() {
			refreshClientTrafficInBackground(clientSnapshot);
		}, 5000);
	}

	if (snapshot.length) {
		window.sockrouteSocksRefreshDelay = window.setTimeout(function() {
			refreshSocksProfilesInBackground(snapshot, !checkLoop);
		}, 1200);
		if (checkLoop) {
			window.sockrouteSocksRefreshTimer = window.setInterval(function() {
				refreshSocksProfilesInBackground(snapshot, false);
			}, socksIntervalMs);
		}
	}

	if (dnsSnapshot.length) {
		window.sockrouteDnsRefreshDelay = window.setTimeout(function() {
			refreshDnsProfilesInBackground(dnsSnapshot, !checkLoop);
		}, 1600);
		if (checkLoop) {
			window.sockrouteDnsRefreshTimer = window.setInterval(function() {
				refreshDnsProfilesInBackground(dnsSnapshot, false);
			}, dnsIntervalMs);
		}
	}
}

function scheduleDeferredDataLoad(viewObject) {
	if (!viewObject || viewObject.deferredDataLoaded || viewObject.deferredDataBusy)
		return;
	if (window.sockrouteDeferredDataDelay)
		window.clearTimeout(window.sockrouteDeferredDataDelay);

	window.sockrouteDeferredDataDelay = window.setTimeout(function() {
		viewObject.refreshDeferredData();
	}, 120);
}

function buildStatusSummary(cards) {
	return E('div', {
		'style': 'display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:8px; margin:12px 0;'
	}, cards.map(function(card) {
		var border = card.status === 'ok' ? '#86efac' : card.status === 'warn' ? '#fde68a' : card.status === 'unknown' ? '#94a3b8' : '#fecaca';
		var key = domId(card.key || card.label);

		return E('div', {
			'style': 'border:1px solid %s; border-radius:6px; padding:8px 10px; background:rgba(127,127,127,.12); color:inherit; min-width:0;'.format(border)
		}, [
			E('div', { 'style': 'display:flex; align-items:center; justify-content:space-between; gap:8px;' }, [
				E('strong', { 'style': 'min-width:0; overflow:hidden; text-overflow:ellipsis;' }, [ card.label ]),
				E('span', { 'id': 'sockroute-status-%s-badge'.format(key) }, [ statusBadge(card.status) ])
			]),
			E('div', {
				'id': 'sockroute-status-%s-detail'.format(key),
				'title': card.detail || '-',
				'style': 'margin-top:4px; color:inherit; opacity:.94; word-break:break-word;'
			}, [ card.detail || '-' ])
		]);
	}));
}

function buildDefaultDnsSection(viewObject, defaultDnsServer, dnsProfiles) {
	var standard = dnsProfileByRef(dnsProfiles, 'standard') || { server: 'udp://100.100.0.217' };
	var unblock = dnsProfileByRef(dnsProfiles, 'unblock') || { server: 'udp://100.100.0.156' };

	return E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, [ 'DNS профили' ]),
		E('div', { 'class': 'cbi-section-descr' }, [
			'Адреса DNS, которые можно выбрать для клиента прямо в таблице. DNS по умолчанию используется клиентами без индивидуального выбора.'
		]),
		E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title', 'for': 'sockroute-default-dns' }, [ 'Default DNS' ]),
			E('div', { 'class': 'cbi-value-field' }, [
				E('input', {
					'id': 'sockroute-default-dns',
					'type': 'text',
					'class': 'cbi-input-text',
					'style': 'width:100%; max-width:42em;',
					'value': defaultDnsServer,
					'placeholder': 'udp://100.100.0.156'
				}),
				' ',
				E('button', {
					'class': 'btn cbi-button-save',
					'click': ui.createHandlerFn(viewObject, 'handleSaveDefaultDns')
				}, [ 'Сохранить default DNS' ]),
				E('div', { 'class': 'cbi-value-description' }, [
					'Форматы: 100.100.0.156, udp://100.100.0.156, tls://1.1.1.1, https://1.1.1.1/dns-query. LAN DNS используется напрямую.'
				])
			])
		]),
		E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title', 'for': 'sockroute-dns-standard' }, [ 'DNS standard' ]),
			E('div', { 'class': 'cbi-value-field' }, [
				E('input', {
					'id': 'sockroute-dns-standard',
					'type': 'text',
					'class': 'cbi-input-text',
					'style': 'width:100%; max-width:42em;',
					'value': standard.server,
					'placeholder': 'udp://100.100.0.217'
				})
			])
		]),
		E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title', 'for': 'sockroute-dns-unblock' }, [ 'DNS unblock' ]),
			E('div', { 'class': 'cbi-value-field' }, [
				E('input', {
					'id': 'sockroute-dns-unblock',
					'type': 'text',
					'class': 'cbi-input-text',
					'style': 'width:100%; max-width:42em;',
					'value': unblock.server,
					'placeholder': 'udp://100.100.0.156'
				}),
				' ',
				E('button', {
					'class': 'btn cbi-button-save',
					'click': ui.createHandlerFn(viewObject, 'handleSaveDnsProfiles')
				}, [ 'Сохранить DNS профили' ])
			])
		])
	]);
}

function clientSourceLabel(source) {
	switch (source) {
	case 'preset':
		return 'preset';
	case 'profile':
		return 'profile';
	case 'active':
		return 'runtime only';
	default:
		return source || 'profile';
	}
}

function updateSocksWarning(message) {
	var node = document.getElementById('sockroute-socks-warning');
	if (node)
		node.textContent = message || 'Выбранный SOCKS будет использоваться только отдельным SockRoute service.';
}

function socksCandidateBadge(candidate) {
	if (!candidate)
		return 'manual';
	if (candidate.source === 'passwall2.global' || /routing/i.test(candidate.label))
		return 'routing / geo rules';
	if (candidate.source === 'passwall2.socks')
		return 'SOCKS inbound';
	if (/runtime default/i.test(candidate.label))
		return 'loopback node';
	if (candidate.source === 'server')
		return 'server outbound';
	return candidate.source || 'SOCKS';
}

function socksCandidateWarning(candidate) {
	var badge = socksCandidateBadge(candidate);

	if (badge === 'routing / geo rules')
		return 'Этот SOCKS идёт через основной routing/shunt профиль: часть доменов может идти напрямую по geo-правилам.';
	if (badge === 'SOCKS inbound')
		return 'Это отдельный SOCKS inbound из proxy stack. Проверьте, нужен ли ему доступ из LAN; для SockRoute обычно безопаснее loopback runtime SOCKS.';
	if (badge === 'loopback node')
		return 'Loopback runtime SOCKS текущего proxy node: хороший вариант для строгой маршрутизации выбранных клиентов через выбранный outbound.';
	return 'Выбранный SOCKS будет использоваться только отдельным SockRoute service.';
}

function findSocksCandidate(candidates, host, port) {
	for (var i = 0; i < candidates.length; i++) {
		if (candidates[i].host === host && candidates[i].port === String(port))
			return candidates[i];
	}
	return null;
}

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(uci.load('sockroute'), null),
			L.resolveDefault(uci.load('sockroute_api'), null),
			L.resolveDefault(fs.exec(initPath, [ 'running' ]), { code: 1, stdout: '', stderr: '' }),
			{ code: 0, stdout: '', stderr: '' },
			{ code: 0, stdout: '', stderr: '' },
			{ code: 0, stdout: '', stderr: '' }
		]);
	},

	runCommand: function(path, args) {
		return fs.exec(path, args).then(function(res) {
			if (res.code !== 0) {
				ui.addNotification(null, [
					E('p', 'Команда завершилась с ошибкой: %s %s'.format(path, args.join(' '))),
					res.stderr ? E('pre', {}, [ res.stderr ]) : ''
				], 'danger');
				return Promise.reject(res);
			}

			return res;
		});
	},

	captureDetailsState: function(root) {
		var state = {};

		if (!root)
			return state;

		root.querySelectorAll('details').forEach(function(node) {
			var summary = node.querySelector('summary');
			var key = summary ? summary.textContent.trim() : '';

			if (key)
				state[key] = node.open;
		});

		return state;
	},

	restoreDetailsState: function(root, state) {
		if (!root || !state)
			return;

		root.querySelectorAll('details').forEach(function(node) {
			var summary = node.querySelector('summary');
			var key = summary ? summary.textContent.trim() : '';

			if (key && state[key] != null)
				node.open = state[key];
		});
	},

	refreshView: function(message) {
		var root = document.getElementById('sockroute-root');
		var state = this.captureDetailsState(root);

		if (uci.unload)
			uci.unload([ 'sockroute', 'sockroute_api' ]);

		return this.load().then(L.bind(function(data) {
			var freshRoot = this.render(data);

			if (root && root.parentNode) {
				root.parentNode.replaceChild(freshRoot, root);
				this.restoreDetailsState(freshRoot, state);
			}

			if (message)
				ui.addNotification(null, E('p', message), 'info');
		}, this), L.bind(function(err) {
			ui.addNotification(null, [
				E('p', 'Не удалось обновить данные SockRoute без перезагрузки страницы.'),
				err && err.message ? E('pre', {}, [ err.message ]) : ''
			], 'danger');
			throw err;
		}, this));
	},

	refreshDeferredData: function() {
		if (this.deferredDataBusy)
			return Promise.resolve();
		if (!document.getElementById('sockroute-root'))
			return Promise.resolve();

		this.deferredDataBusy = true;

		return Promise.all([
			L.resolveDefault(fs.exec(helperPath, [ 'list' ]), { code: 1, stdout: '', stderr: '' }),
			L.resolveDefault(fs.exec(helperPath, [ 'socks-list' ]), { code: 1, stdout: '', stderr: '' }),
			L.resolveDefault(fs.exec(helperPath, [ 'dhcp-list' ]), { code: 1, stdout: '', stderr: '' })
		]).then(L.bind(function(data) {
			this.deferredRuntime = data[0] && data[0].stdout ? data[0].stdout : '';
			this.deferredRuntimeError = data[0] && data[0].stderr ? data[0].stderr : '';
			this.deferredSocksCandidates = parseSocksCandidates(data[1] && data[1].stdout ? data[1].stdout : '');
			this.deferredDhcpHosts = parseDhcpHosts(data[2] && data[2].stdout ? data[2].stdout : '');
			this.deferredDataLoaded = true;
			this.deferredDataBusy = false;
			return this.refreshView();
		}, this), L.bind(function(err) {
			this.deferredDataBusy = false;
			ui.addNotification(null, [
				E('p', 'Не удалось дозагрузить runtime/DHCP/SOCKS данные SockRoute.'),
				err && err.message ? E('pre', {}, [ err.message ]) : ''
			], 'warning');
			throw err;
		}, this));
	},

	notifyAndRefresh: function(message) {
		return this.refreshView(message);
	},

	handleService: function(action) {
		return this.runCommand(initPath, [ action ]).then(L.bind(function() {
			return this.notifyAndRefresh('Действие с сервисом выполнено.');
		}, this));
	},

	handleSetup: function() {
		return this.runCommand(helperPath, [ 'setup' ]).then(L.bind(function() {
			return this.notifyAndRefresh('Runtime nft-правила обновлены.');
		}, this));
	},

	handleDiagnostics: function() {
		return fs.exec(helperPath, [ 'health' ]).then(L.bind(function(res) {
			var rows = parseHealth(res.stdout || '');

			ui.showModal('Диагностика SockRoute', [
				E('div', { 'class': 'cbi-map' }, [
					E('div', { 'class': 'cbi-section' }, [
						E('h3', {}, [ 'Проверки' ]),
						buildHealthTable(rows)
					])
				]),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn',
						'click': ui.hideModal
					}, [ 'Закрыть' ])
				])
			]);
		}, this));
	},

	handleSettingsModal: function(settings) {
		var apiExamplesText = buildApiExamplesText(settings.clients || [], settings.socksProfiles || [], settings.apiRoot || apiRoot(), settings.apiToken || '');
		var apiExamples = buildApiExamplesTable(settings.clients || [], settings.socksProfiles || [], settings.apiRoot || apiRoot(), settings.apiToken || '');
		var haYaml = buildHomeAssistantYaml(settings.clients || [], settings.apiRoot || apiRoot(), settings.apiToken || '');
		var runtimeText = settings.runtime || settings.runtimeError || (settings.deferredLoaded ? 'Нет runtime-данных.' : 'Runtime-данные загружаются после открытия страницы...');

		ui.showModal('Настройки SockRoute', [
			E('div', { 'class': 'cbi-map' }, [
				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, [ 'Проверки' ]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'sockroute-auto-apply' }, [ 'Автосохранение' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', {
								'id': 'sockroute-auto-apply',
								'type': 'checkbox',
								'checked': settings.autoApply ? 'checked' : null
							}),
							' ',
							E('span', {}, [ 'сразу применять изменения в таблицах' ])
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'sockroute-check-loop' }, [ 'Проверка по кругу' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', {
								'id': 'sockroute-check-loop',
								'type': 'checkbox',
								'checked': settings.checkLoop ? 'checked' : null
							}),
							' ',
							E('span', {}, [ 'повторять проверки SOCKS и DNS' ])
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'sockroute-socks-check-interval' }, [ 'SOCKS проверки' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', {
								'id': 'sockroute-socks-check-interval',
								'type': 'text',
								'class': 'cbi-input-text',
								'style': 'width:8em;',
								'value': String(settings.socksCheckInterval || 30)
							}),
							' ',
							E('span', {}, [ 'секунд' ])
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'sockroute-dns-check-interval' }, [ 'DNS проверки' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', {
								'id': 'sockroute-dns-check-interval',
								'type': 'text',
								'class': 'cbi-input-text',
								'style': 'width:8em;',
								'value': String(settings.dnsCheckInterval || 30)
							}),
							' ',
							E('span', {}, [ 'секунд' ])
						])
					])
				]),
				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, [ 'API' ]),
					E('div', { 'class': 'cbi-section-descr' }, [
						'HTTP API принимает запросы только с разрешённых IP. Token необязателен; если он задан, его нужно передавать в URL или заголовке X-SockRoute-Token.'
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'sockroute-api-allowed-sources' }, [ 'Разрешённые IP' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', {
								'id': 'sockroute-api-allowed-sources',
								'type': 'text',
								'class': 'cbi-input-text',
								'style': 'min-width:28em;',
								'value': (settings.allowedSources || []).join(' '),
								'placeholder': '192.168.1.2 192.168.1.3'
							})
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'sockroute-api-target-cidr' }, [ 'Сеть клиентов' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', {
								'id': 'sockroute-api-target-cidr',
								'type': 'text',
								'class': 'cbi-input-text',
								'style': 'min-width:12em;',
								'value': settings.targetCidr || '192.168.1.0/24',
								'placeholder': '192.168.1.0/24'
							})
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'sockroute-api-token' }, [ 'API token' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', {
								'id': 'sockroute-api-token',
								'type': 'text',
								'class': 'cbi-input-text',
								'style': 'width:100%; max-width:28em;',
								'value': settings.apiToken || '',
								'placeholder': 'пусто: проверка только по IP'
							}),
							' ',
							E('button', {
								'class': 'btn cbi-button-action',
								'click': ui.createHandlerFn(this, 'handleGenerateApiToken')
							}, [ 'Сгенерировать' ])
						])
					]),
					buildApiHelp(settings.clients || [], settings.socksProfiles || [], settings.apiRoot || apiRoot(), settings.apiToken || ''),
					E('details', {}, [
						E('summary', { 'style': 'cursor:pointer; font-weight:bold;' }, [ 'Примеры API URL' ]),
						E('div', { 'class': 'cbi-section-descr' }, [
							'URL генерируются по текущему списку клиентов, текущему адресу LuCI и сохранённым исходящим SOCKS.'
						]),
						E('button', {
							'class': 'btn cbi-button-action',
							'click': function() {
								return copyText(apiExamplesText, 'API URL скопированы.');
							}
						}, [ 'Копировать все URL' ]),
						apiExamples
					])
				]),
				E('details', { 'class': 'cbi-section' }, [
					E('summary', { 'style': 'cursor:pointer; font-weight:bold;' }, [ 'Home Assistant command_line' ]),
					E('div', { 'class': 'cbi-section-descr' }, [
						'YAML генерируется по текущему списку клиентов. После добавления, удаления или редактирования клиента этот блок автоматически меняется.'
					]),
					E('button', {
						'class': 'btn cbi-button-action',
						'click': function() {
							return copyText(haYaml, 'Home Assistant YAML скопирован.');
						}
					}, [ 'Копировать YAML' ]),
					E('pre', { 'style': 'white-space:pre-wrap; max-height:360px; overflow:auto;' }, [ haYaml ])
				]),
				E('details', { 'class': 'cbi-section' }, [
					E('summary', { 'style': 'cursor:pointer; font-weight:bold;' }, [ 'Runtime set' ]),
					E('div', { 'class': 'right', 'style': 'margin-bottom:8px;' }, [
						E('button', {
							'class': 'btn cbi-button-action',
							'click': ui.createHandlerFn(this, 'handleSetup')
						}, [ 'Обновить runtime' ])
					]),
					E('pre', {
						'id': 'sockroute-runtime-pre',
						'style': 'white-space:pre-wrap; max-height:320px; overflow:auto;'
					}, [ runtimeText ])
				])
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ 'Отмена' ]),
				' ',
				E('button', {
					'class': 'btn cbi-button-save important',
					'disabled': window.sockrouteAutoApplyBusy ? 'disabled' : null,
					'click': ui.createHandlerFn(this, 'handleSaveSettings')
				}, [ 'Сохранить' ])
			])
		]);
	},

	handleSaveSettings: function() {
		var autoInput = document.getElementById('sockroute-auto-apply');
		var checkLoopInput = document.getElementById('sockroute-check-loop');
		var socksIntervalInput = document.getElementById('sockroute-socks-check-interval');
		var dnsIntervalInput = document.getElementById('sockroute-dns-check-interval');
		var sourcesInput = document.getElementById('sockroute-api-allowed-sources');
		var cidrInput = document.getElementById('sockroute-api-target-cidr');
		var tokenInput = document.getElementById('sockroute-api-token');
		var socksInterval = socksIntervalInput ? socksIntervalInput.value.trim() : '';
		var dnsInterval = dnsIntervalInput ? dnsIntervalInput.value.trim() : '';
		var sources = splitList(sourcesInput ? sourcesInput.value : '');
		var cidr = cidrInput ? cidrInput.value.trim() : '';
		var token = tokenInput ? tokenInput.value.trim() : '';

		if (!validateIntervalSeconds(socksInterval)) {
			ui.addNotification(null, E('p', 'Интервал проверки SOCKS должен быть 5-3600 секунд.'), 'danger');
			return Promise.resolve();
		}
		if (!validateIntervalSeconds(dnsInterval)) {
			ui.addNotification(null, E('p', 'Интервал проверки DNS должен быть 5-3600 секунд.'), 'danger');
			return Promise.resolve();
		}
		if (sources.length === 0) {
			ui.addNotification(null, E('p', 'Нужно указать хотя бы один разрешённый IP.'), 'danger');
			return Promise.resolve();
		}
		for (var i = 0; i < sources.length; i++) {
			if (!validateIp4(sources[i])) {
				ui.addNotification(null, E('p', 'Неверный разрешённый IP: %s'.format(sources[i])), 'danger');
				return Promise.resolve();
			}
		}
		if (!validateCidr4(cidr)) {
			ui.addNotification(null, E('p', 'Сеть клиентов должна быть в CIDR-формате, например 192.168.1.0/24.'), 'danger');
			return Promise.resolve();
		}
		if (!validateApiToken(token)) {
			ui.addNotification(null, E('p', 'Token должен быть пустым или содержать 8-128 символов: A-Z, a-z, 0-9, точка, подчёркивание, тире, тильда.'), 'danger');
			return Promise.resolve();
		}

		uci.set('sockroute', 'main', 'auto_apply', autoInput && autoInput.checked ? '1' : '0');
		uci.set('sockroute', 'main', 'check_loop', checkLoopInput && checkLoopInput.checked ? '1' : '0');
		uci.set('sockroute', 'main', 'socks_check_interval', socksInterval);
		uci.set('sockroute', 'main', 'dns_check_interval', dnsInterval);
		uci.set('sockroute_api', 'main', 'allowed_source_ip', sources);
		uci.set('sockroute_api', 'main', 'allowed_target_cidr', cidr);
		uci.unset('sockroute_api', 'main', 'allowed_target_prefix');
		uci.set('sockroute_api', 'main', 'backend', 'sockroute');
		if (token)
			uci.set('sockroute_api', 'main', 'token', token);
		else
			uci.unset('sockroute_api', 'main', 'token');

		return uci.save().then(L.bind(ui.changes.init, ui.changes)).then(L.bind(ui.changes.apply, ui.changes)).then(L.bind(function() {
			ui.hideModal();
			return this.notifyAndRefresh('Настройки SockRoute сохранены.');
		}, this));
	},

	handleToggleClient: function(enabled, ip, fallbackLabel) {
		if (!validateIp4(ip)) {
			ui.addNotification(null, E('p', 'Неверный IPv4-адрес.'), 'danger');
			return Promise.resolve();
		}

		if (enabled) {
			return this.runCommand(helperPath, [ 'del', ip ]).then(L.bind(function() {
				return this.notifyAndRefresh('Маршрут для клиента выключен.');
			}, this));
		}

		return this.runCommand(helperPath, [ 'add-named', ip, fallbackLabel || ip ]).then(L.bind(function() {
			return this.notifyAndRefresh('Маршрут для клиента включён.');
		}, this));
	},

	pendingClientChanges: function() {
		if (typeof(window) === 'undefined')
			return {};
		if (!window.sockroutePendingClientChanges)
			window.sockroutePendingClientChanges = {};
		return window.sockroutePendingClientChanges;
	},

	pendingClientChangeCount: function() {
		var pending = this.pendingClientChanges();
		var count = 0;

		for (var ip in pending)
			if (pending.hasOwnProperty(ip))
				count++;
		return count;
	},

	updatePendingClientUi: function() {
		var count = this.pendingClientChangeCount();
		var counter = document.getElementById('sockroute-pending-client-count');
		var button = document.getElementById('sockroute-save-pending-clients');

		if (counter) {
			counter.textContent = count ? 'Ожидают сохранения: %d'.format(count) : '';
			counter.style.display = count ? 'inline' : 'none';
		}
		if (button)
			button.disabled = count ? null : 'disabled';
	},

	stageClientChange: function(client, key, value) {
		var pending = this.pendingClientChanges();
		var marker;

		if (!validateIp4(client.ip)) {
			ui.addNotification(null, E('p', 'Неверный IPv4-адрес клиента.'), 'danger');
			return Promise.resolve();
		}

		if (!pending[client.ip])
			pending[client.ip] = { label: client.label || client.ip };
		pending[client.ip][key] = value;

		marker = document.getElementById('sockroute-client-pending-%s'.format(domId(client.ip)));
		if (marker)
			marker.textContent = 'есть изменения';
		this.updatePendingClientUi();
		ui.addNotification(null, E('p', 'Изменение клиента "%s" ожидает сохранения.'.format(client.label || client.ip)), 'info');
		return Promise.resolve();
	},

	handleSavePendingClientChanges: function() {
		var pending = this.pendingClientChanges();
		var socksProfiles = this.socksProfiles || [];
		var ips = [];
		var sequence = Promise.resolve();

		for (var ip in pending)
			if (pending.hasOwnProperty(ip))
				ips.push(ip);

		if (!ips.length) {
			ui.addNotification(null, E('p', 'Изменений для сохранения нет.'), 'info');
			return Promise.resolve();
		}

		window.sockrouteAutoApplyBusy = true;

		ips.forEach(L.bind(function(ip) {
			var change = pending[ip] || {};

			sequence = sequence.then(L.bind(function() {
				var value = change.socks;
				var selectedRef;
				var endpoint;

				if (value == null)
					return Promise.resolve();

				selectedRef = value && value.indexOf('ref|') === 0 ? value.split('|')[1] : '';
				endpoint = endpointFromValue(value, socksProfiles);

				if (!value)
					return this.runCommand(helperPath, [ 'clear-client-socks', ip ]);
				if (selectedRef)
					return this.runCommand(helperPath, [ 'rename', ip, change.label || ip ]).then(L.bind(function() {
						return this.runCommand(helperPath, [ 'set-client-socks-ref', ip, selectedRef ]);
					}, this));
				if (endpoint && validateIp4(endpoint.host) && validatePort(endpoint.port))
					return this.runCommand(helperPath, [ 'rename', ip, change.label || ip ]).then(L.bind(function() {
						return this.runCommand(helperPath, [ 'set-client-socks', ip, endpoint.host, endpoint.port ]);
					}, this));

				ui.addNotification(null, E('p', 'Неверный исходящий SOCKS для %s.'.format(ip)), 'danger');
				return Promise.reject(new Error('bad pending socks'));
			}, this)).then(L.bind(function() {
				var value = change.dns;

				if (value == null)
					return Promise.resolve();
				if (!value)
					return this.runCommand(helperPath, [ 'clear-client-dns', ip ]);
				if (value === 'manual') {
					ui.addNotification(null, E('p', 'Manual DNS для %s меняется через Edit.'.format(ip)), 'danger');
					return Promise.reject(new Error('bad pending dns'));
				}
				return this.runCommand(helperPath, [ 'set-client-dns-ref', ip, value ]);
			}, this));
		}, this));

		return sequence.then(L.bind(function() {
			return this.runCommand(initPath, [ 'restart' ]);
		}, this)).then(L.bind(function() {
			window.sockroutePendingClientChanges = {};
			window.sockrouteAutoApplyBusy = false;
			return this.notifyAndRefresh('Изменения клиентов сохранены, SockRoute перезапущен.');
		}, this), function(err) {
			window.sockrouteAutoApplyBusy = false;
			throw err;
		});
	},

	handleClientSocksChange: function(client, value) {
		var selectedRef = value && value.indexOf('ref|') === 0 ? value.split('|')[1] : '';
		var endpoint = endpointFromValue(value, this.socksProfiles || []);
		var sequence;
		var selectedProfile = selectedRef ? findSocksProfile(this.socksProfiles || [], selectedRef) : null;

		if (!this.autoApply) {
			return this.stageClientChange(client, 'socks', value);
		}
		if (!validateIp4(client.ip)) {
			ui.addNotification(null, E('p', 'Неверный IPv4-адрес клиента.'), 'danger');
			return Promise.resolve();
		}

		if (!value) {
			sequence = this.runCommand(helperPath, [ 'clear-client-socks', client.ip ]);
		}
		else if (selectedRef) {
			sequence = this.runCommand(helperPath, [ 'rename', client.ip, client.label || client.ip ]).then(L.bind(function() {
				return this.runCommand(helperPath, [ 'set-client-socks-ref', client.ip, selectedRef ]);
			}, this));
		}
		else if (endpoint && validateIp4(endpoint.host) && validatePort(endpoint.port)) {
			sequence = this.runCommand(helperPath, [ 'rename', client.ip, client.label || client.ip ]).then(L.bind(function() {
				return this.runCommand(helperPath, [ 'set-client-socks', client.ip, endpoint.host, endpoint.port ]);
			}, this));
		}
		else {
			ui.addNotification(null, E('p', 'Неверный исходящий SOCKS.'), 'danger');
			return Promise.resolve();
		}

		window.sockrouteAutoApplyBusy = true;
		return sequence.then(L.bind(function() {
			return this.runCommand(initPath, [ 'restart' ]);
		}, this)).then(L.bind(function() {
			if (!value) {
				client.socksRef = '';
				client.socksLabel = '';
				client.socksHost = '';
				client.socksPort = '';
			}
			else if (selectedProfile) {
				client.socksRef = selectedProfile.section;
				client.socksLabel = selectedProfile.label;
				client.socksHost = selectedProfile.host;
				client.socksPort = selectedProfile.port;
			}
			else if (endpoint) {
				client.socksRef = '';
				client.socksLabel = '';
				client.socksHost = endpoint.host;
				client.socksPort = endpoint.port;
			}

			recalculateSocksUsage();
			window.sockrouteAutoApplyBusy = false;
			ui.addNotification(null, E('p', 'Исходящий SOCKS клиента обновлён.'), 'info');
		}, this), function(err) {
			window.sockrouteAutoApplyBusy = false;
			throw err;
		});
	},

	handleClientDnsChange: function(client, value) {
		if (!this.autoApply) {
			return this.stageClientChange(client, 'dns', value);
		}
		if (!validateIp4(client.ip)) {
			ui.addNotification(null, E('p', 'Неверный IPv4-адрес клиента.'), 'danger');
			return Promise.resolve();
		}

		window.sockrouteAutoApplyBusy = true;
		if (!value) {
			return this.runCommand(helperPath, [ 'clear-client-dns', client.ip ]).then(L.bind(function() {
				return this.runCommand(initPath, [ 'restart' ]);
			}, this)).then(L.bind(function() {
				client.dnsRef = '';
				client.dnsServers = [];
				window.sockrouteAutoApplyBusy = false;
				ui.addNotification(null, E('p', 'DNS клиента переключён на default.'), 'info');
			}, this), function(err) {
				window.sockrouteAutoApplyBusy = false;
				throw err;
			});
		}

		return this.runCommand(helperPath, [ 'set-client-dns-ref', client.ip, value ]).then(L.bind(function() {
			return this.runCommand(initPath, [ 'restart' ]);
		}, this)).then(L.bind(function() {
			client.dnsRef = value;
			client.dnsServers = [];
			window.sockrouteAutoApplyBusy = false;
			ui.addNotification(null, E('p', 'DNS клиента обновлён.'), 'info');
		}, this), function(err) {
			window.sockrouteAutoApplyBusy = false;
			throw err;
		});
	},

	handleDeleteClient: function(ip, fallbackLabel) {
		var label = fallbackLabel || ip;

		if (!validateIp4(ip)) {
			ui.addNotification(null, E('p', 'Неверный IPv4-адрес.'), 'danger');
			return Promise.resolve();
		}
		if (!window.confirm('Удалить клиента "%s" (%s)? IP будет убран из runtime set.'.format(label, ip)))
			return Promise.resolve();

		return this.runCommand(helperPath, [ 'delete-client', ip ]).then(L.bind(function() {
			return this.notifyAndRefresh('Клиент удалён.');
		}, this));
	},

	handleEditClient: function(client, socksProfiles, socksCandidates, defaultSocksHost, defaultSocksPort) {
		var labelId = 'sockroute-edit-label';
		var ipId = 'sockroute-edit-ip';
		var socksSelectId = 'sockroute-edit-socks-candidate';
		var socksHostId = 'sockroute-edit-socks-host';
		var socksPortId = 'sockroute-edit-socks-port';
		var dnsServersId = 'sockroute-edit-dns-servers';
		var selectedSocks = client.socksRef ? 'ref|' + client.socksRef : client.socksHost && client.socksPort ? rawSocksValue(client.socksHost, client.socksPort) : '';
		var socksOptions = [
			E('option', { 'value': '' }, [ 'Использовать SOCKS по умолчанию' ])
		].concat((socksProfiles || []).map(function(profile) {
			var value = socksProfileValue(profile);
			var text = '%s - %s:%s'.format(profile.label, profile.host, profile.port);
			var attrs = { 'value': value };

			if (value === selectedSocks)
				attrs.selected = 'selected';
			return E('option', attrs, [ text ]);
		})).concat((socksCandidates || []).map(function(candidate) {
			var value = rawSocksValue(candidate.host, candidate.port);
			var text = '%s:%s - [%s] %s'.format(candidate.host, candidate.port, socksCandidateBadge(candidate), candidate.label);
			var attrs = { 'value': value };

			if (value === selectedSocks)
				attrs.selected = 'selected';
			return E('option', attrs, [ text ]);
		}));

		ui.showModal('Редактировать клиента', [
			E('div', { 'class': 'cbi-map' }, [
				E('div', { 'class': 'cbi-section' }, [
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': labelId }, [ 'Название' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', {
								'id': labelId,
								'type': 'text',
								'class': 'cbi-input-text',
								'value': client.label
							})
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': ipId }, [ 'IP' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', {
								'id': ipId,
								'type': 'text',
								'class': 'cbi-input-text',
								'value': client.ip
							})
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': socksSelectId }, [ 'Исходящие SOCKS' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('select', {
								'id': socksSelectId,
								'class': 'cbi-input-select',
								'style': 'width:100%; max-width:42em;',
								'change': function(ev) {
									fillSocksInputIds(ev.target.value, socksHostId, socksPortId, socksProfiles);
								}
							}, socksOptions)
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': dnsServersId }, [ 'DNS серверы' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('textarea', {
								'id': dnsServersId,
								'class': 'cbi-input-textarea',
								'style': 'width:100%; max-width:42em; min-height:5em;',
								'placeholder': 'udp://1.1.1.1\ntls://1.1.1.1\nhttps://1.1.1.1/dns-query'
							}, [ (client.dnsServers || []).join('\n') ]),
							E('div', { 'class': 'cbi-value-description' }, [
								'Один или несколько DNS для клиента. Форматы: UDP/TLS/HTTPS, например 1.1.1.1, udp://8.8.8.8, tls://1.1.1.1, https://1.1.1.1/dns-query. Пусто — default DNS: %s.'.format(uci.get('sockroute', 'main', 'default_dns_server') || ('udp://' + (uci.get('sockroute', 'main', 'realip_dns_addr') || '1.1.1.1')))
							])
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': socksHostId }, [ 'SOCKS IP' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', {
								'id': socksHostId,
								'type': 'text',
								'class': 'cbi-input-text',
								'style': 'width:100%; max-width:14em;',
								'value': client.socksHost || '',
								'placeholder': defaultSocksHost || 'по умолчанию'
							}),
							' ',
							E('input', {
								'id': socksPortId,
								'type': 'text',
								'class': 'cbi-input-text',
								'style': 'width:8em;',
								'value': client.socksPort || '',
								'placeholder': defaultSocksPort || 'порт'
							}),
							E('div', { 'class': 'cbi-value-description' }, [
								'Оставьте оба поля пустыми, чтобы клиент использовал глобальный SOCKS.'
							])
						])
					])
				])
			]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					'click': ui.hideModal
				}, [ 'Отмена' ]),
				' ',
				E('button', {
					'class': 'btn cbi-button-save important',
					'click': ui.createHandlerFn(this, 'handleEditClientSave', client, labelId, ipId, socksSelectId, socksHostId, socksPortId, dnsServersId, defaultSocksHost, defaultSocksPort)
				}, [ 'Сохранить' ])
			])
		]);

		var input = document.getElementById(labelId);
		if (input)
			input.focus();
	},

	handleEditClientSave: function(client, labelId, ipId, socksSelectId, socksHostId, socksPortId, dnsServersId, defaultSocksHost, defaultSocksPort) {
		var labelInput = document.getElementById(labelId);
		var ipInput = document.getElementById(ipId);
		var socksSelect = document.getElementById(socksSelectId);
		var socksHostInput = document.getElementById(socksHostId);
		var socksPortInput = document.getElementById(socksPortId);
		var dnsServersInput = document.getElementById(dnsServersId);
		var label = labelInput ? labelInput.value.trim() : '';
		var ip = ipInput ? ipInput.value.trim() : '';
		var selectedSocks = socksSelect ? socksSelect.value : '';
		var selectedRef = selectedSocks.indexOf('ref|') === 0 ? selectedSocks.split('|')[1] : '';
		var socksHost = socksHostInput ? socksHostInput.value.trim() : '';
		var socksPort = socksPortInput ? socksPortInput.value.trim() : '';
		var dnsServers = splitList(dnsServersInput ? dnsServersInput.value : '');
		var customSocks = socksHost || socksPort;
		var sequence;

		if (!validateIp4(ip)) {
			ui.addNotification(null, E('p', 'Неверный IPv4-адрес.'), 'danger');
			return Promise.resolve();
		}

		if (customSocks && (!validateIp4(socksHost) || !validatePort(socksPort))) {
			ui.addNotification(null, E('p', 'SOCKS клиента должен быть пустым или задан как IPv4 + порт.'), 'danger');
			return Promise.resolve();
		}

		for (var i = 0; i < dnsServers.length; i++) {
			if (!validateDnsServerSpec(dnsServers[i])) {
				ui.addNotification(null, E('p', 'Неверный DNS сервер: %s'.format(dnsServers[i])), 'danger');
				return Promise.resolve();
			}
		}

		label = label || ip;

		if (ip === client.ip) {
			sequence = this.runCommand(helperPath, [ 'rename', ip, label ]);
		}
		else {
			sequence = this.runCommand(helperPath, [ 'delete-client', client.ip ]).then(L.bind(function() {
				var action = client.active ? 'add-named' : 'rename';
				return this.runCommand(helperPath, [ action, ip, label ]);
			}, this));
		}

		return sequence.then(L.bind(function() {
			if (selectedRef)
				return this.runCommand(helperPath, [ 'set-client-socks-ref', ip, selectedRef ]);
			if (!customSocks || (socksHost === defaultSocksHost && socksPort === String(defaultSocksPort)))
				return this.runCommand(helperPath, [ 'clear-client-socks', ip ]);
			return this.runCommand(helperPath, [ 'set-client-socks', ip, socksHost, socksPort ]);
		}, this)).then(L.bind(function() {
			if (dnsServers.length)
				return this.runCommand(helperPath, [ 'set-client-dns', ip ].concat(dnsServers));
			if (client.dnsRef)
				return this.runCommand(helperPath, [ 'set-client-dns-ref', ip, client.dnsRef ]);
			return this.runCommand(helperPath, [ 'clear-client-dns', ip ]);
		}, this)).then(L.bind(function() {
			return this.runCommand(initPath, [ 'restart' ]);
		}, this)).then(L.bind(function() {
			ui.hideModal();
			return this.notifyAndRefresh('Клиент обновлён.');
		}, this));
	},
	handleSaveApi: function() {
		var sourcesInput = document.getElementById('sockroute-api-allowed-sources');
		var cidrInput = document.getElementById('sockroute-api-target-cidr');
		var tokenInput = document.getElementById('sockroute-api-token');
		var sources = splitList(sourcesInput ? sourcesInput.value : '');
		var cidr = cidrInput ? cidrInput.value.trim() : '';
		var token = tokenInput ? tokenInput.value.trim() : '';

		if (sources.length === 0) {
			ui.addNotification(null, E('p', 'Нужно указать хотя бы один разрешённый IP.'), 'danger');
			return Promise.resolve();
		}

		for (var i = 0; i < sources.length; i++) {
			if (!validateIp4(sources[i])) {
				ui.addNotification(null, E('p', 'Неверный разрешённый IP: %s'.format(sources[i])), 'danger');
				return Promise.resolve();
			}
		}

		if (!validateCidr4(cidr)) {
			ui.addNotification(null, E('p', 'Сеть клиентов должна быть в CIDR-формате, например 192.168.1.0/24.'), 'danger');
			return Promise.resolve();
		}

		if (!validateApiToken(token)) {
			ui.addNotification(null, E('p', 'Token должен быть пустым или содержать 8-128 символов: A-Z, a-z, 0-9, точка, подчёркивание, тире, тильда.'), 'danger');
			return Promise.resolve();
		}

		uci.set('sockroute_api', 'main', 'allowed_source_ip', sources);
		uci.set('sockroute_api', 'main', 'allowed_target_cidr', cidr);
		uci.unset('sockroute_api', 'main', 'allowed_target_prefix');
		uci.set('sockroute_api', 'main', 'backend', 'sockroute');
		if (token)
			uci.set('sockroute_api', 'main', 'token', token);
		else
			uci.unset('sockroute_api', 'main', 'token');

		return uci.save().then(L.bind(ui.changes.init, ui.changes)).then(L.bind(ui.changes.apply, ui.changes)).then(L.bind(function() {
			return this.notifyAndRefresh('Настройки API сохранены.');
		}, this));
	},

	handleGenerateApiToken: function() {
		var tokenInput = document.getElementById('sockroute-api-token');
		if (tokenInput)
			tokenInput.value = generateApiToken();
		return Promise.resolve();
	},

	handleSaveSocks: function() {
		var hostInput = document.getElementById('sockroute-socks-host');
		var portInput = document.getElementById('sockroute-socks-port');
		var host = hostInput ? hostInput.value.trim() : '';
		var port = portInput ? portInput.value.trim() : '';

		if (!validateIp4(host)) {
			ui.addNotification(null, E('p', 'Неверный SOCKS IP.'), 'danger');
			return Promise.resolve();
		}

		if (!validatePort(port)) {
			ui.addNotification(null, E('p', 'Неверный SOCKS порт. Допустимо 1-65535.'), 'danger');
			return Promise.resolve();
		}

		return this.runCommand(helperPath, [ 'set-socks', host, port ]).then(L.bind(function() {
			return this.runCommand(initPath, [ 'restart' ]);
		}, this)).then(L.bind(function() {
			return this.notifyAndRefresh('Исходящий SOCKS сохранён, SockRoute перезапущен.');
		}, this));
	},

	handleSaveSocksRef: function(section) {
		return this.runCommand(helperPath, [ 'set-socks-ref', section ]).then(L.bind(function() {
			return this.runCommand(initPath, [ 'restart' ]);
		}, this)).then(L.bind(function() {
			return this.notifyAndRefresh('SOCKS профиль выбран по умолчанию, SockRoute перезапущен.');
		}, this));
	},

	handleSaveDefaultDns: function() {
		var dnsInput = document.getElementById('sockroute-default-dns');
		var dnsServer = dnsInput ? dnsInput.value.trim() : '';

		if (!validateDnsServerSpec(dnsServer)) {
			ui.addNotification(null, E('p', 'Неверный default DNS. Форматы: 100.100.0.156, udp://100.100.0.156, tls://1.1.1.1, https://1.1.1.1/dns-query.'), 'danger');
			return Promise.resolve();
		}

		return this.runCommand(helperPath, [ 'set-default-dns', dnsServer ]).then(L.bind(function() {
			return this.runCommand(initPath, [ 'restart' ]);
		}, this)).then(L.bind(function() {
			return this.notifyAndRefresh('Default DNS сохранён, SockRoute перезапущен.');
		}, this));
	},

	handleSaveDnsProfiles: function() {
		var standardInput = document.getElementById('sockroute-dns-standard');
		var unblockInput = document.getElementById('sockroute-dns-unblock');
		var standard = standardInput ? standardInput.value.trim() : '';
		var unblock = unblockInput ? unblockInput.value.trim() : '';

		if (!validateDnsServerSpec(standard)) {
			ui.addNotification(null, E('p', 'Неверный DNS для DNS standard.'), 'danger');
			return Promise.resolve();
		}
		if (!validateDnsServerSpec(unblock)) {
			ui.addNotification(null, E('p', 'Неверный DNS для DNS unblock.'), 'danger');
			return Promise.resolve();
		}

		return this.runCommand(helperPath, [ 'set-dns-profile', 'standard', standard ]).then(L.bind(function() {
			return this.runCommand(helperPath, [ 'set-dns-profile', 'unblock', unblock ]);
		}, this)).then(L.bind(function() {
			return this.runCommand(initPath, [ 'restart' ]);
		}, this)).then(L.bind(function() {
			return this.notifyAndRefresh('DNS профили сохранены, SockRoute перезапущен.');
		}, this));
	},

	handleSaveDnsRef: function(section) {
		return this.runCommand(helperPath, [ 'set-dns-ref', section ]).then(L.bind(function() {
			return this.runCommand(initPath, [ 'restart' ]);
		}, this)).then(L.bind(function() {
			return this.notifyAndRefresh('DNS профиль выбран по умолчанию, SockRoute перезапущен.');
		}, this));
	},

	handleTestDnsProfile: function(profile) {
		return this.runCommand(helperPath, [ 'test-dns-profile', profile.section ]).then(function(res) {
			ui.showModal('Проверка DNS %s'.format(profile.label), [
				buildHealthTable(parseHealth(res.stdout || '')),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, [ 'Закрыть' ])
				])
			]);
		});
	},

	handleEditDnsProfile: function(profile) {
		var labelId = 'sockroute-dns-profile-label';
		var serverId = 'sockroute-dns-profile-server';
		var title = profile && profile.section ? 'Редактировать DNS профиль' : 'Добавить DNS профиль';

		ui.showModal(title, [
			E('div', { 'class': 'cbi-map' }, [
				E('div', { 'class': 'cbi-section' }, [
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': labelId }, [ 'Название' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', {
								'id': labelId,
								'type': 'text',
								'class': 'cbi-input-text',
								'value': profile && profile.label || '',
								'placeholder': 'DNS profile'
							})
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': serverId }, [ 'DNS server' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', {
								'id': serverId,
								'type': 'text',
								'class': 'cbi-input-text',
								'style': 'width:100%; max-width:42em;',
								'value': profile && profile.server || '',
								'placeholder': 'udp://100.100.0.217'
							})
						])
					])
				])
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ 'Отмена' ]),
				' ',
				E('button', {
					'class': 'btn cbi-button-save important',
					'click': ui.createHandlerFn(this, 'handleSaveDnsProfile', profile && profile.section || '-', labelId, serverId)
				}, [ 'Сохранить и проверить' ])
			])
		]);
	},

	handleSaveDnsProfile: function(section, labelId, serverId) {
		var labelInput = document.getElementById(labelId);
		var serverInput = document.getElementById(serverId);
		var label = labelInput ? labelInput.value.trim() : '';
		var server = serverInput ? serverInput.value.trim() : '';

		if (!label) {
			ui.addNotification(null, E('p', 'Нужно указать название DNS профиля.'), 'danger');
			return Promise.resolve();
		}
		if (!validateDnsServerSpec(server)) {
			ui.addNotification(null, E('p', 'Неверный DNS server.'), 'danger');
			return Promise.resolve();
		}

		return this.runCommand(helperPath, [ 'set-dns-profile', section, label, server ]).then(L.bind(function() {
			return this.runCommand(initPath, [ 'restart' ]);
		}, this)).then(L.bind(function() {
			ui.hideModal();
			return this.notifyAndRefresh('DNS профиль сохранён, SockRoute перезапущен.');
		}, this));
	},

	handleDeleteDnsProfile: function(profile) {
		if (!window.confirm('Удалить DNS профиль "%s"? Клиенты с этим профилем перейдут на default DNS.'.format(profile.label)))
			return Promise.resolve();
		return this.runCommand(helperPath, [ 'delete-dns-profile', profile.section ]).then(L.bind(function() {
			return this.runCommand(initPath, [ 'restart' ]);
		}, this)).then(L.bind(function() {
			return this.notifyAndRefresh('DNS профиль удалён, SockRoute перезапущен.');
		}, this));
	},

	handleTestSocksManual: function(hostId, portId) {
		var hostInput = document.getElementById(hostId);
		var portInput = document.getElementById(portId);
		var host = hostInput ? hostInput.value.trim() : '';
		var port = portInput ? portInput.value.trim() : '';

		if (!validateIp4(host) || !validatePort(port)) {
			ui.addNotification(null, E('p', 'SOCKS должен быть задан как IPv4 + порт.'), 'danger');
			return Promise.resolve();
		}

		return fs.exec(helperPath, [ 'test-socks', host, port ]).then(function(res) {
			ui.showModal('Проверка SOCKS %s:%s'.format(host, port), [
				buildHealthTable(parseHealth(res.stdout || '')),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn',
						'click': ui.hideModal
					}, [ 'Закрыть' ])
				])
			]);
		});
	},

	handleAddSocksProfile: function() {
		return this.handleSaveSocksProfile('-', 'sockroute-socks-label', 'sockroute-socks-host', 'sockroute-socks-port');
	},

	handleAddSocksProfileModal: function(socksCandidates, socksHost, socksPort, socksWarnings, socksLabels) {
		var candidateId = 'sockroute-socks-candidate';
		var candidateOptions = [
			E('option', { 'value': '' }, [ 'Ручной ввод' ])
		].concat((socksCandidates || []).map(function(candidate) {
			var value = rawSocksValue(candidate.host, candidate.port);
			var text = '%s:%s - [%s] %s'.format(candidate.host, candidate.port, socksCandidateBadge(candidate), candidate.label);
			if (candidate.source)
				text += ' [%s]'.format(candidate.source);
			return E('option', { 'value': value }, [ text ]);
		}));

		ui.showModal('Добавить исходящий SOCKS', [
			E('div', { 'class': 'cbi-map' }, [
				E('div', { 'class': 'cbi-section' }, [
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': candidateId }, [ 'SOCKS endpoint' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('select', {
								'id': candidateId,
								'class': 'cbi-input-select',
								'style': 'width:100%; max-width:42em;',
								'change': function(ev) {
									fillSocksBuilder(ev.target.value, socksWarnings || {}, socksLabels || {});
								}
							}, candidateOptions),
							(socksCandidates || []).length ? '' : E('div', { 'class': 'cbi-value-description' }, [ 'Кандидаты не найдены, можно указать endpoint вручную.' ])
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title' }, [ 'Подсказка' ]),
						E('div', {
							'id': 'sockroute-socks-warning',
							'class': 'cbi-value-field'
						}, [ socksCandidateWarning(null) ])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'sockroute-socks-label' }, [ 'Профиль' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', {
								'id': 'sockroute-socks-label',
								'type': 'text',
								'class': 'cbi-input-text',
								'style': 'width:100%; max-width:18em;',
								'placeholder': 'Название нового профиля'
							}),
							' ',
							E('input', {
								'id': 'sockroute-socks-host',
								'type': 'text',
								'class': 'cbi-input-text',
								'style': 'width:100%; max-width:14em;',
								'value': socksHost || '',
								'placeholder': 'SOCKS IP'
							}),
							' ',
							E('input', {
								'id': 'sockroute-socks-port',
								'type': 'text',
								'class': 'cbi-input-text',
								'style': 'width:8em;',
								'value': socksPort || '',
								'placeholder': 'порт'
							})
						])
					])
				])
			]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					'click': ui.hideModal
				}, [ 'Закрыть' ]),
				' ',
				E('button', {
					'class': 'btn cbi-button-add',
					'title': 'Создать сохранённый SOCKS профиль из указанного endpoint',
					'click': ui.createHandlerFn(this, 'handleAddSocksProfile')
				}, [ 'Добавить профиль' ]),
				' ',
				E('button', {
					'class': 'btn cbi-button-save',
					'title': 'Сделать указанный endpoint SOCKS по умолчанию и перезапустить только SockRoute',
					'click': ui.createHandlerFn(this, 'handleSaveSocks')
				}, [ 'Сделать default' ]),
				' ',
				E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(this, 'handleTestSocksManual', 'sockroute-socks-host', 'sockroute-socks-port')
				}, [ 'Проверить' ])
			])
		]);
	},

	handleEditSocksProfile: function(profile, socksCandidates) {
		var labelId = 'sockroute-profile-edit-label';
		var hostId = 'sockroute-profile-edit-host';
		var portId = 'sockroute-profile-edit-port';
		var candidateId = 'sockroute-profile-edit-candidate';
		var selected = rawSocksValue(profile.host, profile.port);
		var options = [
			E('option', { 'value': '' }, [ 'Выбрать найденный SOCKS...' ])
		].concat((socksCandidates || []).map(function(candidate) {
			var value = rawSocksValue(candidate.host, candidate.port);
			var attrs = { 'value': value };
			if (value === selected)
				attrs.selected = 'selected';
			return E('option', attrs, [ '%s:%s - [%s] %s'.format(candidate.host, candidate.port, socksCandidateBadge(candidate), candidate.label) ]);
		}));

		ui.showModal('Редактировать SOCKS профиль', [
			E('div', { 'class': 'cbi-map' }, [
				E('div', { 'class': 'cbi-section' }, [
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': labelId }, [ 'Название' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', { 'id': labelId, 'type': 'text', 'class': 'cbi-input-text', 'value': profile.label })
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': candidateId }, [ 'Найденный SOCKS' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('select', {
								'id': candidateId,
								'class': 'cbi-input-select',
								'style': 'width:100%; max-width:42em;',
								'change': function(ev) {
									fillSocksInputIds(ev.target.value, hostId, portId);
								}
							}, options)
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': hostId }, [ 'SOCKS IP' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', { 'id': hostId, 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%; max-width:14em;', 'value': profile.host }),
							' ',
							E('input', { 'id': portId, 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:8em;', 'value': profile.port })
						])
					])
				])
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ 'Отмена' ]),
				' ',
				E('button', {
					'class': 'btn cbi-button-save important',
					'click': ui.createHandlerFn(this, 'handleSaveSocksProfile', profile.section, labelId, hostId, portId)
				}, [ 'Сохранить и проверить' ])
			])
		]);
	},

	handleSaveSocksProfile: function(section, labelId, hostId, portId) {
		var labelInput = document.getElementById(labelId);
		var hostInput = document.getElementById(hostId);
		var portInput = document.getElementById(portId);
		var label = labelInput ? labelInput.value.trim() : '';
		var host = hostInput ? hostInput.value.trim() : '';
		var port = portInput ? portInput.value.trim() : '';

		if (!label) {
			ui.addNotification(null, E('p', 'Укажите название SOCKS профиля.'), 'danger');
			return Promise.resolve();
		}

		if (!validateIp4(host) || !validatePort(port)) {
			ui.addNotification(null, E('p', 'SOCKS профиль должен быть задан как IPv4 + порт.'), 'danger');
			return Promise.resolve();
		}

		return this.runCommand(helperPath, [ 'set-socks-profile', section || '-', label, host, port ]).then(L.bind(function() {
			return this.runCommand(initPath, [ 'restart' ]);
		}, this)).then(L.bind(function() {
			ui.hideModal();
			return this.notifyAndRefresh('SOCKS профиль сохранён и проверен.');
		}, this));
	},

	handleDeleteSocksProfile: function(profile) {
		if (!window.confirm('Удалить SOCKS профиль "%s" (%s:%s)?'.format(profile.label, profile.host, profile.port)))
			return Promise.resolve();

		return this.runCommand(helperPath, [ 'delete-socks-profile', profile.section ]).then(L.bind(function() {
			return this.runCommand(initPath, [ 'restart' ]);
		}, this)).then(L.bind(function() {
			return this.notifyAndRefresh('SOCKS профиль удалён.');
		}, this));
	},

	handleTestSocksProfile: function(profile) {
		return fs.exec(helperPath, [ 'test-socks-profile', profile.section ]).then(L.bind(function(res) {
			ui.showModal('Проверка SOCKS профиля "%s"'.format(profile.label), [
				buildHealthTable(parseHealth(res.stdout || '')),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn',
						'click': L.bind(function() {
							ui.hideModal();
							return this.refreshView('Проверка SOCKS профиля обновлена.');
						}, this)
					}, [ 'Закрыть' ])
				])
			]);
		}, this));
	},

	handleAddClientModal: function(deferredLoaded, dhcpHosts, dhcpOptions, dhcpRows) {
		ui.showModal('Добавить клиента', [
			E('div', { 'class': 'cbi-map' }, [
				E('div', { 'class': 'cbi-section' }, [
					E('div', { 'class': 'cbi-section-descr' }, [
						'Одиночное добавление и массовый импорт используют один источник: закреплённые DHCP host-записи из /etc/config/dhcp.'
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'sockroute-dhcp-picker' }, [ 'DHCP host-запись' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							!deferredLoaded ? E('em', {}, [ 'DHCP host-записи загружаются после открытия страницы...' ]) : (dhcpHosts || []).length ? E('select', {
								'id': 'sockroute-dhcp-picker',
								'class': 'cbi-input-select',
								'style': 'width:100%; max-width:42em;',
								'change': function(ev) {
									fillClientFromDhcp(ev.target.value);
								}
							}, dhcpOptions || []) : E('em', {}, [ 'Закреплённые DHCP host-записи не найдены.' ])
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'sockroute-label' }, [ 'Название' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', {
								'id': 'sockroute-label',
								'type': 'text',
								'class': 'cbi-input-text',
								'placeholder': 'Телевизор'
							})
						])
					]),
					E('div', { 'class': 'cbi-value' }, [
						E('label', { 'class': 'cbi-value-title', 'for': 'sockroute-ip' }, [ 'IP клиента' ]),
						E('div', { 'class': 'cbi-value-field' }, [
							E('input', {
								'id': 'sockroute-ip',
								'type': 'text',
								'class': 'cbi-input-text',
								'placeholder': '192.168.1.100'
							}),
							' ',
							E('button', {
								'class': 'btn cbi-button-add',
								'click': ui.createHandlerFn(this, 'handleAddManual')
							}, [ 'Добавить и ON' ])
						])
					]),
					E('details', { 'style': 'margin-top:12px;' }, [
						E('summary', {
							'style': 'cursor:pointer; display:inline-block; padding:4px 10px; border-radius:4px; border:1px solid rgba(127,127,127,.45); font-weight:700;'
						}, [ 'Импорт из DHCP' ]),
						E('div', { 'class': 'cbi-section-descr', 'style': 'margin-top:8px;' }, [
							'Выберите несколько закреплённых DHCP host-записей и добавьте их в профиль или сразу включите SockRoute.'
						]),
						!deferredLoaded ? E('em', {}, [ 'DHCP host-записи загружаются после открытия страницы...' ]) : (dhcpHosts || []).length ? E('div', {}, [
							E('div', { 'class': 'right' }, [
								E('button', {
									'class': 'btn cbi-button-add',
									'click': ui.createHandlerFn(this, 'handleImportDhcp', false)
								}, [ 'Добавить выбранные' ]),
								' ',
								E('button', {
									'class': 'btn cbi-button-apply',
									'click': ui.createHandlerFn(this, 'handleImportDhcp', true)
								}, [ 'Добавить выбранные и ON' ])
							]),
							E('div', { 'style': 'max-height:360px; overflow:auto;' }, [
								E('table', dataTableAttrs('cbi-section-table'), dhcpRows || [])
							])
						]) : E('em', {}, [ 'Закреплённые DHCP host-записи не найдены.' ])
					])
				])
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ 'Закрыть' ])
			])
		]);
	},

	handleAddManual: function() {
		var ipInput = document.getElementById('sockroute-ip');
		var labelInput = document.getElementById('sockroute-label');
		var ip = ipInput ? ipInput.value.trim() : '';
		var label = labelInput ? labelInput.value.trim() : '';

		if (!validateIp4(ip)) {
			ui.addNotification(null, E('p', 'Неверный IPv4-адрес.'), 'danger');
			return Promise.resolve();
		}

		return this.runCommand(helperPath, [ 'add-named', ip, label || ip ]).then(L.bind(function() {
			if (ipInput)
				ipInput.value = '';
			if (labelInput)
				labelInput.value = '';
			return this.notifyAndRefresh('Клиент добавлен и включён.');
		}, this));
	},

	handleImportDhcp: function(enable) {
		var checked = document.querySelectorAll('input[name="sockroute-dhcp-import"]:checked');
		var sequence = Promise.resolve();

		if (!checked.length) {
			ui.addNotification(null, E('p', 'Выберите хотя бы один DHCP-клиент.'), 'danger');
			return Promise.resolve();
		}

		for (var i = 0; i < checked.length; i++) {
			(function(input, self) {
				var ip = input.getAttribute('data-ip') || '';
				var label = input.getAttribute('data-label') || ip;
				var action = enable ? 'add-named' : 'rename';

				sequence = sequence.then(function() {
					return self.runCommand(helperPath, [ action, ip, label ]);
				});
			})(checked[i], this);
		}

		return sequence.then(L.bind(function() {
			return this.notifyAndRefresh(enable ? 'DHCP-клиенты добавлены и включены.' : 'DHCP-клиенты добавлены в список.');
		}, this));
	},

	handleCheckClient: function(client) {
		return this.runCommand(helperPath, [ 'check-client', client.ip ]).then(function(res) {
			var rows = parseHealth(res.stdout || '');
			ui.showModal('Проверка клиента %s'.format(client.ip), [
				buildHealthTable(rows),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn',
						'click': ui.hideModal
					}, [ 'Закрыть' ])
				])
			]);
		});
	},

	buildSocksProfiles: function() {
		return uci.sections('sockroute', 'socks').map(function(section) {
			return {
				section: sectionId(section),
				label: section.label || sectionId(section),
				host: section.host || '',
				port: section.port || '',
				lastCheck: section.last_check || 'unknown',
				lastCheckDetail: section.last_check_detail || '',
				lastCheckTime: section.last_check_time || ''
			};
		}).filter(function(profile) {
			return profile.section && validateIp4(profile.host) && validatePort(profile.port);
		}).sort(function(a, b) {
			return String(a.label).localeCompare(String(b.label));
		});
	},

	buildClients: function(activeClients, hiddenClients, socksProfiles, counters) {
		var map = {};
		var order = [];

		function add(ip, label, source, socksRef, socksHost, socksPort, dnsServers, dnsRef) {
			var profile = findSocksProfile(socksProfiles, socksRef || '');
			var counter = counters && counters[ip] || {};

			if (!validateIp4(ip))
				return;
			if (hiddenClients.indexOf(ip) >= 0 && source !== 'active')
				return;
			if (map[ip] == null)
				order.push(ip);
			map[ip] = {
				ip: ip,
				label: label || ip,
				active: activeClients.indexOf(ip) >= 0,
				source: source || 'profile',
				socksRef: profile ? profile.section : '',
				socksLabel: profile ? profile.label : '',
				socksHost: profile ? profile.host : socksHost || '',
				socksPort: profile ? profile.port : socksPort || '',
				dnsServers: asList(dnsServers),
				dnsRef: dnsRef || '',
				packets: counter.packets || 0,
				bytes: counter.bytes || 0
			};
		}

		uci.sections('sockroute', 'client').forEach(function(section) {
			add(section.ip, section.label || sectionId(section) || section.ip, 'profile', section.socks_ref || '', section.socks_host || '', section.socks_port || '', section.dns_server || [], section.dns_ref || '');
		});

		activeClients.forEach(function(ip) {
			if (map[ip])
				map[ip].active = true;
			else
				add(ip, ip, 'active');
		});

		return order.map(function(ip) {
			return map[ip];
		}).sort(function(a, b) {
			return ipSortValue(a.ip) - ipSortValue(b.ip);
		});
	},

	clientRow: function(client, index) {
		var self = this;
		var buttonClass = client.active ? 'btn cbi-button-remove' : 'btn cbi-button-apply';
		var buttonText = client.active ? 'OFF' : 'ON';
		var buttonStyle = 'min-width: 4.5em; text-align: center;';
		var source = clientSourceLabel(client.source);
		var selectedSocks = clientSocksValue(client);
		var socksProfiles = this.socksProfiles || [];
		var dnsProfiles = this.dnsProfiles || [];
		var selectedDns = client.dnsRef || ((client.dnsServers || []).length ? 'manual' : '');
		var socksOptions = [
			E('option', { 'value': '' }, [ 'default' ])
		].concat(socksProfiles.map(function(profile) {
			var value = socksProfileValue(profile);
			var attrs = { 'value': value };

			if (value === selectedSocks)
				attrs.selected = 'selected';

			return E('option', attrs, [ '%s - %s:%s'.format(profile.label, profile.host, profile.port) ]);
		}));
		if (selectedSocks && selectedSocks.indexOf('raw|') === 0) {
			socksOptions.push(E('option', { 'value': selectedSocks, 'selected': 'selected' }, [
				'%s:%s'.format(client.socksHost, client.socksPort)
			]));
		}
		var dnsOptions = [
			E('option', { 'value': '' }, [ 'default' ])
		].concat(dnsProfiles.map(function(profile) {
			var attrs = { 'value': profile.ref, 'title': profile.server };
			if (profile.ref === selectedDns)
				attrs.selected = 'selected';
			return E('option', attrs, [ profile.label ]);
		}));
		if (selectedDns === 'manual')
			dnsOptions.push(E('option', { 'value': 'manual', 'selected': 'selected', 'disabled': 'disabled' }, [ 'manual' ]));

		return E('tr', stripedRowAttrs(index || 0, client.active ? 'background:rgba(22,163,74,.12);' : ''), [
			E('td', {}, [ client.label ]),
			E('td', {}, [ client.ip ]),
			E('td', {}, [ routeBadge(client.active) ]),
			E('td', {}, [ E('span', { 'class': 'ifacebadge' }, [ source ]) ]),
			E('td', {}, [
				E('select', {
					'class': 'cbi-input-select',
					'data-sockroute-client-socks': client.ip,
					'data-default-ref': this.defaultSocksRef || '',
					'data-packets': String(Number(client.packets) || 0),
					'data-bytes': String(Number(client.bytes) || 0),
					'style': 'width:100%; min-width:12em; max-width:22em;',
					'change': function(ev) {
						return self.handleClientSocksChange(client, ev.target.value);
					}
				}, socksOptions)
			]),
			E('td', {}, [
				E('select', {
					'class': 'cbi-input-select',
					'style': 'width:100%; min-width:10em; max-width:14em;',
					'change': function(ev) {
						return self.handleClientDnsChange(client, ev.target.value);
					}
				}, dnsOptions)
			]),
			E('td', {
				'id': 'sockroute-client-traffic-%s'.format(domId(client.ip)),
				'title': trafficTitle(client),
				'style': 'white-space:nowrap;'
			}, [ trafficCellContent(client) ]),
			E('td', { 'class': 'right' }, [
				!this.autoApply ? E('span', {
					'id': 'sockroute-client-pending-%s'.format(domId(client.ip)),
					'class': 'ifacebadge inactive',
					'style': 'margin-right:6px;'
				}, [ '' ]) : '',
				E('button', {
					'class': 'btn cbi-button-edit',
					'click': ui.createHandlerFn(this, 'handleEditClient', client, this.socksProfiles || [], this.socksCandidates || [], this.defaultSocksHost || '', this.defaultSocksPort || '')
				}, [ 'Edit' ]),
				' ',
				E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(this, 'handleCheckClient', client)
				}, [ 'Проверить' ]),
				' ',
				E('button', {
					'class': buttonClass,
					'style': buttonStyle,
					'click': ui.createHandlerFn(this, 'handleToggleClient', client.active, client.ip, client.label)
				}, [ buttonText ]),
				' ',
				E('button', {
					'class': 'btn cbi-button-negative',
					'click': ui.createHandlerFn(this, 'handleDeleteClient', client.ip, client.label)
				}, [ 'Удалить' ])
			])
		]);
	},

	render: function(data) {
		var running = data[2] && data[2].code === 0;
		var deferredLoaded = !!this.deferredDataLoaded;
		var runtime = this.deferredRuntime || data[3] && data[3].stdout || '';
		var runtimeError = this.deferredRuntimeError || data[3] && data[3].stderr || '';
		var socksCandidates = this.deferredSocksCandidates || parseSocksCandidates(data[4] && data[4].stdout ? data[4].stdout : '');
		var dhcpHosts = this.deferredDhcpHosts || parseDhcpHosts(data[5] && data[5].stdout ? data[5].stdout : '');
		var activeClients = asList(uci.get('sockroute', 'main', 'client'));
		var hiddenClients = asList(uci.get('sockroute', 'main', 'hidden_client'));
		var clientCounters = parseClientCounters(runtime);
		var socksProfiles = this.buildSocksProfiles();
		var dnsProfiles = dnsProfilesFromUci();
		var mainSocksRef = uci.get('sockroute', 'main', 'socks_ref') || '';
		var mainDnsRef = uci.get('sockroute', 'main', 'dns_ref') || '';
		var mainSocksProfile = findSocksProfile(socksProfiles, mainSocksRef);
		var listenPort = uci.get('sockroute', 'main', 'listen_port') || '1042';
		var defaultDnsServer = uci.get('sockroute', 'main', 'default_dns_server') || ('udp://' + (uci.get('sockroute', 'main', 'realip_dns_addr') || '1.1.1.1'));
		var socksHost = mainSocksProfile ? mainSocksProfile.host : uci.get('sockroute', 'main', 'socks_host') || uci.get('sockroute', 'main', 'passwall_socks_host') || '127.0.0.1';
		var socksPort = mainSocksProfile ? mainSocksProfile.port : uci.get('sockroute', 'main', 'socks_port') || uci.get('sockroute', 'main', 'passwall_socks_port') || '1080';
		var clients = this.buildClients(activeClients, hiddenClients, socksProfiles, clientCounters);
		var nftSet = uci.get('sockroute', 'main', 'nft_set') || 'sockroute_clients';
		var backend = uci.get('sockroute_api', 'main', 'backend') || 'sockroute';
		var allowedSources = asList(uci.get('sockroute_api', 'main', 'allowed_source_ip'));
		var targetCidr = uci.get('sockroute_api', 'main', 'allowed_target_cidr') || '192.168.1.0/24';
		var apiToken = uci.get('sockroute_api', 'main', 'token') || '';
		var autoApply = uci.get('sockroute', 'main', 'auto_apply') !== '0';
		var checkLoop = uci.get('sockroute', 'main', 'check_loop') === '1';
		var socksCheckInterval = intervalSeconds(uci.get('sockroute', 'main', 'socks_check_interval'), 30);
		var dnsCheckInterval = intervalSeconds(uci.get('sockroute', 'main', 'dns_check_interval'), 30);
		var root = apiRoot();
		var self = this;
		var pendingClientCount = this.pendingClientChangeCount();
		var socksStatus = mainSocksProfile ? mainSocksProfile.lastCheck || 'unknown' : 'unknown';
		var socksDetail = (mainSocksProfile ? mainSocksProfile.label + ' / ' : '') + socksHost + ':' + socksPort;
		var socksAggregate = aggregateProfilesStatus(socksProfiles, 'SOCKS');
		var dnsAggregate = aggregateProfilesStatus(dnsProfiles, 'DNS');
		var statusCards;
		var knownClientIps = {};
		var profileUsage = {};
		var socksWarnings = {};
		var socksLabels = {};
		var currentSocksCandidate = null;
		this.socksCandidates = socksCandidates;
		this.socksProfiles = socksProfiles;
		this.dnsProfiles = dnsProfiles;
		this.defaultSocksHost = socksHost;
		this.defaultSocksPort = socksPort;
		this.defaultSocksRef = mainSocksRef;
		this.autoApply = autoApply;
		if (mainSocksProfile && mainSocksProfile.lastCheckDetail)
			socksDetail += ' / ' + mainSocksProfile.lastCheckDetail;
		statusCards = [
			{ key: 'socks', label: 'SOCKS', status: socksAggregate.status, detail: socksAggregate.detail },
			{ key: 'dns', label: 'DNS', status: dnsAggregate.status, detail: dnsAggregate.detail },
			{ key: 'runtime', label: 'Runtime', status: running ? 'ok' : 'warn', detail: 'порт ' + listenPort + ' / IP ?/%s'.format(activeClients.length) },
			{ key: 'api', label: 'API', status: allowedSources.length ? 'ok' : 'warn', detail: allowedSources.length ? allowedSources.join(', ') + (apiToken ? ' / token' : '') : 'нет разрешённых IP' }
		];
		var clientTable = [
			E('tr', stripedHeaderAttrs(), [
				E('th', {}, [ 'Название' ]),
				E('th', {}, [ 'IP' ]),
				E('th', {}, [ 'Состояние' ]),
				E('th', {}, [ 'Источник' ]),
			E('th', {}, [ 'Исходящие SOCKS' ]),
				E('th', {}, [ 'DNS' ]),
				E('th', {}, [ 'Трафик' ]),
				E('th', {}, [ '' ])
			])
		].concat(clients.map(this.clientRow.bind(this)));
		clients.forEach(function(client) {
			var ref = client.socksRef || (!client.socksHost && !client.socksPort ? mainSocksRef : '');
			if (ref) {
				if (!profileUsage[ref])
					profileUsage[ref] = usageData();

				profileUsage[ref].clients++;
				profileUsage[ref].packets += Number(client.packets) || 0;
				profileUsage[ref].bytes += Number(client.bytes) || 0;
			}
		});
		var socksCandidateOptions = [
			E('option', { 'value': '' }, [ 'Выбрать найденный SOCKS...' ])
		].concat(socksCandidates.map(function(candidate) {
			var value = rawSocksValue(candidate.host, candidate.port);
			var endpointValue = '%s:%s'.format(candidate.host, candidate.port);
			var badge = socksCandidateBadge(candidate);
			var text = '%s:%s - [%s] %s'.format(candidate.host, candidate.port, badge, candidate.label);
			if (candidate.source)
				text += ' [%s]'.format(candidate.source);

			socksWarnings[value] = socksCandidateWarning(candidate);
			socksLabels[value] = candidate.label || '%s:%s'.format(candidate.host, candidate.port);
			socksWarnings[endpointValue] = socksWarnings[value];
			socksLabels[endpointValue] = socksLabels[value];
			return E('option', { 'value': value }, [ text ]);
		}));
		var socksProfileRows = [
			E('tr', stripedHeaderAttrs(), [
				E('th', { 'style': 'width:11em;' }, [ 'Название' ]),
				E('th', { 'style': 'width:12em;' }, [ 'Endpoint' ]),
				E('th', { 'style': 'width:6em;' }, [ 'Проверка' ]),
				E('th', { 'style': 'width:10em;' }, [ 'Внешний IP' ]),
				E('th', {}, [ 'Использование' ]),
				E('th', { 'style': 'width:23em;' }, [ '' ])
			])
		].concat(socksProfiles.map(function(profile, index) {
			var isDefault = profile.section === mainSocksRef;
			var check = profile.lastCheck || 'unknown';
			var usage = profileUsage[profile.section] || usageData();
			var usageDisplay = usageText(usage);
			var usageTitleBase = isDefault
				? 'Глобальный SOCKS по умолчанию. Счётчик включает клиентов без индивидуального override и клиентов, где профиль выбран явно.'
				: 'Счётчик включает клиентов, где этот SOCKS profile выбран явно.';
			var rowKey = domId(profile.section);
			var defaultButtonAttrs = {
				'class': 'btn cbi-button-apply',
				'click': ui.createHandlerFn(self, 'handleSaveSocksRef', profile.section)
			};
			if (isDefault)
				defaultButtonAttrs.disabled = 'disabled';

			return E('tr', stripedRowAttrs(index), [
				E('td', { 'style': 'max-width:11em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;' }, [
					isDefault ? E('span', { 'class': 'ifacebadge' }, [ 'default' ]) : '',
					isDefault ? ' ' : '',
					profile.label
				]),
				E('td', { 'style': 'white-space:nowrap;' }, [ E('code', {}, [ '%s:%s'.format(profile.host, profile.port) ]) ]),
				E('td', {
					'id': 'sockroute-socks-status-%s'.format(rowKey),
					'title': socksProfileCheckTitle(profile)
				}, [ statusBadge(check) ]),
				E('td', {
					'id': 'sockroute-socks-ident-%s'.format(rowKey),
					'title': 'Проверка ident.me запустится после загрузки страницы',
					'style': 'white-space:nowrap;'
				}, [ 'ожидает' ]),
				E('td', {
					'id': 'sockroute-socks-usage-%s'.format(rowKey),
					'data-sockroute-socks-usage': '1',
					'data-section': profile.section,
					'data-title-base': usageTitleBase,
					'title': usageTitle(usageTitleBase, usage),
					'style': 'max-width:26em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;'
				}, [ usageDisplay ]),
				E('td', {
					'class': 'right',
					'style': 'white-space:nowrap; min-width:23em;'
				}, [
					E('button', defaultButtonAttrs, [ 'По умолчанию' ]),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': ui.createHandlerFn(self, 'handleTestSocksProfile', profile)
					}, [ 'Проверить' ]),
					' ',
					E('button', {
						'class': 'btn cbi-button-edit',
						'click': ui.createHandlerFn(self, 'handleEditSocksProfile', profile, socksCandidates)
					}, [ 'Edit' ]),
					' ',
					E('button', {
						'class': 'btn cbi-button-negative',
						'click': ui.createHandlerFn(self, 'handleDeleteSocksProfile', profile)
					}, [ 'Удалить' ])
				])
			]);
		}));
		var dnsProfileRows = [
			E('tr', stripedHeaderAttrs(), [
				E('th', { 'style': 'width:12em;' }, [ 'Название' ]),
				E('th', {}, [ 'Server' ]),
				E('th', { 'style': 'width:6em;' }, [ 'Проверка' ]),
				E('th', {}, [ 'Детали' ]),
				E('th', { 'style': 'width:23em;' }, [ '' ])
			])
		].concat(dnsProfiles.map(function(profile, index) {
			var isDefault = profile.section === mainDnsRef || (!mainDnsRef && profile.server === defaultDnsServer);
			var defaultButtonAttrs = {
				'class': 'btn cbi-button-apply',
				'click': ui.createHandlerFn(self, 'handleSaveDnsRef', profile.section)
			};
			var rowKey = domId(profile.section);
			if (isDefault)
				defaultButtonAttrs.disabled = 'disabled';

			return E('tr', stripedRowAttrs(index), [
				E('td', { 'style': 'max-width:12em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;' }, [
					isDefault ? E('span', { 'class': 'ifacebadge' }, [ 'default' ]) : '',
					isDefault ? ' ' : '',
					profile.label
				]),
				E('td', { 'style': 'white-space:nowrap;' }, [ E('code', {}, [ profile.server ]) ]),
				E('td', {
					'id': 'sockroute-dns-status-%s'.format(rowKey),
					'title': dnsProfileCheckTitle(profile)
				}, [ statusBadge(profile.lastCheck || 'unknown') ]),
				E('td', {
					'id': 'sockroute-dns-detail-%s'.format(rowKey),
					'title': dnsProfileCheckTitle(profile),
					'style': 'max-width:26em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;'
				}, [ profile.lastCheckDetail || 'не проверялся' ]),
				E('td', {
					'class': 'right',
					'style': 'white-space:nowrap; min-width:23em;'
				}, [
					E('button', defaultButtonAttrs, [ 'По умолчанию' ]),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': ui.createHandlerFn(self, 'handleTestDnsProfile', profile)
					}, [ 'Проверить' ]),
					' ',
					E('button', {
						'class': 'btn cbi-button-edit',
						'click': ui.createHandlerFn(self, 'handleEditDnsProfile', profile)
					}, [ 'Edit' ]),
					' ',
					E('button', {
						'class': 'btn cbi-button-negative',
						'click': ui.createHandlerFn(self, 'handleDeleteDnsProfile', profile)
					}, [ 'Удалить' ])
				])
			]);
		}));
		var dhcpRows;

		clients.forEach(function(client) {
			knownClientIps[client.ip] = true;
		});

		dhcpRows = [
			E('tr', stripedHeaderAttrs(), [
				E('th', {}, [ '' ]),
				E('th', {}, [ 'Название' ]),
				E('th', {}, [ 'IP' ]),
				E('th', {}, [ 'MAC' ]),
				E('th', {}, [ 'Статус' ])
			])
		].concat(dhcpHosts.map(function(lease, index) {
			var known = !!knownClientIps[lease.ip];
			var checkboxAttrs = {
				'type': 'checkbox',
				'name': 'sockroute-dhcp-import',
				'data-ip': lease.ip,
				'data-label': lease.label || lease.ip
			};
			if (known)
				checkboxAttrs.disabled = 'disabled';
			return E('tr', stripedRowAttrs(index), [
				E('td', {}, [
					E('input', checkboxAttrs)
				]),
				E('td', {}, [ lease.label || lease.section || lease.ip ]),
				E('td', {}, [ lease.ip ]),
				E('td', {}, [ lease.mac || '-' ]),
				E('td', {}, [ known ? E('span', { 'class': 'ifacebadge' }, [ 'уже есть' ]) : E('span', { 'class': 'ifacebadge inactive' }, [ 'новый' ]) ])
			]);
		}));
		var dhcpOptions = [
			E('option', { 'value': '' }, [ 'Выбрать DHCP lease...' ])
		].concat(dhcpHosts.map(function(lease) {
			var label = lease.label || lease.section || lease.ip;
			var text = '%s - %s%s'.format(lease.ip, label, lease.mac ? ' / ' + lease.mac : '');
			return E('option', { 'value': lease.ip + '|' + label }, [ text ]);
		}));

		if (typeof(window) !== 'undefined') {
			scheduleBackgroundChecks(socksProfiles, dnsProfiles, clients, socksCheckInterval, dnsCheckInterval, checkLoop, activeClients.length);
			scheduleDeferredDataLoad(this);
		}

		return E('div', { 'id': 'sockroute-root', 'class': 'cbi-map' }, [
				E('h2', {}, [ 'SockRoute' ]),
				E('div', { 'class': 'right', 'style': 'margin:8px 0 12px;' }, [
					E('button', {
						'class': running ? 'btn cbi-button-reset' : 'btn cbi-button-apply',
						'click': ui.createHandlerFn(this, 'handleService', running ? 'stop' : 'start')
					}, [ running ? 'Остановить' : 'Запустить' ]),
					' ',
					E('button', {
						'class': 'btn cbi-button-reload',
						'click': ui.createHandlerFn(this, 'handleService', 'restart')
					}, [ 'Перезапустить' ]),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': ui.createHandlerFn(this, 'handleDiagnostics')
					}, [ 'Диагностика' ]),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': ui.createHandlerFn(this, 'handleSettingsModal', {
							allowedSources: allowedSources,
							targetCidr: targetCidr,
							apiToken: apiToken,
							autoApply: autoApply,
							checkLoop: checkLoop,
							socksCheckInterval: socksCheckInterval,
							dnsCheckInterval: dnsCheckInterval,
							clients: clients,
							socksProfiles: socksProfiles,
							apiRoot: root,
							runtime: runtime,
							runtimeError: runtimeError,
							deferredLoaded: deferredLoaded
						})
					}, [ 'Настройки' ]),
					!autoApply ? ' ' : '',
					!autoApply && pendingClientCount ? E('span', {
						'id': 'sockroute-pending-client-count',
						'style': 'margin-right:8px;'
					}, [ 'Ожидают сохранения: %d'.format(pendingClientCount) ]) : '',
					!autoApply ? E('button', {
						'id': 'sockroute-save-pending-clients',
						'class': 'btn cbi-button-save important',
						'disabled': pendingClientCount ? null : 'disabled',
						'click': ui.createHandlerFn(this, 'handleSavePendingClientChanges')
					}, [ 'Сохранить' ]) : ''
				]),

				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, [ 'Статус' ]),
					E('div', { 'class': running ? 'alert-message success' : 'alert-message warning' }, [
						running ? 'Сервис запущен.' : 'Сервис остановлен.'
					]),
					buildStatusSummary(statusCards)
				]),

				E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ 'Исходящие SOCKS' ]),
				socksProfiles.length ? E('div', { 'style': 'max-height: 320px; overflow:auto; margin-bottom:12px;' }, [
					E('table', dataTableAttrs('cbi-section-table'), socksProfileRows)
				]) : E('p', {}, [ E('em', {}, [ 'Сохранённых SOCKS профилей пока нет.' ]) ]),
				E('div', { 'class': 'right' }, [
					!deferredLoaded ? E('em', { 'style': 'margin-right:8px;' }, [ 'SOCKS endpoint загружаются...' ]) : '',
					E('button', {
						'class': 'btn cbi-button-add',
						'disabled': !deferredLoaded ? 'disabled' : null,
						'click': ui.createHandlerFn(this, 'handleAddSocksProfileModal', socksCandidates, socksHost, socksPort, socksWarnings, socksLabels)
					}, [ 'Добавить' ])
				])
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ 'DNS профили' ]),
				dnsProfiles.length ? E('div', { 'style': 'max-height:320px; overflow:auto; margin-bottom:12px;' }, [
					E('table', dataTableAttrs('cbi-section-table'), dnsProfileRows)
				]) : E('p', {}, [ E('em', {}, [ 'DNS профилей пока нет.' ]) ]),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn cbi-button-add',
						'click': ui.createHandlerFn(this, 'handleEditDnsProfile', null)
					}, [ 'Добавить' ])
				])
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ 'Клиенты' ]),
				E('table', dataTableAttrs('cbi-section-table'), clientTable),
				E('div', { 'class': 'right', 'style': 'margin-top:8px;' }, [
					!deferredLoaded ? E('em', { 'style': 'margin-right:8px;' }, [ 'DHCP host-записи загружаются...' ]) : '',
					E('button', {
						'class': 'btn cbi-button-add',
						'click': ui.createHandlerFn(this, 'handleAddClientModal', deferredLoaded, dhcpHosts, dhcpOptions, dhcpRows)
					}, [ 'Добавить' ])
				])
			]),

			''
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
