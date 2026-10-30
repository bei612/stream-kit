// Exercise the real gateway HTTP boundary on an isolated loopback listener.
// No Sunshine launch, microphone capture, system device or live service changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve(__dirname, '..');
const binary = path.resolve(process.argv[2] || '');
assert.ok(process.argv[2] && fs.statSync(binary).isFile(), 'Pass the newly built gateway executable');
const output = path.join(root, 'artifacts/media-contract', `${process.platform}-${process.arch}`);
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, status: 'running', at: new Date().toISOString() }));
const fixture = fs.mkdtempSync(path.join(output, 'run-'));
const configPath = path.join(fixture, 'config.json');
const secret = crypto.randomBytes(32).toString('hex');
const env = { ...process.env, WEBRTC_ICE_SERVER_COUNT: '0' };
for (const name of ['SSL_CERTIFICATE', 'SSL_PRIVATE_KEY', 'FORWARDED_HEADER']) delete env[name];
const sign = (domain, body) => crypto.createHmac('sha256', secret).update(domain).update(body).digest('hex');
const mediaTicket = (overrides = {}) => {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'MEDIA' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ purpose: 'stream-media', session_id: 'session-test',
    connection_id: 'client-a', host_id: 2636897928, app_id: 609885969, role: 'viewer',
    iat: now, exp: now + 60, ...overrides })).toString('base64url');
  const input = `${header}.${claims}`;
  return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
};

