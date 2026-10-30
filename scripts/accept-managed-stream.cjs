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
const { startAudioProbe } = require('./lib/audio-probe.cjs');
const root = path.resolve(__dirname, '..');
const argument = name => {
  const index = process.argv.indexOf(name);
  assert.ok(index > 0 && process.argv[index + 1], `Required argument: ${name}`);
  return path.resolve(process.argv[index + 1]);
};
const gatewayBinary = argument('--gateway');
const orchestratorBinary = argument('--orchestrator');
const runtimeConfig = argument('--runtime-config');
const applicationExample = process.argv.includes('--example') ? argument('--example') : null;
const exampleOutput = process.argv.includes('--example-output') ? process.argv[process.argv.indexOf('--example-output') + 1] : null;
assert.ok(!applicationExample || exampleOutput, 'Application acceptance requires an explicit example output device');
const numericOption = (name, fallback) => process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : fallback;
const clientCount = numericOption('--clients', 2);
const holdSeconds = numericOption('--hold-seconds', 5);
const expireClientLease = process.argv.includes('--expire-client-lease');
const programToneCount = Math.min(28800, Math.max(20, Math.ceil((clientCount*60+holdSeconds+30)/3)));
const microphoneTest = process.argv.includes('--microphone-tone');
const endpointOption = name => {
  if (!process.argv.includes(name)) return null;
  const value = process.argv[process.argv.indexOf(name)+1];
  assert.ok(value && !value.startsWith('--'), `Required endpoint ID: ${name}`);
  return value;
};
const targetRender = endpointOption('--target-render-device');
const targetCapture = endpointOption('--target-capture-device');
const targetProbe = process.argv.includes('--audio-probe') ? argument('--audio-probe') : null;
const targetRecording = !!(targetRender || targetCapture || targetProbe);
assert.ok(!targetRecording || (targetRender && targetCapture && targetProbe && microphoneTest), 'Target recording requires both explicit endpoint IDs, --audio-probe and --microphone-tone');
const deleteActive = process.argv.includes('--delete-active');
const stopActive = process.argv.includes('--stop-active') || deleteActive;
assert.ok(!stopActive || applicationExample, 'Active native stop acceptance requires the owned example');
const microphoneFrequency = applicationExample ? 1499 : 997;
const targetSwitch = process.argv.includes('--target-switch');
assert.ok(!(targetRecording && targetSwitch), 'Run local recording and disabled/upstream switching as separate acceptance cases');
assert.ok(!targetSwitch || microphoneTest, 'Target mode switching acceptance requires the microphone tone case');
const restartServices = process.argv.includes('--restart-services');
assert.ok(!restartServices || !microphoneTest, 'Run recovery and microphone isolation as separate acceptance cases');
assert.ok(!microphoneTest || clientCount === 2, 'Microphone isolation acceptance uses two clients');
assert.ok(Number.isInteger(clientCount) && clientCount >= 2 && clientCount <= 20);
assert.ok(Number.isInteger(holdSeconds) && holdSeconds >= 0 && holdSeconds <= 86400);
const scratch = process.argv.includes('--scratch') ? argument('--scratch') : path.join(root, '.local/managed-acceptance');
const output = process.argv.includes('--output-dir') ? argument('--output-dir') : path.join(root, 'artifacts/managed-acceptance', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(scratch, { recursive: true });
fs.mkdirSync(output, { recursive: true });
const result = { passed: false, status: 'running', clients: clientCount, hold_seconds: holdSeconds,
  started_at: new Date().toISOString(), scope: microphoneTest
    ? 'Real browser capture of a generated 997 Hz WAV via Chromium test microphone, Opus uplink/mix/downlink and control revocation; no physical microphone or target recording.'
    : restartServices ? 'Real browser recovery across forced termination/restart of the isolated gateway and control processes; same ports/data, no page reload or host input. Not a network partition or long outage test.'
    : 'Real browser Desktop streams through isolated control and media services; no host input or microphone capture.' };
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
if (applicationExample) {
  result.scope = 'Source-built application capture through native Sunshine, shared gateway and real browsers, including program tone and scoped stop. No physical microphone, target recording or Linux capture claim.';
  result.program_tone_count = programToneCount;
}
if (targetRecording) result.scope = 'Real browser test microphone uplink, shared broadcast and explicit target input recording with authorization/revocation checks requested; completion is recorded separately. No UE5, physical microphone or Linux capture claim.';
save();
const children = [];
let browser;
let cleanupRenderer;
let audioProbe;
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
  const record = { child, exited: once(child, 'exit'), expectedExit: false };
  children.push(record);
  return record;
}
async function stopProcess(record) {
  record.expectedExit = true;
  if (record.child.exitCode === null) record.child.kill();
  await record.exited;
}
async function ready(url) {
  for (let i = 0; i < 100; i++) {
    assert.ok(children.every(({ child, expectedExit }) => expectedExit || child.exitCode === null), 'Test process exited during startup');
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
async function measureReceivedTone(page, frequency = 997) {
  return page.evaluate(async frequency => {
    if (!window.__toneProbe) {
      const audioTrack = window.__acceptancePeers.flatMap(pc => pc.getReceivers()).find(r => r.track.kind === 'audio').track;
      const context = new AudioContext(); await context.resume();
      const source = context.createMediaStreamSource(new MediaStream([audioTrack]));
      const analyser = context.createAnalyser(); analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0;
      const mute = context.createGain(); mute.gain.value = 0;
      source.connect(analyser); analyser.connect(mute); mute.connect(context.destination);
      window.__toneProbe = { context, source, analyser, mute };
    }
    const { analyser, context } = window.__toneProbe;
    const bins = new Float32Array(analyser.frequencyBinCount);
    const index = Math.round(frequency * analyser.fftSize / context.sampleRate), values = [];
    for (let i = 0; i < 16; i++) {
      analyser.getFloatFrequencyData(bins);
      values.push(Math.max(-140, ...bins.slice(index - 2, index + 3)));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    values.sort((a,b) => a-b); return values[Math.floor(values.length / 2)];
  }, frequency);
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
  result.web_assets_sha256 = Object.fromEntries(fs.readdirSync(path.join(scratch, 'dist'))
    .filter(name => /\.(js|wasm|html)$/.test(name)).map(name => [name, sha(path.join(scratch, 'dist', name))]));
  const controlConfig = { server: { bind_address: `127.0.0.1:${controlPort}`, ...credentials,
    jwt_secret: crypto.randomBytes(32).toString('hex'), media_ticket_secret: secret, cors_origins: [gateway] },
    components: {}, moonlight_web: { base_url: gateway, public_url: gateway, ...credentials },
    storage: { apps_dir: './apps', temp_dir: './temp', db_path: './control.db', max_upload_size_bytes: 10485760,
      max_extract_size_bytes: 10485760, max_file_count: 1000 },
    process: { monitor_interval_seconds: 2, graceful_shutdown_timeout_seconds: 2 },
    log: { level: 'info', file: { enabled: false }, access_log: { enabled: false } } };
  const controlConfigFile = path.join(scratch, 'control', 'config.json');
  fs.mkdirSync(path.dirname(controlConfigFile),{recursive:true});
  if(process.argv.includes('--edit-gateway-configuration')) {
    fs.cpSync(path.join(root,'orchestrator/web/dist'),path.join(scratch,'control/dist'),{recursive:true});
    result.management_assets_sha256=Object.fromEntries(fs.readdirSync(path.join(scratch,'control/dist/assets')).map(name=>[name,sha(path.join(scratch,'control/dist/assets',name))]));
  }
  if (applicationExample) controlConfig.sunshine_api = sun;
  fs.writeFileSync(controlConfigFile, JSON.stringify(controlConfig));
  let gatewayProcess = launch(gatewayBinary, ['--config-path', gatewayConfigFile, 'run'], 'gateway');
  const controlProcess = launch(orchestratorBinary, ['--config', controlConfigFile], 'orchestrator');
  await ready(gateway + '/config.js');
  await ready(control + '/api/v1/health');
  async function gatewayLogin() {
    const response = await fetch(gateway + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: credentials.username, password: credentials.password }) });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  let cookie = await gatewayLogin();
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
  const signIn = () => json(control + '/api/v1/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  let login = await signIn();
  const api = async (resource, method = 'GET', body) => {
    const expires = Date.parse(login.data.expires_at);
    assert.ok(Number.isFinite(expires),'Administrator login must declare its expiry');
    // Renew the test operator before expiry without replaying any mutation.
    if(expires-Date.now()<60000)login=await signIn();
    return json(control + '/api/v1' + resource, { method,
      headers: { Authorization: 'Bearer ' + login.data.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(r => r.data);
  };
  let ownedApp;
  if (applicationExample) {
    assert.ok(!exampleOutput.includes('"') && !/[\r\n]/.test(exampleOutput), 'Invalid output device name');
    ownedApp = await api('/apps/local', 'POST', { name: 'Source capture acceptance', exe_path: applicationExample,
      capture_mode: 'application', args: `"--tone-output=${exampleOutput}" --tone-count=${programToneCount}` });
    assert.equal(ownedApp.status, 'ready');
    assert.ok(ownedApp.sunshine_app_id > 0);
    result.application = { id: ownedApp.id, native_id: ownedApp.sunshine_app_id, capture_mode: ownedApp.capture_mode, example_sha256: sha(applicationExample) };
  }
  const desktop = (await native(`/apps?host_id=${host.host_id}`)).apps.find(app => ownedApp ? app.app_id === ownedApp.sunshine_app_id : app.title === 'Desktop');
  assert.ok(desktop, 'The selected native application must be visible in the gateway');
  cleanupRenderer = async () => {
    const finalInfo = await (await fetch(infoURL, { signal: AbortSignal.timeout(3000) })).text();
    if (/<currentgame>0<\/currentgame>/.test(finalInfo)) { result.sunshine_restored_idle = true; return; }
    // The run began idle and selected only this application's native identity.
    // Refuse to cancel if another rendering application has since been selected.
    assert.match(finalInfo, new RegExp(`<currentgame>${desktop.app_id}</currentgame>`));
    if (ownedApp) {
      const active = await sunshine('/api/stream-kit/runtime');
      assert.equal(active.app_id, ownedApp.id);
      await api(`/apps/${ownedApp.id}/stop`, 'POST');
      result.scoped_stop = { app_id: active.app_id, instance_id: active.instance_id, acknowledged: true };
    } else await native('/host/cancel', 'POST', { host_id: host.host_id });
    for (let i = 0; i < 30; i++) {
      const restored = await (await fetch(infoURL, { signal: AbortSignal.timeout(3000) })).text();
      if (/<currentgame>0<\/currentgame>/.test(restored)) { result.sunshine_restored_idle = true; return; }
      await delay(200);
    }
    throw new Error('Sunshine did not return to its initial idle state');
  };
  const invite = await api('/stream-invitations', 'POST', { host_id: host.host_id, app_id: desktop.app_id });
  if (targetRecording) {
    audioProbe=startAudioProbe(targetProbe);
    const catalog=await audioProbe.command('devices');
    assert.ok(!catalog.error && catalog.data.devices.some(d=>d.id===targetCapture&&d.input), 'Explicit target capture endpoint is unavailable');
    assert.ok(catalog.data.devices.some(d=>d.id===targetRender&&d.output), 'Explicit target render endpoint is unavailable');
    const session=await api(`/stream-sessions/${invite.session_id}`);
    await api(`/stream-sessions/${invite.session_id}/audio-target`,'PATCH',{
      expected_epoch:session.audio.target.epoch,target:{mode:'local',render_device_id:targetRender,capture_device_id:targetCapture}
    });
    result.target_recording={render_device_id:targetRender,capture_device_id:targetCapture,probe_sha256:sha(targetProbe),measurements:{},passed:false};
  }
  if (microphoneTest) await api(`/stream-sessions/${invite.session_id}/audio`, 'PATCH', {
    program_gain_db: applicationExample ? 0 : -60, microphone_gain_db: 0, microphone_enabled: true,
    broadcast_controller_microphone: true, controller_monitor: false,
  });
  const { chromium } = createRequire(path.join(root, 'third_party/moonlight-web-stream/package.json'))('playwright');
  const browserArgs = ['--autoplay-policy=no-user-gesture-required'];
  if (microphoneTest) {
    const rate = 48000, samples = rate * 10;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(0.2 * 32767 * Math.sin(2 * Math.PI * microphoneFrequency * i / rate)), 44 + i * 2);
    const toneFile = path.join(scratch, `microphone-${microphoneFrequency}hz.wav`);
    fs.writeFileSync(toneFile, wav);
    browserArgs.push('--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${toneFile}`);
  }
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome', args: browserArgs });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  if (microphoneTest) await context.grantPermissions(['microphone'], { origin: gateway });
  await context.addInitScript(({ microphoneTest }) => {
    localStorage.setItem('mlSettings', JSON.stringify({ videoSize: '720p', fps: 30, bitrate: 8000, videoCodec: 'h264',
      dataTransport: 'webrtc', forceVideoElementRenderer: true, canvasRenderer: false, playAudioLocal: false,
      microphone: microphoneTest, enterFullscreenOnStreamStart: false, language: 'en' }));
    window.__acceptancePeers = [];
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Original { constructor(...args) { super(...args); window.__acceptancePeers.push(this); } };
  }, { microphoneTest });
  const pages = [];
  const pageErrors = [];
  const videoFrames = page => page.evaluate(() => document.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames || 0);
  for (let i = 0; i < clientCount; i++) {
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${gateway}/stream.html?hostId=${host.host_id}&appId=${desktop.app_id}#join=${invite.invitation}`);
    try {
      await page.waitForFunction(() => { const video = document.querySelector('video'); return video && video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 15; }, null, { timeout: 60000 });
    } catch(error) {
      result.startup_failure = {client:i+1,diagnostics:await page.evaluate(async()=>{
        const video=document.querySelector('video');
        const peers=await Promise.all(window.__acceptancePeers.map(async peer=>{
          const stats=[...(await peer.getStats()).values()];
          return {state:peer.connectionState,ice:peer.iceConnectionState,
            inbound:stats.filter(s=>s.type==='inbound-rtp').map(s=>({kind:s.kind,codecId:s.codecId,packetsReceived:s.packetsReceived,bytesReceived:s.bytesReceived,framesReceived:s.framesReceived,framesDecoded:s.framesDecoded,keyFramesDecoded:s.keyFramesDecoded,pliCount:s.pliCount,firCount:s.firCount})),
            codecs:stats.filter(s=>s.type==='codec').map(s=>({id:s.id,mimeType:s.mimeType,sdpFmtpLine:s.sdpFmtpLine}))};
        }));
        return {video:video?{readyState:video.readyState,width:video.videoWidth,frames:video.getVideoPlaybackQuality().totalVideoFrames,error:video.error?.code}:null,peers};
      }).catch(()=>({unavailable:true}))};
      throw error;
    }
    assert.equal(await page.locator('#ml-api-name').count(), 0);
    console.log(`Viewer ${i + 1}/${clientCount} is decoding`);
  }
  if (applicationExample) {
    result.program_audio_db = await Promise.all(pages.map(page => measureReceivedTone(page)));
    const picture = await pages[0].evaluate(() => {
      const video = document.querySelector('video'), canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    fs.writeFileSync(path.join(output, 'application-frame.png'), Buffer.from(picture, 'base64'));
    assert.ok(result.program_audio_db.every(level => level > -65), 'Every viewer must receive the example process-tree 997 Hz tone');
    if(!microphoneTest)await Promise.all(pages.map(page=>page.evaluate(()=>window.__toneProbe.context.close())));
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
  if (process.argv.includes('--edit-gateway-configuration')) {
    const before = await api('/gateway-configuration');
    assert.equal(before.apply_policy,'gateway_restart');
    assert.equal(before.restart_required,false);
    assert.equal(before.values.web_server.media_ticket_secret,null);
    const adminPage=await context.newPage();
    adminPage.on('pageerror',error=>pageErrors.push(error.message));
    await adminPage.goto(control+'/login');
    await adminPage.getByLabel('用户名',{exact:true}).fill(credentials.username);
    await adminPage.getByLabel('密码',{exact:true}).fill(credentials.password);
    await adminPage.getByRole('button',{name:'登录控制台',exact:true}).click();
    await adminPage.getByRole('heading',{name:'工作台',exact:true}).waitFor();
    await adminPage.locator('nav a[href="/settings"]').click();
    await adminPage.locator('summary').filter({hasText:'渲染主机连接'}).click();
    await adminPage.getByLabel('配对设备名称',{exact:true}).fill('Stream Kit managed acceptance');
    await adminPage.getByRole('button',{name:'保存网关配置',exact:true}).click();
    await adminPage.getByText('网关配置已保存，重启网关后生效。当前串流继续使用原配置。',{exact:true}).waitFor();
    let saved = await api('/gateway-configuration');
    assert.equal(saved.restart_required,true);
    assert.equal(saved.values.moonlight.pair_device_name,'Stream Kit managed acceptance');
    await adminPage.locator('summary').filter({hasText:'网络与 WebRTC'}).click();
    await adminPage.getByLabel('媒体 UDP 端口范围',{exact:true}).selectOption('enabled');
    await adminPage.getByLabel('起始端口',{exact:true}).fill('60000');
    await adminPage.getByLabel('结束端口',{exact:true}).fill('60100');
    await adminPage.getByRole('button',{name:'保存网关配置',exact:true}).click();
    await adminPage.getByText('网关配置已保存，重启网关后生效。当前串流继续使用原配置。',{exact:true}).waitFor();
    saved = await api('/gateway-configuration');
    assert.deepEqual(saved.values.webrtc.port_range,{min:60000,max:60100});
    assert.notEqual(saved.revision,before.revision);
    assert.equal((await api('/gateway-configuration')).revision,saved.revision);
    const stale = await fetch(control+'/api/v1/gateway-configuration',{method:'PATCH',headers:{Authorization:'Bearer '+login.data.token,'Content-Type':'application/json'},
      body:JSON.stringify({revision:before.revision,changes:{'/moonlight/pair_device_name':'stale'}})});
    assert.equal(stale.status,409);
    await adminPage.screenshot({path:path.join(output,'gateway-settings.png'),fullPage:true});
    await adminPage.close();
    result.gateway_configuration = {passed:true,apply_policy:saved.apply_policy,saved_revision:saved.revision,restart_required:true,conflict_rejected:true,browser_form:true,
      scope:'Production administrator form through signed native file operation during active media; no gateway restart.'};
  }
  if (restartServices) {
    const selected = await api(`/stream-sessions/${invite.session_id}/controller/${ids[0]}`, 'POST');
    const peerCounts = await Promise.all(pages.map(page => page.evaluate(() => window.__acceptancePeers.length)));
    const started = Date.now();
    // Terminate only the isolated child owned by this acceptance run. Restart
    // from the same config/data on the same port, without reloading browsers.
    await stopProcess(gatewayProcess);
    gatewayProcess = launch(gatewayBinary, ['--config-path', gatewayConfigFile, 'run'], 'gateway-restarted');
    await ready(gateway + '/config.js');
    cookie = await gatewayLogin();
    await Promise.all(pages.map((page,index) => page.waitForFunction(async count => {
      const peers = window.__acceptancePeers;
      if(peers.length <= count) return false;
      const peer = peers.at(-1);
      if(peer.connectionState !== 'connected') return false;
      return [...(await peer.getStats()).values()].some(s => s.type === 'inbound-rtp' && s.kind === 'video' && s.framesDecoded > 15);
    }, peerCounts[index], { timeout: 90000 })));
    let restartedStatus;
    for(let i=0;i<100;i++) {
      restartedStatus = await api('/media-control');
      if(restartedStatus.observations_valid && restartedStatus.observations[invite.session_id]?.subscribers === clientCount) break;
      await delay(200);
    }
    result.gateway_restart_observation = restartedStatus;
    assert.ok(restartedStatus.observations_valid && restartedStatus.observations[invite.session_id]?.subscribers === clientCount, 'Restarted gateway must confirm the recovered subscribers');
    const recovered = await api(`/stream-sessions/${invite.session_id}`);
    assert.deepEqual(Object.keys(recovered.connections).sort(), [...ids].sort(), 'Gateway recovery must retain logical connections');
    assert.equal(recovered.controller_connection_id, selected.controller_connection_id);
    assert.equal(recovered.control_epoch, selected.control_epoch);
    result.gateway_restart = { recovered_ms: Date.now()-started, retained_connections:true, retained_control_epoch:true };
    if (result.gateway_configuration) {
      const applied = await api('/gateway-configuration');
      assert.equal(applied.running_revision,result.gateway_configuration.saved_revision);
      assert.equal(applied.restart_required,false);
      const candidates = await Promise.all(pages.map(page=>page.evaluate(async()=>{
        const stats=await window.__acceptancePeers.at(-1).getStats();
        const transport=[...stats.values()].find(item=>item.type==='transport'&&item.selectedCandidatePairId);
        const pair=transport?stats.get(transport.selectedCandidatePairId):[...stats.values()].find(item=>item.type==='candidate-pair'&&item.state==='succeeded'&&item.nominated);
        return pair ? stats.get(pair.remoteCandidateId) : null;
      })));
      result.gateway_restart.remote_candidates=candidates;
      const ports=candidates.map(candidate=>candidate?.port);
      for(const port of ports) assert.ok(Number.isInteger(port)&&port>=60000&&port<=60100,'Recovered media must use the configured UDP range');
      result.gateway_restart.applied_revision=applied.running_revision;
      result.gateway_restart.remote_udp_ports=ports;
    }
    console.log('Gateway restart recovered without page reload');
    const beforeControl = await Promise.all(pages.map(videoFrames));
    await stopProcess(controlProcess);
    launch(orchestratorBinary, ['--config', controlConfigFile], 'orchestrator-restarted');
    await ready(control + '/api/v1/health');
    await delay(6000); // Observe the next existing browser heartbeat and state publication.
    const restored = await api(`/stream-sessions/${invite.session_id}`);
    assert.deepEqual(Object.keys(restored.connections).sort(), [...ids].sort(), 'Control restart must restore persisted connections');
    assert.equal(restored.controller_connection_id, selected.controller_connection_id);
    assert.equal(restored.control_epoch, selected.control_epoch);
    const status = await api('/media-control');
    result.control_restart_observation = status;
    assert.ok(status.observations_valid && status.observations[invite.session_id]?.subscribers === clientCount);
    for(let i=0;i<pages.length;i++) assert.ok(await videoFrames(pages[i]) > beforeControl[i]+15, 'Video must continue across control restart');
    result.control_restart = { restored_connections:true, retained_control_epoch:true, video_continued:true };
    await api(`/stream-sessions/${invite.session_id}/controller`, 'DELETE');
    console.log('Control restart retained session and unique controller');
  }
  if (microphoneTest) {
    const measure = page => measureReceivedTone(page, microphoneFrequency);
    const recordTarget = async phase => {
      if(!audioProbe)return null;
      const started=await audioProbe.command('capture',{device_id:targetCapture});
      assert.ok(!started.error,`Target recording could not start: ${started.error}`);
      await delay(2200);
      const stopped=await audioProbe.command('stop');
      assert.ok(!stopped.error && !stopped.data.error && stopped.data.captured_frames>=48000,'Target recording failed or did not capture one second of PCM');
      assert.ok(stopped.data.dropped_frames<stopped.data.captured_frames/100,'Target recording dropped more than 1% of frames');
      const microphone=await audioProbe.command('analyze',{frequency_hz:microphoneFrequency});
      const program=applicationExample?await audioProbe.command('analyze',{frequency_hz:997}):null;
      assert.ok(!microphone.error && !program?.error,'Target PCM analysis failed');
      const measurement={capture:stopped.data,microphone:microphone.data,program:program?.data};
      result.target_recording.measurements[phase]=measurement;save();
      return measurement;
    };
    const startMicrophone = async page => {
      await page.waitForFunction(() => !!window.app.getStream().getMicrophoneListener());
      await page.waitForFunction(() => window.app.getStream().mediaAccess.role === 'controller');
      await page.evaluate(() => window.app.getStream().getMicrophoneListener().onUserInteraction());
      await page.waitForFunction(() => window.app.getStream().getMicrophoneListener().isLive());
    };
    const connectionId = page => page.evaluate(() => window.app.getStream().mediaAccess.connectionId);
    const [speaker, listener] = await Promise.all(pages.map(connectionId));
    const levels = { frequency_hz: microphoneFrequency };
    await pages[0].waitForFunction(() => !!window.app.getStream().getMicrophoneListener());
    await pages[0].evaluate(() => window.app.getStream().getMicrophoneListener().onUserInteraction());
    assert.equal(await pages[0].evaluate(() => window.app.getStream().getMicrophoneListener().isLive()), false,
      'A viewer gesture must not start the product microphone');
    // Deliberately adversarial peer: bypass only the client-side UI guard to
    // prove the server rejects an unauthorized, genuine browser audio track.
    await pages[0].evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = stream.getAudioTracks()[0];
      const sender = window.__acceptancePeers.flatMap(pc => pc.getTransceivers()).find(t => t.direction === 'sendonly').sender;
      window.__hostileMicrophone = { stream, sender };
      await sender.replaceTrack(track);
    });
    await delay(2000);
    levels.viewer_denied_db = await measure(pages[1]);
    const deniedTarget=await recordTarget('viewer_denied');
    if(deniedTarget)assert.ok(deniedTarget.microphone.peak_amplitude<0.003,'Unauthorized microphone reached target input');
    await pages[0].evaluate(async () => {
      window.__hostileMicrophone.stream.getTracks().forEach(track => track.stop());
      await window.__hostileMicrophone.sender.replaceTrack(null);
    });
    const active = await api(`/stream-sessions/${invite.session_id}/controller/${speaker}`, 'POST');
    await startMicrophone(pages[0]);
    await delay(2000);
    levels.controller_broadcast_db = await measure(pages[1]);
    const receivedTarget=await recordTarget('controller');
    if(receivedTarget) {
      assert.ok(receivedTarget.microphone.mean_amplitude>0.01,'Client microphone missing from target recording');
      if(receivedTarget.program)assert.ok(receivedTarget.program.peak_amplitude<0.003,'Program output leaked into microphone target');
    }
    assert.ok(levels.controller_broadcast_db > -55 && levels.controller_broadcast_db > levels.viewer_denied_db + 20,
      `Authorized microphone tone missing: ${JSON.stringify(levels)}`);
    if (applicationExample) {
      levels.simultaneous_program_db = await Promise.all(pages.map(page => measureReceivedTone(page, 997)));
      assert.ok(levels.simultaneous_program_db.every(level => level > -65), 'Program audio must reach both viewers while microphone broadcasting');
    }
    if (targetSwitch) {
      const before = await Promise.all(pages.map(videoFrames));
      const observations = [];
      for (const mode of ['disabled','upstream']) {
        const latest=await api(`/stream-sessions/${invite.session_id}`);
        const saved=await api(`/stream-sessions/${invite.session_id}/audio-target`,'PATCH',{
          expected_epoch:latest.audio.target.epoch,target:{mode,render_device_id:'',capture_device_id:''},
        });
        let applied;
        for(let i=0;i<40;i++) {
          const state=await api('/media-control');
          const observed=state.observations?.[invite.session_id];
          if(state.observations_valid && observed?.microphone_target.epoch===saved.audio.target.epoch &&
            (mode==='disabled' ? observed.microphone_target.state==='disabled' : ['unconfigured','upstream_transport'].includes(observed.microphone_target.state))) { applied=observed;break; }
          await delay(100);
        }
        assert.ok(applied,`Target mode ${mode} did not settle`);
        assert.equal(applied.subscribers,clientCount);
        const level=await measure(pages[1]);
        assert.ok(level>-55,`Target mode ${mode} interrupted microphone broadcast`);
        observations.push({mode,epoch:saved.audio.target.epoch,state:applied.microphone_target.state,broadcast_db:level});
      }
      for(let i=0;i<pages.length;i++) assert.ok(await videoFrames(pages[i])>before[i]+15,'Target change interrupted video');
      result.target_mode_switch={observations,video_continued:true,scope:'Live disabled/upstream target selection; local virtual endpoint recording is not exercised.'};
      console.log('Live audio target mode switching preserved video and controller microphone broadcast');
    }
    await api(`/stream-sessions/${invite.session_id}/controller/${listener}`, 'PUT', {
      expected_controller_connection_id: speaker, expected_control_epoch: active.control_epoch,
    });
    await delay(2000);
    levels.previous_controller_denied_db = await measure(pages[1]);
    const transferredTarget=await recordTarget('previous_controller_denied');
    if(transferredTarget)assert.ok(transferredTarget.microphone.peak_amplitude<0.003,'Previous controller microphone survived transfer to target');
    assert.ok(levels.previous_controller_denied_db < levels.controller_broadcast_db - 20,
      `Previous controller microphone survived transfer: ${JSON.stringify(levels)}`);
    await pages[0].waitForFunction(() => !window.app.getStream().getMicrophoneListener().isLive(), null, { timeout: 10000 });
    await startMicrophone(pages[1]);
    await delay(2000);
    levels.new_controller_broadcast_db = await measure(pages[0]);
    const newControllerTarget=await recordTarget('new_controller');
    if(newControllerTarget)assert.ok(newControllerTarget.microphone.mean_amplitude>0.01,'New controller microphone missing from target recording');
    assert.ok(levels.new_controller_broadcast_db > -55, 'New controller microphone must broadcast');
    await api(`/stream-sessions/${invite.session_id}/controller`, 'DELETE');
    await delay(2000);
    levels.released_db = await measure(pages[0]);
    const releasedTarget=await recordTarget('released');
    if(releasedTarget) {
      assert.ok(releasedTarget.microphone.peak_amplitude<0.003,'Revoked microphone remained in target recording');
      result.target_recording.passed=true;
      result.scope+=' Target input PCM verified with explicit endpoints and controller revocation; no UE5 or physical microphone claim.';
    }
    assert.ok(levels.released_db < levels.new_controller_broadcast_db - 20, 'Released microphone must be inaudible');
    await pages[1].waitForFunction(() => !window.app.getStream().getMicrophoneListener().isLive(), null, { timeout: 10000 });
    result.microphone_tone = levels;
    result.microphone_capture_released_on_revocation = true;
    for (const page of pages) await page.evaluate(() => window.__toneProbe.context.close());
  }
  if (expireClientLease) {
    const page = pages[0];
    const connectionId = await page.evaluate(() => window.app.getStream().mediaAccess.connectionId);
    await api(`/stream-sessions/${invite.session_id}/controller/${connectionId}`, 'POST');
    let peerCount;
    const route = `${control}/**`;
    const abort = request => request.abort('internetdisconnected');
    await page.route(route, abort);
    const started = Date.now();
    let expired;
    try {
      for (let attempt = 0; attempt < 35; attempt++) {
        expired = await api(`/stream-sessions/${invite.session_id}`);
        if (!expired.connections[connectionId]) break;
        await delay(1000);
      }
      assert.ok(!expired.connections[connectionId], 'HTTP outage must expire the client lease');
      assert.ok(!expired.controller_connection_id, 'Expiry must revoke controller authority');
      assert.equal(Object.keys(expired.connections).length, clientCount - 1);
      let applied;
      for (let attempt = 0; attempt < 30; attempt++) {
        const status = await api('/media-control');
        applied = status.observations_valid && status.observations?.[invite.session_id];
        if (applied && applied.subscribers === clientCount - 1) break;
        await delay(200);
      }
      assert.equal(applied?.subscribers, clientCount - 1, 'Gateway must apply expired membership before restoring HTTP');
      peerCount = await page.evaluate(() => window.__acceptancePeers.length);
    } finally { await page.unroute(route, abort); }
    let recovered;
    for (let attempt = 0; attempt < 45; attempt++) {
      recovered = await api(`/stream-sessions/${invite.session_id}`);
      if (recovered.connections[connectionId]) break;
      await delay(1000);
    }
    assert.equal(Object.keys(recovered.connections).length, clientCount, 'Heartbeat must restore authoritative membership');
    let restoredMedia;
    for (let attempt = 0; attempt < 90; attempt++) {
      const browserMedia = await page.evaluate(async () => {
        const peers = window.__acceptancePeers, peer = peers.at(-1);
        const stats = [...(await peer.getStats()).values()];
        return { peers:peers.length, state:peer.connectionState,
          frames:stats.find(s => s.type === 'inbound-rtp' && s.kind === 'video')?.framesDecoded || 0 };
      });
      const status = await api('/media-control');
      restoredMedia = { ...browserMedia, prior_peers:peerCount, subscribers:status.observations?.[invite.session_id]?.subscribers,
        observations_valid:status.observations_valid };
      if (restoredMedia.peers > peerCount && restoredMedia.state === 'connected' && restoredMedia.frames > 15 &&
          restoredMedia.observations_valid && restoredMedia.subscribers === clientCount) break;
      await delay(1000);
    }
    assert.ok(restoredMedia.peers > peerCount && restoredMedia.state === 'connected' && restoredMedia.frames > 15 &&
      restoredMedia.observations_valid && restoredMedia.subscribers === clientCount, `Media did not recover: ${JSON.stringify(restoredMedia)}`);
    assert.equal(recovered.connections[connectionId].role, 'viewer');
    assert.ok(!recovered.controller_connection_id);
    assert.ok(!recovered.connections[connectionId].microphone_live);
    assert.equal(await page.evaluate(() => window.app.getStream().mediaAccess.connectionId), connectionId);
    result.expired_lease_recovery = { passed:true, connection_id:connectionId, elapsed_ms:Date.now()-started, media:restoredMedia,
      scope:'One browser HTTP control-plane outage until lease expiry, followed by new decoded media without reload; not a UDP or system network outage.' };
    save();
    console.log('Expired client lease recovered as viewer without restoring controller authority');
  }
  const firstFrames = await Promise.all(pages.map(videoFrames));
  const mediaSnapshot = () => Promise.all(pages.map(page => page.evaluate(async () => {
    const peer = window.__acceptancePeers.at(-1);
    const stats = [...(await peer.getStats()).values()];
    const video = stats.find(s => s.type === 'inbound-rtp' && s.kind === 'video');
    const audio = stats.find(s => s.type === 'inbound-rtp' && s.kind === 'audio');
    return { state:peer.connectionState, frames:video?.framesDecoded || 0, audio_packets:audio?.packetsReceived || 0,
      video_packets_lost:video?.packetsLost || 0, audio_packets_lost:audio?.packetsLost || 0,
      video_jitter:video?.jitter || 0, audio_jitter:audio?.jitter || 0 };
  })));
  let previousMedia = await mediaSnapshot();
  const holdStart = performance.now();
  const samplePath = path.join(output, 'continuous-media.jsonl');
  result.continuous_media = {samples:0,elapsed_ms:0,interval_ms:10000,clients:clientCount,passed:false,
    scope:'Periodic current-peer video decode and audio packet progress with signed shared-session observation; not continuous audio quality measurement.'};
  fs.writeFileSync(samplePath, JSON.stringify({elapsed_ms:0,clients:previousMedia})+'\n');
  let previousSampleAt = holdStart;
  while(performance.now()-holdStart < holdSeconds*1000) {
    // Keep the last observation window long enough to contain real RTP/frame
    // progress; scheduling overhead may extend the requested minimum by < 1s.
    await delay(Math.max(1000,Math.min(10000, holdSeconds*1000-(performance.now()-holdStart))));
    const samples = await mediaSnapshot();
    const status = await api('/media-control');
    const shared = status.observations?.[invite.session_id];
    const sampledAt = performance.now();
    const record = {elapsed_ms:Math.round(sampledAt-holdStart),interval_ms:Math.round(sampledAt-previousSampleAt),
      clients:samples,subscribers:shared?.subscribers,upstream_active:shared?.upstream_active,observations_valid:status.observations_valid};
    fs.appendFileSync(samplePath,JSON.stringify(record)+'\n');
    result.continuous_media.samples++;
    result.continuous_media.elapsed_ms=record.elapsed_ms;
    save();
    assert.ok(status.observations_valid && shared?.subscribers===clientCount && shared.upstream_active,'Shared session changed during sustained playback');
    for(let i=0;i<samples.length;i++) {
      assert.equal(samples[i].state,'connected',`Viewer ${i+1} disconnected during sustained playback`);
      assert.ok(samples[i].frames>previousMedia[i].frames,`Viewer ${i+1} stopped decoding during sustained playback`);
      assert.ok(samples[i].audio_packets>previousMedia[i].audio_packets,`Viewer ${i+1} audio transport stalled during sustained playback`);
    }
    previousMedia=samples;previousSampleAt=sampledAt;
    if(result.continuous_media.samples%3===0)console.log(`Sustained playback: ${clientCount} viewers, ${Math.round(record.elapsed_ms/1000)} seconds`);
  }
  result.continuous_media.passed=holdSeconds>0;
  result.frames_before_disconnect = await Promise.all(pages.map(videoFrames));
  if(holdSeconds>0)for (let i = 0; i < clientCount; i++) assert.ok(result.frames_before_disconnect[i] > firstFrames[i], `Viewer ${i + 1} stalled`);
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
  if (stopActive) {
    // The initial invitation can naturally expire during a long hold. Obtain
    // a fresh credential for this same generation so rejection proves revoke.
    const stopInvitation = await api('/stream-invitations','POST',{host_id:host.host_id,app_id:desktop.app_id});
    assert.equal(stopInvitation.session_id,invite.session_id,'Stop verification must use the active generation');
    if (deleteActive) {
      await api(`/apps/${ownedApp.id}?confirm=true`, 'DELETE');
      assert.equal(sha(applicationExample), result.application.example_sha256, 'Deleting a local registration must preserve the external program');
      for (const endpoint of ['/stream-invitations', '/stream-sessions']) {
        const stale = await fetch(control + '/api/v1' + endpoint, {
          method:'POST', headers:{ Authorization:'Bearer '+login.data.token, 'Content-Type':'application/json' },
          body:JSON.stringify({ host_id:host.host_id, app_id:desktop.app_id })
        });
        assert.equal(stale.status, 404, `Deleted application must be rejected by ${endpoint}`);
        assert.equal((await stale.json()).code, 'SESSION_NOT_FOUND');
      }
      result.deleted_application_readmission_rejected = true;
      result.deleted_active_registration = true;
    }
    await cleanupRenderer(); cleanupRenderer = null;
    const stopped = await api(`/stream-sessions/${invite.session_id}`);
    assert.equal(stopped.state, 'stopped');
    assert.deepEqual(stopped.connections, {});
    const oldJoin = await fetch(control + '/api/v1/client-sessions/join', { method:'POST', headers:{ Authorization:'Bearer '+stopInvitation.invitation } });
    assert.equal(oldJoin.status, 400, 'A stopped viewing invitation cannot readmit clients');
    assert.equal((await oldJoin.json()).code, 'SESSION_COMMAND_INVALID');
    for (const page of pages.slice(1)) await page.waitForFunction(() => window.__acceptancePeers.every(pc => pc.connectionState === 'closed'), null, {timeout:15000});
    for (let i=0;i<24;i++) {
      assert.equal((await sunshine('/api/stream-kit/runtime')).gamestream_id, 0, 'Browser reconnect restarted an administratively stopped program');
      await delay(500);
    }
    result.active_stop = { session_terminal:true, old_invitation_rejected:true, browser_transport_closed:true, idle_observation_seconds:12 };
  } else for (const page of pages.slice(1)) await page.evaluate(() => window.app.getStream().stop());
  for (let i = 0; i < 50; i++) {
    const status = await api('/media-control');
    observed = status.observations?.[invite.session_id];
    if (stopActive && status.observations_valid && !observed) break;
    if (status.observations_valid && observed?.subscribers === 0 && !observed.upstream_active) break;
    await delay(200);
  }
  if (stopActive) assert.equal(observed, undefined, 'Stopped generation must be absent from signed gateway authority');
  else {
    assert.equal(observed?.subscribers, 0);
    assert.equal(observed.upstream_active, false);
  }
  // The last media subscription ends its transport; Sunshine deliberately
  // retains the selected app for resume. Explicitly end only this run's app.
  if (cleanupRenderer) await cleanupRenderer();
  cleanupRenderer = null;
  assert.deepEqual(pageErrors, []);
  const upstreamCount = name => (fs.readFileSync(path.join(output, name), 'utf8').match(/: connected control stream\r?\n/g) || []).length;
  result.upstream_connections = upstreamCount('gateway.log');
  assert.equal(result.upstream_connections, 1, 'All viewers must share exactly one Moonlight transport connection');
  if (restartServices) {
    result.restarted_upstream_connections = upstreamCount('gateway-restarted.log');
    assert.equal(result.restarted_upstream_connections, 1, 'Restarted gateway must still share one upstream');
  }
  result.final_observation = observed;
  result.passed = true;
  result.gateway_sha256 = sha(gatewayBinary);
  result.orchestrator_sha256 = sha(orchestratorBinary);
  result.browser = browser.version();
}
main().catch(error => { result.error = error.message; process.exitCode = 1; }).finally(async () => {
  if(audioProbe) {
    try {await audioProbe.close()}
    catch(error){result.target_probe_cleanup_error=error.message;result.passed=false;process.exitCode=1}
  }
  if (browser) {
    try { await browser.close(); }
    catch (error) { result.browser_cleanup_error = error.message; result.passed = false; process.exitCode = 1; }
  }
  if (cleanupRenderer) {
    try { await cleanupRenderer(); }
    catch (error) { result.cleanup_error = error.message; result.passed = false; process.exitCode = 1; }
  }
  for (const record of children.reverse()) await stopProcess(record);
  result.finished_at = new Date().toISOString();
  result.status = result.passed ? 'passed' : 'failed';
  save();
  console.log(JSON.stringify(result));
});
