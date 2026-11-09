// Explicitly opted-in acceptance against an installed deployment; no response mocking.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const privateText = new Set();

function redact(value) {
  let text = String(value);
  for (const secret of privateText) if (secret) text = text.split(secret).join('[redacted-private]');
  return text.replace(/((?:key|join|mediaTicket|mediaControlToken)=)[A-Za-z0-9_%.-]+/g, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]');
}
function protectArguments(value) {
  // Privacy only: cover both API text and the editor's quoted, line-separated
  // representation in CLI diagnostics. Actual checks use live API/UI values.
  let quote = '', current = ''; const parts = [];
  for (const ch of value) {
    if (!quote && (ch === '"' || ch === "'")) quote = ch;
    else if (ch === quote) quote = '';
    if (ch === ' ' && !quote) { if (current) parts.push(current); current = ''; }
    else current += ch;
  }
  if (current) parts.push(current);
  for (const text of [value, value.trim(), parts.join('\n')]) if (text) { privateText.add(text); privateText.add(JSON.stringify(text).slice(1,-1)); }
}
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function regular(file) { assert.ok(fs.lstatSync(file).isFile(), 'Configuration inputs must be regular files'); return file; }
function commandArgument(value) {
  // CMD expands percent variables even inside quotes. Never feed it arbitrary code/URLs.
  assert.ok(!/[\x00-\x1f"%&|<>^!]/.test(value), 'Unsupported characters in CLI command path');
  return `"${value}"`;
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 2 || args.length === 3, 'Usage: node scripts/accept-management-live.cjs --config PRIVATE.json [--execute]');
  assert.equal(args[0], '--config');
  assert.ok(args.length === 2 || args[2] === '--execute', 'Only --execute opts in to live operations');
  const configuration = read(regular(path.resolve(args[1])));
  const base = new URL(configuration.base);
  assert.ok(base.protocol === 'https:' && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'base must be an HTTPS origin');
  assert.equal(configuration.owned_example, true, 'An explicitly owned Example application is required');
  assert.match(configuration.example_app_id, /^[a-f0-9-]{36}$/i);
  assert.match(configuration.expected_control_commit, /^[a-f0-9]{40}$/);
  const cli = regular(path.resolve(configuration.playwright_cli));
  const ca = regular(path.resolve(configuration.ca_cert));
  const state = regular(path.resolve(configuration.auth_storage_state));
  const output = path.resolve(configuration.output);
  assert.ok(!fs.existsSync(output), 'Evidence output must be a new directory');
  const parent = fs.realpathSync(path.dirname(output));
  assert.equal(parent.toLowerCase(), path.dirname(output).toLowerCase(), 'Evidence parent must not redirect through a link');
  const storage = read(state);
  const token = storage.origins?.find(origin => origin.origin === base.origin)?.localStorage?.find(item => item.name === 'auth_token')?.value;
  assert.ok(typeof token === 'string' && token.length > 16, 'Storage state must contain this deployment administrator session');
  privateText.add(token);
  if (args[2] !== '--execute') {
    console.log('Configuration validated. No browser, application or service was changed. Add --execute to run live acceptance.');
    return;
  }
  fs.mkdirSync(output, { mode: 0o700 });
  const report = { passed: false, base: base.origin, expected_control_commit: configuration.expected_control_commit,
    example_app_id: configuration.example_app_id, started_at: new Date().toISOString(), operations: 'Only explicitly owned Example; no service or network changes' };
  const api = (route, method = 'GET', payload) => new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const request = https.request(new URL('/api/v1' + route, base), { method, ca: fs.readFileSync(ca), headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : {'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}) }, timeout: 10000 }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; if (body.length > 4 * 1024 * 1024) request.destroy(Error('API response too large')); });
      response.on('end', () => { try { const data = JSON.parse(body); assert.equal(response.statusCode, 200, 'Live API refused request'); assert.equal(data.status, 'ok'); resolve(data.data); } catch { reject(Error('Live API check failed: ' + route)); } });
    });
    request.on('error', () => reject(Error('Trusted HTTPS request failed: ' + route)));
    request.on('timeout', () => request.destroy()); request.end(body);
  });
  const session = `management-live-${Date.now()}`;
  let opened = false, ownsRun = false, argumentSnapshot;
  function cliRun(command, ...values) {
    const parameters = [`-s=${session}`, command, ...values];
    const result = process.platform === 'win32'
      ? cp.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[cli, ...parameters].map(commandArgument).join(' ')}"`], { cwd: output, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 240000, maxBuffer: 8 * 1024 * 1024 })
      : cp.spawnSync(cli, parameters, { cwd: output, encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
    const diagnostic = redact((result.stdout || '') + (result.stderr || ''));
    fs.appendFileSync(path.join(output, 'cli.log'), diagnostic + '\n', { mode: 0o600 });
    assert.equal(result.status, 0, `playwright-cli ${command} failed; inspect sanitized cli.log`);
    assert.ok(!/"isError"\s*:\s*true|### Error\b/.test(diagnostic), `playwright-cli ${command} reported an error`);
    return diagnostic;
  }
  try {
    const health = await api('/health');
    assert.equal(health.commit, configuration.expected_control_commit, 'Installed control source differs from requested acceptance');
    const apps = await api('/apps');
    const example = apps.find(app => app.id === configuration.example_app_id);
    assert.ok(example, 'Owned Example is not registered');
    assert.ok(typeof example.args === 'string', 'Owned Example has no argument state');
    protectArguments(example.args);
    assert.ok(['stopped', 'ready'].includes(example.status), 'Owned Example must be idle before acceptance');
    assert.ok(!apps.some(app => app.id !== example.id && ['running', 'starting', 'stopping'].includes(app.status)), 'Another application is active');
    const identity = new URL(example.stream_url, base);
    const host = Number(identity.searchParams.get('hostId')), app = Number(identity.searchParams.get('appId'));
    assert.ok(host > 0 && app > 0 && app === example.sunshine_app_id, 'Owned Example has no consistent streaming identity');
    argumentSnapshot = { hostId:host, nativeAppId:app, original:example.args, template:example.args_template || '', candidate:example.args==='--tone-count=1'?'--tone-count=2':'--tone-count=1' };
    const sessions = await api('/stream-sessions');
    assert.ok(!sessions.some(s => s.host_id === host && s.app_id === app && Object.values(s.connections).some(c => c.state === 'connected' && Date.parse(c.expires_at) > Date.now())), 'Example already has viewers');
    report.preflight = { control_commit: health.commit, app_status: example.status, other_active_apps: 0 };
    const browserConfig = path.join(output, 'cli.config.json');
    fs.writeFileSync(browserConfig, JSON.stringify({ browser: { browserName: 'chromium', launchOptions: { channel: 'chrome' }, contextOptions: { ignoreHTTPSErrors: false, storageState: state, viewport: { width: 1440, height: 1000 } } }, outputDir: output }), { mode: 0o600 });
    cliRun('open', 'about:blank', '--config', browserConfig); opened = true;
    const script = path.join(output, 'live-browser.js');
    const browserOptions = { base: base.origin, appId: example.id, name: example.name, host, app, output,
      originalArgsSHA256:crypto.createHash('sha256').update(example.args).digest('hex'), candidateArgs:argumentSnapshot.candidate };
    fs.writeFileSync(script, `async (page) => { const cfg = ${JSON.stringify(browserOptions)}; return await (${browserAcceptance.toString()})(page, cfg); }`, { mode: 0o600 });
    ownsRun = true;
    const result = cliRun('run-code', '--filename', script);
    assert.ok(result.includes('LIVE_MANAGEMENT_ACCEPTANCE_OK'), 'Live browser checks did not finish successfully');
    const stopped = await api('/apps/' + example.id);
    assert.ok(['stopped','ready'].includes(stopped.status) && stopped.lifecycle?.can_edit === true, 'Example must remain idle and editable after argument restoration');
    assert.ok(stopped.args === argumentSnapshot.original, 'Example arguments were not restored');
    assert.equal((await api('/health')).commit, configuration.expected_control_commit, 'Control source changed during acceptance');
    report.passed = true;
    report.checks = ['trusted HTTPS and exact deployed control commit', 'permanent link visible before launch', 'real Example launch and two decoded WebRTC viewers',
      'UI grant, transfer and revoke with server authority checks', 'viewer permission projection', 'Example stop; UI argument edit/save and original argument restoration with actual API agreement; read-only history', 'desktop/mobile screenshots and console errors'];
  } catch (error) { report.error = redact(error.message); }
  finally {
    if (opened) { try { cliRun('close'); } catch { report.browser_close_failed = true; report.passed = false; } }
    if (ownsRun) { try { await api('/apps/' + configuration.example_app_id + '/stop', 'POST'); } catch { report.cleanup_failed = true; report.passed = false; } }
    if (ownsRun && argumentSnapshot) {
      const restoration = report.argument_restoration = { values_in_evidence:false, args_restored:false, idle_state_confirmed:false };
      try {
        const route='/apps/'+configuration.example_app_id;
        let current=await api(route);
        if (current.args !== argumentSnapshot.original) {
          assert.ok((current.args === argumentSnapshot.candidate || current.args === argumentSnapshot.original.trim()) && (current.args_template||'') === argumentSnapshot.template, 'Concurrent Example configuration change; restoration refused');
          assert.ok(['stopped','ready','crashed','register_failed'].includes(current.status) && current.lifecycle?.can_edit === true, 'Example is not safely editable for recovery');
          const sessions=await api('/stream-sessions');
          assert.ok(!sessions.some(s=>s.host_id===argumentSnapshot.hostId && s.app_id===argumentSnapshot.nativeAppId && s.state!=='stopped'), 'Example still has nonterminal viewing authority; recovery refused');
          restoration.recovery_attempted=true;
          await api(route,'PUT',{args:argumentSnapshot.original});
          current=await api(route);
        }
        restoration.args_restored=current.args===argumentSnapshot.original;
        restoration.idle_state_confirmed=['stopped','ready','crashed'].includes(current.status) && current.lifecycle?.can_edit === true;
        assert.ok(restoration.args_restored && restoration.idle_state_confirmed, 'Original arguments or idle editable state could not be confirmed restored');
      } catch (error) {
        restoration.error=redact(error.message); report.passed=false;
        // A failed registration acknowledgement can follow a successful DB write.
        // Record what can actually be read back without retrying unrelated state.
        try {
          const actual=await api('/apps/'+configuration.example_app_id);
          restoration.args_restored=actual.args===argumentSnapshot.original;
          restoration.idle_state_confirmed=['stopped','ready','crashed'].includes(actual.status) && actual.lifecycle?.can_edit===true;
        } catch { restoration.readback_failed=true; }
      }
    }
    // CLI diagnostics/snapshots can contain viewer fragments; never retain them unredacted.
    function scrub(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isSymbolicLink()) continue; if (entry.isDirectory()) scrub(file); else if (/\.(json|jsonl|log|txt|yml|yaml|md|js)$/.test(entry.name)) fs.writeFileSync(file, redact(fs.readFileSync(file, 'utf8'))); } }
    scrub(output);
    report.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  console.log(JSON.stringify({ passed: report.passed, output }));
  if (!report.passed) process.exitCode = 1;
}

async function browserAcceptance(page, cfg) {
  const errors = [], viewers = [], contexts = [], metrics = [];
  const httpFailures = [], networkFailures = [], responseReads = [], owners = new Map(), requests = new WeakMap(), pendingRequests = new Set(), networkRequests = [], mediaFrames = new Map(), endedStates = new Map(), expectedFailures = new Map();
  let eventOrder = 0, stopping;
  let responseCursor = 0;
  const drainResponses = async () => {
    while(responseCursor<responseReads.length) {
      const pending=responseReads.slice(responseCursor); responseCursor=responseReads.length;
      await Promise.all(pending);
    }
  };
  const requireTrue = (value, message) => { if (!value) throw Error(message); };
  const address = raw => { try { const url = new URL(raw); return {resource:url.origin+url.pathname,hasQuery:!!url.search,hasHash:!!url.hash}; } catch { return {resource:'',hasQuery:false,hasHash:false}; } };
  const exact = (entry, resource) => entry.resource===resource && !entry.hasQuery && !entry.hasHash;
  const watchErrors = target => {
    const owner = { id:owners.size, connectionId:null, media:new Set() }; owners.set(target, owner);
    target.on('request', request => {
      const entry={owner:owner.id,method:request.method(),order:++eventOrder,...address(request.url())};
      requests.set(request,entry);
      if (new URL(request.url()).pathname.startsWith('/api/')) {
        networkRequests.push(entry);
        if (['fetch','xhr'].includes(request.resourceType())) pendingRequests.add(request);
      }
    });
    target.on('requestfinished', request=>pendingRequests.delete(request));
    target.on('requestfailed', request=>{
      pendingRequests.delete(request);
      const entry=requests.get(request);
      if (entry && new URL(request.url()).pathname.startsWith('/api/')) networkFailures.push({...entry,failureOrder:++eventOrder});
    });
    target.on('pageerror', error => errors.push({kind:'javascript',owner:owner.id,message:String(error.message).slice(0,1000)}));
    target.on('console', message => { if (message.type() === 'error') errors.push({kind:'console',owner:owner.id,message:message.text().slice(0,1000),...address(message.location().url)}); });
    target.on('response', response => {
      const request = response.request(), location = response.headers().location;
      if (request.method() === 'POST' && new URL(response.url()).pathname === '/api/host/stream/webrtc' && location) {
        const endpoint = new URL(location, response.url());
        if (endpoint.origin === new URL(response.url()).origin && !endpoint.search && !endpoint.hash && /^\/api\/host\/stream\/webrtc\/\d+$/.test(endpoint.pathname)) owner.media.add(address(endpoint.href).resource);
      }
      if (response.status() < 400) return;
      const failure = {owner:owner.id,...address(response.url()),method:request.method(),status:response.status(),requestOrder:requests.get(request)?.order,responseOrder:++eventOrder,code:''};
      httpFailures.push(failure);
      responseReads.push(response.json().then(body => {
        if (body?.status === 'error' && typeof body.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(body.code)) failure.code = body.code;
      }).catch(() => {}));
    });
  };
  watchErrors(page);
  const api = route => page.evaluate(async route => {
    const response = await fetch('/api/v1' + route, { headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') }, cache: 'no-store' });
    if (!response.ok) throw Error('Live management API unavailable');
    const result = await response.json(); if (result.status !== 'ok') throw Error('Live management API rejected operation'); return result.data;
  }, route);
  const waitFor = async (read, check, label, timeout = 90000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await read(); if (check(value)) return value; await page.waitForTimeout(500); }
    throw Error('Timed out: ' + label);
  };
  const screenshot = (target, name, mask = []) => target.screenshot({ path: cfg.output + '/' + name + '.png', fullPage: true, mask:[...mask, target.locator('#application-args')] });
  const currentSession = async () => {
    const matches = (await api('/stream-sessions')).filter(s => s.host_id === cfg.host && s.app_id === cfg.app && s.state !== 'stopped');
    requireTrue(matches.length === 1, 'Expected one shared Example session'); return matches[0];
  };
  const role = async (target, expected) => waitFor(async () => {
    for (const frame of target.frames()) { try { const badge = frame.locator('.viewer-authority'); if (await badge.count() && await badge.isVisible()) return badge.innerText(); } catch { /* Frame navigation is expected during entry. */ } }
    return '';
  }, text => text === expected, 'Viewer role ' + expected, 20000);
  const observePeers = () => {
    const NativePeer = globalThis.RTCPeerConnection; globalThis.__liveAcceptancePeers = [];
    globalThis.RTCPeerConnection = new Proxy(NativePeer, { construct(target, args) { const peer = Reflect.construct(target, args); globalThis.__liveAcceptancePeers.push(peer); return peer; } });
  };
  const videoMetrics = async target => {
    for (const frame of target.frames()) { try { const values = await frame.evaluate(async () => {
      const result = []; for (const peer of globalThis.__liveAcceptancePeers || []) for (const stats of (await peer.getStats()).values())
        if (stats.type === 'inbound-rtp' && (stats.kind === 'video' || stats.mediaType === 'video')) result.push({ bytes: stats.bytesReceived || 0, frames: stats.framesDecoded || 0 });
      return result;
    }); const decoded = values.find(value => value.frames > 0); if (decoded) { mediaFrames.set(target,frame); return decoded; } } catch { /* Navigation may replace the viewer frame. */ } }
    return { bytes: 0, frames: 0 };
  };
  const endedViewer = async target => {
    const original = mediaFrames.get(target);
    const observed={original_frame_present:!!original&&!original.isDetached()&&target.frames().includes(original),frames:[]};
    endedStates.set(owners.get(target).id,observed);
    if (!observed.original_frame_present) return false;
    let originalObserved = false;
    for (const frame of target.frames()) { try {
      const state = await frame.evaluate(() => {
        const peers = globalThis.__liveAcceptancePeers || [];
        if (!peers.length) return null;
        const authority = globalThis.app?.getStream?.()?.getAuthority?.();
        const boolean=value=>typeof value==='boolean'?value:null;
        return {peers:peers.map(peer=>peer.signalingState),ended:boolean(authority?.ended),verified:boolean(authority?.verified),control:boolean(authority?.control),microphone:boolean(authority?.microphone)};
      });
      if (!state) continue;
      observed.frames.push({original:frame===original,...state});
      if(frame===original) originalObserved = true;
      if (state.ended!==true || state.verified!==false || state.control!==false || state.microphone!==false || state.peers.some(value=>value!=='closed')) return false;
    } catch { observed.observation_unavailable=true; return false; } }
    if (originalObserved) {
      const owner=owners.get(target);
      if (!owner.endedAt) owner.endedAt=++eventOrder;
    }
    return originalObserved;
  };
  try {
    await page.goto(cfg.base + '/apps');
    await page.locator('a[href="/apps/' + cfg.appId + '"]').first().click();
    await page.getByRole('heading', { name: cfg.name, exact: true }).waitFor();
    const link = page.getByRole('textbox', { name: '固定观看链接', exact: true });
    const original = await api('/apps/'+cfg.appId);
    const originalHash = await page.evaluate(async value => {
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
      return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    }, original.args);
    requireTrue(originalHash === cfg.originalArgsSHA256, 'Example arguments changed before acceptance');
    await link.waitFor(); const watch = await link.inputValue();
    const url = new URL(watch); requireTrue(url.origin === cfg.base && url.pathname === '/watch' && /^#key=[A-Za-z0-9_-]{43}$/.test(url.hash), 'Invalid permanent link');
    await screenshot(page, 'app-before-launch-desktop', [link]);
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, 'app-before-launch-mobile', [link]);
    requireTrue(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'App page overflows mobile viewport');
    await page.setViewportSize({ width: 1440, height: 1000 });
    requireTrue(!(await api('/apps')).some(app => app.id !== cfg.appId && ['running', 'starting', 'stopping'].includes(app.status)), 'Another application became active');
    await page.context().addInitScript(observePeers);
    // The button opens the production viewer; it must not be replaced with a direct launch API call.
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: '启动串流', exact: true }).click()]);
    viewers.push(popup); watchErrors(popup);
    // Observe real inbound media. Instrumentation retains no packets, audio or credentials.
    await waitFor(async () => {
      const list = await api('/stream-sessions'); return list.find(s => s.host_id === cfg.host && s.app_id === cfg.app && s.state !== 'stopped');
    }, s => s && Object.values(s.connections).filter(c => c.state === 'connected').length === 1, 'First viewer');
    await role(popup, '仅观看');
    const firstDecoded = await waitFor(() => videoMetrics(popup), value => value.frames > 0 && value.bytes > 0, 'First real decoded WebRTC video');
    const firstAdvancing = await waitFor(() => videoMetrics(popup), value => value.frames > firstDecoded.frames && value.bytes > firstDecoded.bytes, 'First advancing video frames');
    metrics.push({ viewer: 'first', samples: [firstDecoded, firstAdvancing] });
    const first = Object.values((await currentSession()).connections).find(c => c.state === 'connected');
    owners.get(popup).connectionId = first.connection_id;
    const browser = page.context().browser(); requireTrue(browser, 'CLI browser context unavailable');
    const context = await browser.newContext({ ignoreHTTPSErrors: false, viewport: { width: 1280, height: 800 } }); contexts.push(context);
    await context.addInitScript(observePeers);
    const secondPage = await context.newPage(); viewers.push(secondPage); watchErrors(secondPage); await secondPage.goto(watch);
    await role(secondPage, '仅观看');
    const live = await waitFor(currentSession, s => Object.values(s.connections).filter(c => c.state === 'connected').length === 2, 'Two viewers');
    const second = Object.values(live.connections).find(c => c.state === 'connected' && c.connection_id !== first.connection_id);
    requireTrue(second, 'Second independent connection missing');
    owners.get(secondPage).connectionId = second.connection_id;
    const decoded = await waitFor(() => videoMetrics(secondPage), value => value.frames > 0 && value.bytes > 0, 'Second real decoded WebRTC video');
    const advancing = await waitFor(() => videoMetrics(secondPage), value => value.frames > decoded.frames && value.bytes > decoded.bytes, 'Second advancing video frames');
    metrics.push({ viewer: 'second', samples: [decoded, advancing] });
    await screenshot(secondPage, 'viewer-before-grant');
    await page.goto(cfg.base + '/stream-sessions?app=' + encodeURIComponent(cfg.appId));
    const clientCard = id => page.locator('.client-card').filter({ hasText: id.slice(0, 6).toUpperCase() });
    await clientCard(first.connection_id).getByRole('button', { name: '授予控制权', exact: true }).click();
    await waitFor(currentSession, s => s.controller_connection_id === first.connection_id, 'First controller');
    await role(popup, '控制者'); await role(secondPage, '仅观看');
    await clientCard(second.connection_id).getByRole('button', { name: '转移控制权', exact: true }).click();
    await waitFor(currentSession, s => s.controller_connection_id === second.connection_id, 'Transferred controller');
    await role(popup, '仅观看'); await role(secondPage, '控制者');
    await screenshot(page, 'sessions-transfer-desktop'); await screenshot(secondPage, 'viewer-after-transfer');
    await page.setViewportSize({ width: 390, height: 844 }); await screenshot(page, 'sessions-transfer-mobile');
    requireTrue(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Session page overflows mobile viewport');
    await clientCard(second.connection_id).getByRole('button', { name: '释放控制权', exact: true }).click();
    await waitFor(currentSession, s => !s.controller_connection_id, 'Revoked controller');
    await role(popup, '仅观看'); await role(secondPage, '仅观看');
    await page.goto(cfg.base + '/apps/' + cfg.appId);
    stopping = {sessionId:live.session_id,order:++eventOrder};
    await page.getByRole('button', { name: '停止串流（含程序）', exact: true }).click();
    await waitFor(() => api('/apps/' + cfg.appId), app => app.status === 'stopped', 'Example stopped');
    await waitFor(() => api('/stream-sessions'), sessions => {
      const ended = sessions.find(session => session.session_id === live.session_id);
      return ended && ended.state === 'stopped' && !ended.controller_connection_id && Object.keys(ended.connections).length === 0;
    }, 'Stopped generation released all clients and authority');
    await waitFor(()=>endedViewer(popup), Boolean, 'First viewer ended with closed RTC and disabled authority', 20000);
    await waitFor(()=>endedViewer(secondPage), Boolean, 'Second viewer ended with closed RTC and disabled authority', 20000);
    await screenshot(secondPage, 'viewer-ended');
    const editor = page.locator('#application-args'), saveButton = page.getByRole('button', {name:'保存',exact:true});
    await waitFor(()=>api('/apps/'+cfg.appId), app=>app.lifecycle?.can_edit===true, 'Stopped Example is editable');
    await waitFor(()=>editor.isEnabled(), Boolean, 'Argument editor enabled after stopping');
    const unchanged=await api('/apps/'+cfg.appId);
    requireTrue(unchanged.args===original.args && unchanged.capture_mode===original.capture_mode && unchanged.args_template===original.args_template, 'Example configuration changed concurrently');
    const originalEditor=await waitFor(()=>editor.inputValue(), value=>original.args.trim()?!!value.trim():!value.trim(), 'Original arguments loaded in editor');
    const saveArgs = async value => {
      await editor.fill(value);
      const response = page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/apps/'+cfg.appId && response.request().method()==='PUT');
      await saveButton.click(); requireTrue((await response).status()===200, 'Stopped Example argument save was rejected');
      await page.getByRole('status').filter({hasText:'配置已保存，下次启动应用时生效。'}).waitFor();
      await waitFor(()=>api('/apps/'+cfg.appId), app=>app.args===value && app.lifecycle?.can_edit===true, 'Saved argument state and API agree');
      await waitFor(()=>editor.isEnabled(), Boolean, 'Editor ready after saved configuration refresh');
    };
    await saveArgs(cfg.candidateArgs);
    await waitFor(()=>editor.inputValue(), value=>value===cfg.candidateArgs, 'Saved candidate displayed in editor');
    await screenshot(page,'stopped-arguments-saved',[link]);
    await saveArgs(original.args);
    await waitFor(()=>editor.inputValue(), value=>value===originalEditor, 'Restored original argument state displayed');
    const restored=await api('/apps/'+cfg.appId);
    requireTrue(restored.args===original.args && restored.capture_mode===original.capture_mode && restored.args_template===original.args_template, 'Original Example configuration was not restored');
    await screenshot(page,'stopped-arguments-restored',[link]);
    await page.goto(cfg.base + '/stream-sessions?app=' + encodeURIComponent(cfg.appId));
    await page.getByRole('button', { name: /已结束记录/ }).click();
    await page.getByRole('heading', { name: '已结束的应用串流', exact: true }).waitFor();
    requireTrue(await page.getByRole('button', { name: /授予控制权|转移控制权|释放控制权/ }).count() === 0, 'History exposes live control commands');
    await screenshot(page, 'history-mobile');
    await page.setViewportSize({ width: 1440, height: 1000 }); await screenshot(page, 'history-desktop');
    const viewerPending = () => [...pendingRequests].filter(request=>requests.get(request)?.owner!==owners.get(page).id);
    await waitFor(async()=>viewerPending().length, count=>count===0, 'Viewer API cleanup completed', 15000);
    await drainResponses();
    // Exercise normal browser unload only after observing the actual ended UI
    // and closed RTC. A repeated close must not restart remote cleanup.
    for (const viewer of viewers) {
      viewer.on('dialog', async dialog=>{
        errors.push({kind:'dialog',owner:owners.get(viewer).id,message:'Unexpected dialog while closing an ended viewer: '+dialog.type()});
        await dialog.accept().catch(()=>{});
      });
      const closed=viewer.waitForEvent('close',{timeout:10000});
      await viewer.close({runBeforeUnload:true}); await closed;
    }
    for (const context of contexts) await context.close();
    await waitFor(async()=>viewerPending().length, count=>count===0, 'Viewer unload requests completed', 15000);
    await drainResponses();
    // A stop intentionally invalidates viewer credentials. Classify only real
    // denials for this stopped generation, preserving every raw failure. A
    // terminal response must not cause new recovery or remote cleanup effects.
    const expected = expectedFailures, followups = [];
    for (const owner of owners.values()) {
      if (!owner.connectionId) continue;
      const connection = cfg.base + '/api/v1/client-sessions/' + stopping.sessionId + '/connections/' + owner.connectionId;
      const failures = httpFailures.filter(value=>value.owner===owner.id && value.responseOrder>stopping.order);
      const confirmation = failures.filter(value=>
        (value.status===410 && value.code==='CONNECTION_TERMINATED' && (exact(value,connection)||exact(value,connection+'/heartbeat')||exact(value,connection+'/resume')||exact(value,connection+'/ticket'))) ||
        (exact(value,connection+'/resume') && ((value.status===410 && value.code==='CONNECTION_EXPIRED')||(value.status===401 && value.code==='CONNECTION_UNAUTHORIZED')))
      ).map(value=>value.responseOrder);
      // An actually observed ended viewer is also a terminal boundary, even
      // when no rejected HTTP request was needed to reach that state.
      const confirmedAt = Math.min(owner.endedAt || Infinity, ...confirmation);
      // Inspect requests regardless of response status. An erroneous successful
      // resume/offer after termination must fail just as a denied attempt does.
      for (const request of networkRequests.filter(value=>value.owner===owner.id && value.order>confirmedAt && value.method!=='OPTIONS')) {
        const url=new URL(request.resource);
        const management=request.resource===connection||request.resource.startsWith(connection+'/');
        const media=[...owner.media].some(value=>new URL(value).origin===url.origin)&&/^\/api\/host\/stream(?:\/|$)/.test(url.pathname);
        const admission=url.origin===new URL(cfg.base).origin && request.method==='POST' && ['/api/v1/watch/open','/api/v1/client-sessions/join','/api/v1/stream-invitations'].includes(url.pathname);
        if (management||media||admission) followups.push(request);
      }
      let legacyResume = false, mediaDelete = false, connectionDelete = false;
      for (const failure of failures) {
        if (failure.status===410 && failure.method==='POST' && exact(failure,connection+'/heartbeat') && ['CONNECTION_TERMINATED','CONNECTION_EXPIRED'].includes(failure.code) && failure.requestOrder<confirmedAt) {
          expected.set(failure,'terminal_heartbeat');
        } else if (!legacyResume && ((failure.status===410 && ['CONNECTION_TERMINATED','CONNECTION_EXPIRED'].includes(failure.code))||(failure.status===401 && failure.code==='CONNECTION_UNAUTHORIZED')) && failure.method==='POST' && exact(failure,connection+'/resume') && failure.requestOrder<confirmedAt && failures.some(value=>exact(value,connection+'/heartbeat') && value.code==='CONNECTION_EXPIRED' && value.responseOrder<failure.requestOrder)) {
          legacyResume=true; expected.set(failure,'legacy_terminal_confirmation');
        } else if (!mediaDelete && failure.method==='DELETE' && owner.media.has(failure.resource) && !failure.hasQuery && !failure.hasHash && [401,404,410].includes(failure.status) && failure.requestOrder<confirmedAt) {
          mediaDelete=true; expected.set(failure,'inflight_media_cleanup');
        } else if (!connectionDelete && failure.method==='DELETE' && exact(failure,connection) && failure.status===410 && ['CONNECTION_TERMINATED','CONNECTION_EXPIRED'].includes(failure.code) && failure.requestOrder<confirmedAt) {
          connectionDelete=true; expected.set(failure,'inflight_connection_cleanup');
        }
      }
    }
    const unmatched = [...expected.keys()];
    const unexpectedConsole = errors.filter(error=>{
      if (error.kind!=='console' || !/^Failed to load resource: the server responded with a status of (401|404|410)(?:\s*\([^)]*\))?$/.test(error.message)) return true;
      const status=Number(error.message.match(/status of (\d+)/)[1]);
      const index=unmatched.findIndex(value=>value.owner===error.owner && value.resource===error.resource && !error.hasQuery && !error.hasHash && value.status===status);
      if (index<0) return true;
      unmatched.splice(index,1); return false;
    });
    requireTrue(followups.length===0, 'New viewer request after confirmed termination: '+JSON.stringify(followups));
    requireTrue(networkFailures.length===0, 'Failed API network requests: '+JSON.stringify(networkFailures));
    requireTrue(httpFailures.every(value=>expected.has(value)), 'Unexpected HTTP failure: '+JSON.stringify(httpFailures.filter(value=>!expected.has(value))));
    requireTrue(unexpectedConsole.length===0, 'Unexpected browser console or JavaScript errors: '+JSON.stringify(unexpectedConsole));
    return JSON.stringify({ result: 'LIVE_MANAGEMENT_ACCEPTANCE_OK', decoded_video_metrics: metrics, stopped_viewers:Object.fromEntries(endedStates), stopped_argument_edit:{saved_via_ui:true,restored_via_ui:true,api_ui_agreement:true}, raw_console_errors:errors.length,unexpected_console_errors:unexpectedConsole.length,pending_viewer_api_requests:viewerPending().length,terminal_followup_requests:followups,network_failures:networkFailures,http_failures:httpFailures.map(value=>({...value,classification:expected.get(value)||'unexpected'})),viewer_requests:networkRequests.filter(value=>value.owner!==owners.get(page).id) });
  } catch(error) {
    await drainResponses();
    // Preserve actual partial observations even when an assertion fails. Query
    // strings, fragments, bodies and authentication headers are never recorded.
    const trace={decoded_video_metrics:metrics,stopped_viewers:Object.fromEntries(endedStates),pending_viewer_api_requests:[...pendingRequests].map(request=>requests.get(request)).filter(value=>value?.owner!==owners.get(page).id),network_failures:networkFailures,http_failures:httpFailures.map(value=>({...value,classification:expectedFailures.get(value)||'unclassified'})),viewer_requests:networkRequests.filter(value=>value.owner!==owners.get(page).id)};
    throw Error(String(error.message)+'\nLive observations: '+JSON.stringify(trace));
  } finally {
    for (const viewer of viewers) await viewer.close().catch(() => {});
    for (const context of contexts) await context.close().catch(() => {});
    // CLI may snapshot the active page after run-code finishes or throws. Leave
    // no argument editor or durable viewing capability visible to that snapshot.
    await page.goto('about:blank').catch(() => {});
  }
}

main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