async function main() {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const config = JSON.parse(execFileSync(binary, ['--config-path', configPath, 'config', 'print'], { env, windowsHide: true, encoding: 'utf8' }));
  config.web_server = { ...config.web_server, bind_address: `127.0.0.1:${port}`, url_path_prefix: '/gateway', certificate: null,
    first_login_create_admin: false, media_ticket_secret: secret, control_plane_url: `http://127.0.0.1:${port}` };
  config.data_storage.path = path.join(fixture, 'data.json');
  config.webrtc.ice_servers = [];
  config.local_audio_targets = [];
  fs.writeFileSync(configPath, JSON.stringify(config));
  const child = spawn(binary, ['--config-path', configPath, '--bind-address', `127.0.0.1:${port}`, '--path-prefix', '/gateway', 'run'], {
    cwd: fixture, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = fs.createWriteStream(path.join(fixture, 'gateway.log'));
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const exited = once(child, 'exit');
  const endpoint = `http://127.0.0.1:${port}/gateway/internal/v3/media-state`;
  const post = async (state, valid = true) => {
    const body = JSON.stringify(state);
    return fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-stream-state-signature': valid ? sign('stream-kit/media-state/v3\n', body) : '0'.repeat(64) }, body, signal: AbortSignal.timeout(2000) });
  };
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw new Error('Gateway exited before readiness');
      try { ready = (await fetch(`http://127.0.0.1:${port}/gateway/config.js`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, 'Gateway readiness timeout');
    const inventoryURL = `http://127.0.0.1:${port}/gateway/internal/v1/audio-devices`;
    const inventoryRequest = { schema_version: 1, request_id: crypto.randomBytes(16).toString('hex'), issued_at_ms: Date.now() };
    const inventoryPost = (request, domain = 'stream-kit/audio-devices/request/v1\n') => {
      const body = JSON.stringify(request);
      return fetch(inventoryURL, { method: 'POST', body, headers: { 'content-type': 'application/json',
        'x-stream-control-signature': sign(domain, body) }, signal: AbortSignal.timeout(5000) });
    };
    assert.equal((await fetch(inventoryURL, {method:'POST',body:'{}'})).status, 401);
    assert.equal((await inventoryPost(inventoryRequest, 'stream-kit/media-state/v3\n')).status, 401);
    assert.equal((await inventoryPost({...inventoryRequest, issued_at_ms:Date.now()-6000})).status, 400);
    // Headless CI may have no audio server. Check that the HTTP boundary reports
    // the same native availability as the CLI; never turn that into empty success.
    const nativeInventory = spawnSync(binary, ['--config-path', configPath, 'audio-devices'], {
      env, windowsHide:true, encoding:'utf8', timeout:5000,
    });
    assert.ok(!nativeInventory.error && [0,1].includes(nativeInventory.status), 'Native inventory probe failed to run');
    inventoryRequest.issued_at_ms = Date.now();
    const inventoryResponse = await inventoryPost(inventoryRequest);
    assert.equal(inventoryResponse.status, nativeInventory.status === 0 ? 200 : 503);
    if (process.argv[3]) assert.equal(inventoryResponse.status, 200, 'Full browser acceptance requires an available native audio context');
    if (inventoryResponse.ok) {
      assert.equal(inventoryResponse.headers.get('cache-control'), 'no-store');
      const inventoryBody = await inventoryResponse.text();
      assert.equal(inventoryResponse.headers.get('x-stream-control-signature'), sign('stream-kit/audio-devices/response/v1\n', inventoryBody));
      const inventory = JSON.parse(inventoryBody);
      assert.equal(inventory.schema_version, 1);
      assert.equal(inventory.request_id, inventoryRequest.request_id);
      assert.equal(inventory.request_issued_at_ms, inventoryRequest.issued_at_ms);
      assert.ok(Array.isArray(inventory.devices));
      assert.equal(new Set(inventory.devices.map(device => device.id)).size, inventory.devices.length);
      assert.deepEqual(inventory.configured_routes, config.local_audio_targets);
    }
    const configurationURL = `http://127.0.0.1:${port}/gateway/internal/v1/configuration`;
    const configurationRequest = async (operation, extra = {}, domain = 'stream-kit/gateway-configuration/request/v1\n') => {
      const request = {schema_version:1,request_id:crypto.randomBytes(16).toString('hex'),issued_at_ms:Date.now(),operation,...extra};
      const body = JSON.stringify(request);
      const response = await fetch(configurationURL, {method:'POST',headers:{'Content-Type':'application/json','x-stream-control-signature':sign(domain,body)},body,signal:AbortSignal.timeout(3000)});
      const raw = await response.text();
      if (response.headers.has('x-stream-control-signature')) {
        assert.equal(response.headers.get('x-stream-control-signature'),sign('stream-kit/gateway-configuration/response/v1\n',raw));
        const decoded = JSON.parse(raw);
        assert.equal(decoded.request_id,request.request_id);
        assert.equal(decoded.request_issued_at_ms,request.issued_at_ms);
        assert.ok(!raw.includes(secret),'Native configuration response disclosed trust secret');
        return {status:response.status,result:decoded.result};
      }
      return {status:response.status};
    };
    assert.equal((await fetch(configurationURL,{method:'POST',body:'{}'})).status,401);
    assert.equal((await configurationRequest('read',{},'stream-kit/audio-devices/request/v1\n')).status,401);
    assert.equal((await configurationRequest('read',{issued_at_ms:Date.now()-10000})).status,400);
    const beforeSettings = await configurationRequest('read');
    assert.equal(beforeSettings.status,200);
    assert.equal(beforeSettings.result.data.restart_required,false);
    assert.equal(beforeSettings.result.data.values.web_server.media_ticket_secret,null);
    const revision = beforeSettings.result.data.revision;
    const changed = await configurationRequest('save',{revision,changes:{'/moonlight/pair_device_name':'Unified native settings'}});
    assert.equal(changed.status,200);
    assert.equal(changed.result.data.restart_required,true);
    assert.equal(changed.result.data.apply_policy,'gateway_restart');
    assert.equal(JSON.parse(fs.readFileSync(configPath,'utf8')).web_server.media_ticket_secret,secret);
    assert.equal((await configurationRequest('save',{revision,changes:{'/moonlight/pair_device_name':'stale'}})).status,409);
    const savedFile = fs.readFileSync(configPath,'utf8');
    assert.equal((await configurationRequest('save',{revision:changed.result.data.revision,changes:{'/webrtc/port_range':{min:90,max:80}}})).status,400);
    assert.equal(fs.readFileSync(configPath,'utf8'),savedFile);
    const replacementSecret = crypto.randomBytes(32).toString('hex');
    const rotation = await configurationRequest('save',{revision:changed.result.data.revision,changes:{'/web_server/media_ticket_secret':replacementSecret}});
    assert.equal(rotation.status,200);
    assert.ok(!JSON.stringify(rotation).includes(replacementSecret));
    assert.equal(JSON.parse(fs.readFileSync(configPath,'utf8')).web_server.media_ticket_secret,replacementSecret);
    assert.equal((await configurationRequest('read')).status,200,'Pending trust setting must not change the running gateway');
    const state = JSON.parse(fs.readFileSync(path.join(root, 'contracts/media-state/v3.fixture.json'), 'utf8'));
    state.issued_at_ms = Date.now(); state.expires_at_ms = state.issued_at_ms + 10000;
    for (const connection of state.sessions[0].connections) connection.expires_at_ms = state.expires_at_ms;
    assert.equal((await post(state, false)).status, 401);
    const response = await post(state);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const raw = await response.text();
    assert.equal(response.headers.get('x-stream-observation-signature'), sign('stream-kit/media-observation/v2\n', raw));
    const ack = JSON.parse(raw);
    assert.equal(ack.schema_version, 2);
    assert.equal(ack.state_issued_at_ms, state.issued_at_ms);
    assert.equal(ack.sessions[0].session_id, state.sessions[0].session_id);
    assert.equal(ack.sessions[0].revision, 7);
    assert.equal(ack.sessions[0].upstream_active, false);
    assert.equal(ack.sessions[0].subscribers, 0);
    assert.deepEqual(ack.sessions[0].microphone_target, { epoch:3, state: 'idle', device: null, error:null });
    const bindingsResponse = await inventoryPost({...inventoryRequest, issued_at_ms:Date.now()});
    assert.equal(bindingsResponse.status,200);
    assert.deepEqual((await bindingsResponse.json()).configured_routes,[{host_id:state.sessions[0].host_id,app_id:state.sessions[0].app_id,
      endpoint:{render_device_id:state.sessions[0].audio.target.render_device_id,capture_device_id:state.sessions[0].audio.target.capture_device_id}}]);
    const api = `http://127.0.0.1:${port}/gateway/api`;
    const viewerRequest = (resource, token, method = 'GET') => fetch(`${api}${resource}`, {
      method, headers: token ? { 'X-Stream-Media-Ticket': token } : {}, signal: AbortSignal.timeout(2000),
    });
    const viewerToken = mediaTicket();
    const profileResponse = await viewerRequest('/host/stream/profile', viewerToken);
    assert.equal(profileResponse.status, 200, 'Viewing admission must not require a gateway account');
    assert.equal(profileResponse.headers.get('cache-control'), 'no-store');
    const profile = await profileResponse.json();
    assert.equal(profile.permissions.allow_add_hosts, false);
    assert.equal(profile.permissions.allow_transport_websockets, false);
    assert.equal(profile.permissions.allow_transport_webrtc, true);
    assert.ok(!('user' in profile) && !('ty' in profile), 'Profile is not a gateway identity');
    assert.equal((await viewerRequest('/host/stream/webrtc', viewerToken, 'OPTIONS')).status, 200);
    assert.equal((await viewerRequest('/authenticate', viewerToken)).status, 401, 'Media capability cannot authenticate a gateway account');
    assert.equal((await viewerRequest('/host/stream/profile')).status, 401);
    assert.equal((await viewerRequest('/authenticate')).status, 401);
    for (const claims of [
      { session_id: 'other-session' }, { connection_id: 'unknown' }, { app_id: 42 },
      { exp: Math.floor(Date.now() / 1000) },
    ]) {
      assert.equal((await viewerRequest('/host/stream/profile', mediaTicket(claims))).status, 401, 'Invalid scoped admission');
    }
    assert.equal((await post(state)).status, 400, 'Replay must fail');
    for (const mutate of [
      s => { s.schema_version = 1; },
      s => { s.sessions[0].control_epoch = 0; },
      s => { s.sessions[0].control_epoch--; },
      s => { s.sessions[0].controller_connection_id = 'client-b'; },
    ]) {
      const invalid = structuredClone(state);
      invalid.issued_at_ms++;
      mutate(invalid);
      assert.equal((await post(invalid)).status, 400, 'Invalid ownership generation/schema must fail');
    }
    state.issued_at_ms++; state.sessions[0].revision += 2; state.sessions[0].control_epoch += 2;
    const transferred = await post(state);
    assert.equal(transferred.status, 200, 'Coalesced A B A must accept the newer generation');
    assert.equal((await transferred.json()).sessions[0].revision, 9);
    state.issued_at_ms++; state.sessions = [];
    const revoked = await post(state);
    assert.equal(revoked.status, 200);
    assert.deepEqual((await revoked.json()).sessions, []);
    assert.equal((await viewerRequest('/host/stream/profile', viewerToken)).status, 401, 'Revocation invalidates an unexpired ticket');
    const managementInventory = process.argv[3] ? await require('./accept-audio-inventory.cjs')({
      root, binary: process.argv[3], gatewayURL: `http://127.0.0.1:${port}/gateway`, secret, output,
      configuredRoutes: config.local_audio_targets,
    }) : undefined;
    const result = { passed: true, platform: process.platform, architecture: process.arch, at: new Date().toISOString(), gateway_sha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
      audio_inventory_status: inventoryResponse.status,
      checks: [inventoryResponse.ok ? 'signed audio inventory with nonce and configured routes' : 'native audio backend unavailable reported as HTTP 503', 'inventory rejects unsigned/wrong-domain/stale requests', 'signed HTTP acknowledgement', 'request/revision binding', 'unsigned rejection', 'replay rejection', 'configured idle target', 'v1 rejection', 'invalid/rollback epoch rejection', 'coalesced ownership transfer', 'revocation',
        'account-free viewer profile and WHEP configuration', 'media capability cannot authenticate gateway account', 'anonymous denial', 'session/connection/application/expiry admission scope', 'revocation invalidates unexpired admission',
        'signed native configuration read/save with redaction and request binding', 'configuration rejects unsigned/wrong-domain/stale requests', 'configuration version conflict and invalid edit preserve file', 'pending native trust configuration does not alter runtime'],
      management_inventory: managementInventory,
      scope: 'Isolated real gateway HTTP contract; no active media or target recording.' };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    log.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
