// Configure Moonlight v2.10's native default user; the management login is unchanged.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.local/runtime');
const configPath = path.join(root, '.local/moonlight/package/server/config.json');
const gateway = 'http://127.0.0.1:8080/api';
const management = 'http://127.0.0.1:9000/api/v1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text();
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${url}: ${response.status} ${body}`);
  return body ? JSON.parse(body) : null;
}

async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.web_server.bind_address, '127.0.0.1:8080', 'Passwordless setup is restricted to the loopback gateway');
  const credentials = JSON.parse(fs.readFileSync(path.join(runtime, 'credentials.json'), 'utf8'));
  const login = await fetch(gateway + '/login', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({name: credentials.username, password: credentials.password})
  });
  assert.equal(login.status, 200, 'Gateway administrator login failed');
  const headers = {'Content-Type': 'application/json', Cookie: login.headers.get('set-cookie').split(';')[0]};
  const api = (endpoint, method = 'GET', data) => request(gateway + endpoint, {
    method, headers, ...(data ? {body: JSON.stringify(data)} : {})
  });
  const managementLogin = await request(management + '/login', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username: credentials.username, password: credentials.password})
  });
  const backup = path.join(runtime, 'moonlight-config-before-passwordless.json');
  if (!fs.existsSync(backup)) fs.copyFileSync(configPath, backup);

  const disable = process.argv.includes('--disable');
  if (disable) {
    config.web_server.default_user_id = null;
  } else {
    const roleName = 'Local streaming';
    let role = (await api('/roles')).roles.find(role => role.name === roleName);
    if (!role) {
      await api('/role', 'POST', {
        name: roleName, ty: 'User', default_settings: null,
        permissions: {
          allow_add_hosts: false, maximum_bitrate_kbps: null,
          allow_codec_h264: true, allow_codec_h265: true, allow_codec_av1: true,
          allow_hdr: true, allow_transport_webrtc: true, allow_transport_websockets: true
        }
      });
      role = (await api('/roles')).roles.find(role => role.name === roleName);
    }
    const roleDetails = await api('/role?id=' + role.id);
    assert.equal((roleDetails.role || roleDetails).ty, 'User', 'Default identity must not be an administrator');
    assert.equal((roleDetails.role || roleDetails).permissions.allow_add_hosts, false);
    let user = (await api('/users')).users.find(user => user.name === 'local-viewer');
    if (!user) {
      await api('/user', 'POST', {
        name: 'local-viewer', password: crypto.randomBytes(32).toString('base64url'),
        role_id: role.id, client_unique_id: 'local-viewer'
      });
      user = (await api('/users')).users.find(user => user.name === 'local-viewer');
    }
    assert.equal(user.role, 'User');
    assert.equal(user.role_id, role.id);
    const {host_id} = JSON.parse(fs.readFileSync(path.join(runtime, 'paired-host.json'), 'utf8'));
    const {host} = await api('/host?host_id=' + host_id);
    assert.equal(host.address, '127.0.0.1');
    assert.equal(host.paired, 'Paired');
    // Global hosts are available to ordinary users without granting host administration.
    await api('/host', 'PATCH', {host_id, change_owner: true, owner: null});
    config.web_server.default_user_id = user.id;
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  await request(management + '/components/web_server/restart', {
    method: 'POST', headers: {Authorization: 'Bearer ' + managementLogin.data.token}
  });
  let status;
  for (let attempt = 0; attempt < 60; attempt++) {
    await delay(500);
    try { status = (await fetch(gateway + '/authenticate')).status; } catch { continue; }
    if (status === (disable ? 401 : 200)) break;
  }
  assert.equal(status, disable ? 401 : 200, 'Gateway authentication did not match the requested configuration');
  if (!disable) {
    const current = await request(gateway + '/user');
    assert.equal(current.name, 'local-viewer');
    assert.equal(current.is_default_user, true);
    assert.equal(current.role, 'User');
    const adminStatus = (await fetch(gateway + '/users')).status;
    assert.ok([401, 403].includes(adminStatus), 'Anonymous visitors must not access user administration');
  }
  console.log(disable ? 'Gateway passwordless access disabled.' : 'Local gateway passwordless access enabled as local-viewer (User).');
}

main().catch(error => {console.error(error); process.exitCode = 1;});
