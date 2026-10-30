// Exercise the real gateway HTTP boundary on an isolated loopback listener.
// No Sunshine launch, microphone capture, system device or live service changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
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
  config.local_audio_targets = [{ host_id: 2636897928, app_id: 609885969,
    endpoint: { render_device_id: 'test-render-not-opened', capture_device_id: 'test-capture-not-opened' } }];
  fs.writeFileSync(configPath, JSON.stringify(config));
  const child = spawn(binary, ['--config-path', configPath, '--bind-address', `127.0.0.1:${port}`, '--path-prefix', '/gateway', 'run'], {
    cwd: fixture, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = fs.createWriteStream(path.join(fixture, 'gateway.log'));
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const exited = once(child, 'exit');
  const endpoint = `http://127.0.0.1:${port}/gateway/internal/v1/media-state`;
  const post = async (state, valid = true) => {
    const body = JSON.stringify(state);
    return fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-stream-state-signature': valid ? sign('stream-kit/media-state/v1\n', body) : '0'.repeat(64) }, body, signal: AbortSignal.timeout(2000) });
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
    const state = JSON.parse(fs.readFileSync(path.join(root, 'contracts/media-state/v1.fixture.json'), 'utf8'));
    state.issued_at_ms = Date.now(); state.expires_at_ms = state.issued_at_ms + 10000;
    for (const connection of state.sessions[0].connections) connection.expires_at_ms = state.expires_at_ms;
    assert.equal((await post(state, false)).status, 401);
    const response = await post(state);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const raw = await response.text();
    assert.equal(response.headers.get('x-stream-observation-signature'), sign('stream-kit/media-observation/v1\n', raw));
    const ack = JSON.parse(raw);
    assert.equal(ack.schema_version, 1);
    assert.equal(ack.state_issued_at_ms, state.issued_at_ms);
    assert.equal(ack.sessions[0].session_id, state.sessions[0].session_id);
    assert.equal(ack.sessions[0].revision, 7);
    assert.equal(ack.sessions[0].upstream_active, false);
    assert.equal(ack.sessions[0].subscribers, 0);
    assert.deepEqual(ack.sessions[0].microphone_target, { state: 'idle', device: null });
    assert.equal((await post(state)).status, 400, 'Replay must fail');
    state.issued_at_ms++; state.sessions = [];
    const revoked = await post(state);
    assert.equal(revoked.status, 200);
    assert.deepEqual((await revoked.json()).sessions, []);
    const result = { passed: true, platform: process.platform, architecture: process.arch, at: new Date().toISOString(), gateway_sha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
      checks: ['signed HTTP acknowledgement', 'request/revision binding', 'unsigned rejection', 'replay rejection', 'configured idle target', 'revocation'],
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
