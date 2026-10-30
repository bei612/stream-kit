// Manual multi-browser acceptance using real Orchestrator, gateway and an idle
// loopback Sunshine. Creates an isolated persistent test pairing and database;
// never replaces live services, existing pairings or system audio devices.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const argument = name => {
  const index = process.argv.indexOf(name);
  assert.ok(index > 0 && process.argv[index + 1], `Required argument: ${name}`);
  return path.resolve(process.argv[index + 1]);
};
const gatewayBinary = argument('--gateway');
const orchestratorBinary = argument('--orchestrator');
const runtimeConfig = argument('--runtime-config');
const numericOption = (name, fallback) => process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : fallback;
const clientCount = numericOption('--clients', 2);
const holdSeconds = numericOption('--hold-seconds', 5);
assert.ok(Number.isInteger(clientCount) && clientCount >= 2 && clientCount <= 20);
assert.ok(Number.isInteger(holdSeconds) && holdSeconds >= 0 && holdSeconds <= 86400);
const scratch = path.join(root, '.local/managed-acceptance');
const output = path.join(root, 'artifacts/managed-acceptance', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(scratch, { recursive: true });
fs.mkdirSync(output, { recursive: true });
const result = { passed: false, status: 'running', clients: clientCount, hold_seconds: holdSeconds,
  started_at: new Date().toISOString(), scope: 'Real browser Desktop streams through isolated control and media services; no host input or microphone capture.' };
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
save();
const children = [];
let browser;
let cleanupRenderer;
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
function launch(binary, args, name) {
  const log = fs.openSync(path.join(output, `${name}.log`), 'w');
  const child = spawn(binary, args, { cwd: scratch, windowsHide: true,
    stdio: ['ignore', log, log], env: { ...process.env, WEBRTC_ICE_SERVER_COUNT: '0' } });
  fs.closeSync(log);
  children.push({ child, exited: once(child, 'exit') });
}
async function ready(url) {
  for (let i = 0; i < 100; i++) {
    assert.ok(children.every(({ child }) => child.exitCode === null), 'Test process exited during startup');
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await delay(100);
  }
  throw new Error(`Readiness failed: ${new URL(url).pathname}`);
}
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok, `${options.method || 'GET'} ${new URL(url).pathname}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function main() {
  const runtime = JSON.parse(fs.readFileSync(runtimeConfig, 'utf8'));
  const sun = runtime.sunshine_api;
  assert.equal(new URL(sun.base_url).hostname, '127.0.0.1', 'Acceptance is restricted to local Sunshine');
  const infoURL = sun.server_info_url || 'http://127.0.0.1:47989/serverinfo';
  assert.equal(new URL(infoURL).hostname, '127.0.0.1');
  const info = await (await fetch(infoURL, { signal: AbortSignal.timeout(3000) })).text();
  assert.match(info, /<state>SUNSHINE_SERVER_FREE<\/state>/, 'Do not interrupt an active Sunshine stream');
  assert.match(info, /<currentgame>0<\/currentgame>/, 'Do not switch an existing rendering application');
  const sunshine = (resource, body, csrf) => new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : JSON.stringify(body);
    const request = https.request(new URL(resource, sun.base_url), {
      rejectUnauthorized: sun.verify_ssl !== false, method: encoded ? 'POST' : 'GET', timeout: 10000,
      headers: { Authorization: 'Basic ' + Buffer.from(`${sun.username}:${sun.password}`).toString('base64'),
        ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`Sunshine ${resource}: ${response.statusCode}`));
        try { resolve(JSON.parse(data)); } catch { reject(new Error(`Invalid Sunshine response: ${resource}`)); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Sunshine request timed out')));
    request.on('error', reject);
    request.end(encoded);
  });
  const credentialsFile = path.join(scratch, 'credentials.json');
  if (!fs.existsSync(credentialsFile)) fs.writeFileSync(credentialsFile, JSON.stringify({
    username: 'acceptance-admin', password: crypto.randomBytes(32).toString('base64url'),
  }));
  const credentials = JSON.parse(fs.readFileSync(credentialsFile));
  const gatewayPort = await port(), controlPort = await port();
  const gateway = `http://127.0.0.1:${gatewayPort}`, control = `http://127.0.0.1:${controlPort}`;
  const secret = crypto.randomBytes(32).toString('hex');
  const gatewayConfigFile = path.join(scratch, 'gateway-config.json');
  const config = JSON.parse(execFileSync(gatewayBinary, ['--config-path', path.join(scratch, 'defaults.json'), 'config', 'print'], { encoding: 'utf8', windowsHide: true }));
  config.web_server = { ...config.web_server, bind_address: `127.0.0.1:${gatewayPort}`, url_path_prefix: '', certificate: null,
    first_login_create_admin: true, session_cookie_secure: false, media_ticket_secret: secret, control_plane_url: control };
  config.data_storage.path = path.join(scratch, 'gateway-data.json');
  config.webrtc.ice_servers = [];
  config.local_audio_targets = [];
  fs.writeFileSync(gatewayConfigFile, JSON.stringify(config));
  fs.cpSync(path.join(root, 'third_party/moonlight-web-stream/dist'), path.join(scratch, 'dist'), { recursive: true });
  fs.cpSync(path.join(root, 'third_party/moonlight-web-stream/dist'), path.join(scratch, 'static'), { recursive: true });
  const controlConfig = { server: { bind_address: `127.0.0.1:${controlPort}`, ...credentials,
    jwt_secret: crypto.randomBytes(32).toString('hex'), media_ticket_secret: secret, cors_origins: [gateway] },
    components: {}, moonlight_web: { base_url: gateway, public_url: gateway, ...credentials },
    storage: { apps_dir: './apps', temp_dir: './temp', db_path: './control.db', max_upload_size_bytes: 10485760 },
    process: { monitor_interval_seconds: 2, graceful_shutdown_timeout_seconds: 2 },
    log: { level: 'info', file: { enabled: false }, access_log: { enabled: false } } };
  const controlConfigFile = path.join(scratch, 'control-config.json');
  fs.writeFileSync(controlConfigFile, JSON.stringify(controlConfig));
  launch(gatewayBinary, ['--config-path', gatewayConfigFile, 'run'], 'gateway');
  launch(orchestratorBinary, ['--config', controlConfigFile], 'orchestrator');
  await ready(gateway + '/config.js');
  await ready(control + '/api/v1/health');
  const nativeLogin = await fetch(gateway + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: credentials.username, password: credentials.password }) });
  assert.equal(nativeLogin.status, 200);
  const cookie = nativeLogin.headers.get('set-cookie').split(';')[0];
  const native = (resource, method = 'GET', body) => json(gateway + '/api' + resource, {
    method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const known = await fetch(gateway + '/api/hosts', { headers: { Cookie: cookie } });
  assert.equal(known.status, 200);
  let host = JSON.parse((await known.text()).split('\n')[0]).hosts[0];
  if (!host) host = (await native('/host', 'POST', { address: '127.0.0.1', http_port: Number(new URL(infoURL).port) })).host;
  if ((await native(`/host?host_id=${host.host_id}`)).host.paired !== 'Paired') {
    const previous = new Set(((await sunshine('/api/pin')).pairings || []).map(p => p.id));
    const csrf = (await sunshine('/api/csrf-token')).csrf_token;
    const pair = await fetch(gateway + '/api/pair', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ host_id: host.host_id }), signal: AbortSignal.timeout(60000) });
    assert.equal(pair.status, 200);
    let pending = '', completed = false;
    const decoder = new TextDecoder();
    for await (const chunk of pair.body) {
      pending += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.Pin) {
          let candidates = [];
          for (let i = 0; i < 200; i++) {
            candidates = ((await sunshine('/api/pin')).pairings || []).filter(p => !previous.has(p.id));
            if (candidates.length) break;
            await delay(150);
          }
          assert.equal(candidates.length, 1, 'Refuse ambiguous pairing requests');
          await sunshine('/api/pin', { pairing_id: candidates[0].id, pin: event.Pin, name: 'StreamKit isolated acceptance' }, csrf);
        }
        if (event.Paired) completed = true;
        assert.ok(event !== 'PairError' && !event.PairError, 'Isolated pairing failed');
      }
    }
    assert.ok(completed, 'Pairing did not complete');
  }
  const desktop = (await native(`/apps?host_id=${host.host_id}`)).apps.find(app => app.title === 'Desktop');
  assert.ok(desktop, 'A Desktop application is required; this test does not edit the Sunshine app catalog');
  cleanupRenderer = async () => {
    const finalInfo = await (await fetch(infoURL, { signal: AbortSignal.timeout(3000) })).text();
    if (/<currentgame>0<\/currentgame>/.test(finalInfo)) { result.sunshine_restored_idle = true; return; }
    // The run began idle, selected only Desktop, and closes its browsers first.
    // Refuse to cancel if another rendering application has since been selected.
    assert.match(finalInfo, new RegExp(`<currentgame>${desktop.app_id}</currentgame>`));
    await native('/host/cancel', 'POST', { host_id: host.host_id });
    for (let i = 0; i < 30; i++) {
      const restored = await (await fetch(infoURL, { signal: AbortSignal.timeout(3000) })).text();
      if (/<currentgame>0<\/currentgame>/.test(restored)) { result.sunshine_restored_idle = true; return; }
      await delay(200);
    }
    throw new Error('Sunshine did not return to its initial idle state');
  };
  const login = await json(control + '/api/v1/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  const api = (resource, method = 'GET', body) => json(control + '/api/v1' + resource, { method,
    headers: { Authorization: 'Bearer ' + login.data.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(r => r.data);
  const invite = await api('/stream-invitations', 'POST', { host_id: host.host_id, app_id: desktop.app_id });
  const { chromium } = createRequire(path.join(root, 'third_party/moonlight-web-stream/package.json'))('playwright');
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    localStorage.setItem('mlSettings', JSON.stringify({ videoSize: '720p', fps: 30, bitrate: 8000, videoCodec: 'h264',
      dataTransport: 'webrtc', forceVideoElementRenderer: true, canvasRenderer: false, playAudioLocal: false,
      microphone: false, enterFullscreenOnStreamStart: false, language: 'en' }));
    window.__acceptancePeers = [];
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Original { constructor(...args) { super(...args); window.__acceptancePeers.push(this); } };
  });
  const pages = [];
  const pageErrors = [];
  const videoFrames = page => page.evaluate(() => document.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames || 0);
  for (let i = 0; i < clientCount; i++) {
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${gateway}/stream.html?hostId=${host.host_id}&appId=${desktop.app_id}#join=${invite.invitation}`);
    await page.waitForFunction(() => { const video = document.querySelector('video'); return video && video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 15; }, null, { timeout: 60000 });
    assert.equal(await page.locator('#ml-api-name').count(), 0);
    console.log(`Viewer ${i + 1}/${clientCount} is decoding`);
  }
  let observed;
  for (let i = 0; i < 30; i++) {
    const status = await api('/media-control');
    observed = status.observations?.[invite.session_id];
    if (status.observations_valid && observed?.subscribers === clientCount && observed.upstream_active) break;
    await delay(200);
  }
  assert.equal(observed?.subscribers, clientCount);
  assert.equal(observed.upstream_active, true);
  result.shared_observation = observed;
  const current = await api(`/stream-sessions/${invite.session_id}`);
  const ids = Object.keys(current.connections);
  assert.equal(ids.length, clientCount);
  const claimed = await api(`/stream-sessions/${invite.session_id}/controller/${ids[0]}`, 'POST');
  const transferred = await api(`/stream-sessions/${invite.session_id}/controller/${ids[1]}`, 'PUT', {
    expected_controller_connection_id: ids[0], expected_control_epoch: claimed.control_epoch,
  });
  assert.equal(transferred.controller_connection_id, ids[1]);
  assert.equal(Object.values(transferred.connections).filter(c => c.role === 'controller').length, 1);
  await api(`/stream-sessions/${invite.session_id}/controller`, 'DELETE');
  result.control_transfer = { unique_controller: true, epoch_before: claimed.control_epoch, epoch_after: transferred.control_epoch };
  const firstFrames = await Promise.all(pages.map(videoFrames));
  await delay(holdSeconds * 1000);
  result.frames_before_disconnect = await Promise.all(pages.map(videoFrames));
  for (let i = 0; i < clientCount; i++) assert.ok(result.frames_before_disconnect[i] > firstFrames[i], `Viewer ${i + 1} stalled`);
  result.inbound_media = await Promise.all(pages.map(page => page.evaluate(async () => {
    const streams = [];
    for (const pc of window.__acceptancePeers) {
      for (const stat of (await pc.getStats()).values()) {
        if (stat.type === 'inbound-rtp') streams.push({ kind: stat.kind, bytes: stat.bytesReceived,
          packets: stat.packetsReceived, lost: stat.packetsLost, jitter: stat.jitter, frames: stat.framesDecoded });
      }
    }
    return streams;
  })));
  for (const streams of result.inbound_media) {
    assert.ok(streams.some(s => s.kind === 'video' && s.frames > 15));
    assert.ok(streams.some(s => s.kind === 'audio' && s.packets > 0), 'Each viewer receives the shared audio track');
  }
  await pages[0].evaluate(() => window.app.getStream().stop());
  await pages[0].close();
  await delay(2500);
  result.remaining_viewer_frames = await videoFrames(pages[1]);
  assert.ok(result.remaining_viewer_frames > result.frames_before_disconnect[1] + 10, 'Remaining viewer must continue decoding after first viewer leaves');
  for (const page of pages.slice(1)) await page.evaluate(() => window.app.getStream().stop());
  for (let i = 0; i < 50; i++) {
    const status = await api('/media-control');
    observed = status.observations?.[invite.session_id];
    if (status.observations_valid && observed?.subscribers === 0 && !observed.upstream_active) break;
    await delay(200);
  }
  assert.equal(observed?.subscribers, 0);
  assert.equal(observed.upstream_active, false);
  // The last media subscription ends its transport; Sunshine deliberately
  // retains the selected app for resume. Explicitly end only this run's Desktop.
  await cleanupRenderer();
  cleanupRenderer = null;
  assert.deepEqual(pageErrors, []);
  result.upstream_connections = (fs.readFileSync(path.join(output, 'gateway.log'), 'utf8').match(/: connected control stream\r?\n/g) || []).length;
  assert.equal(result.upstream_connections, 1, 'All viewers must share exactly one Moonlight transport connection');
  result.final_observation = observed;
  result.passed = true;
  result.gateway_sha256 = sha(gatewayBinary);
  result.orchestrator_sha256 = sha(orchestratorBinary);
  result.browser = browser.version();
}
main().catch(error => { result.error = error.message; process.exitCode = 1; }).finally(async () => {
  if (browser) {
    try { await browser.close(); }
    catch (error) { result.browser_cleanup_error = error.message; result.passed = false; process.exitCode = 1; }
  }
  if (cleanupRenderer) {
    try { await cleanupRenderer(); }
    catch (error) { result.cleanup_error = error.message; result.passed = false; process.exitCode = 1; }
  }
  for (const { child, exited } of children.reverse()) {
    if (child.exitCode === null) child.kill();
    await exited;
  }
  result.finished_at = new Date().toISOString();
  result.status = result.passed ? 'passed' : 'failed';
  save();
  console.log(JSON.stringify(result));
});
