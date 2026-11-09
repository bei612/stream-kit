// Explicitly opted-in acceptance against an installed deployment; no response mocking.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const cp = require('node:child_process');
const assert = require('node:assert/strict');

function redact(value) {
  return String(value).replace(/((?:key|join|mediaTicket|mediaControlToken)=)[A-Za-z0-9_%.-]+/g, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]');
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
  if (args[2] !== '--execute') {
    console.log('Configuration validated. No browser, application or service was changed. Add --execute to run live acceptance.');
    return;
  }
  fs.mkdirSync(output, { mode: 0o700 });
  const report = { passed: false, base: base.origin, expected_control_commit: configuration.expected_control_commit,
    example_app_id: configuration.example_app_id, started_at: new Date().toISOString(), operations: 'Only explicitly owned Example; no service or network changes' };
  const api = (route, method = 'GET') => new Promise((resolve, reject) => {
    const request = https.request(new URL('/api/v1' + route, base), { method, ca: fs.readFileSync(ca), headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; if (body.length > 4 * 1024 * 1024) request.destroy(Error('API response too large')); });
      response.on('end', () => { try { const data = JSON.parse(body); assert.equal(response.statusCode, 200, 'Live API refused request'); assert.equal(data.status, 'ok'); resolve(data.data); } catch { reject(Error('Live API check failed: ' + route)); } });
    });
    request.on('error', () => reject(Error('Trusted HTTPS request failed: ' + route)));
    request.on('timeout', () => request.destroy()); request.end();
  });
  const session = `management-live-${Date.now()}`;
  let opened = false, ownsRun = false;
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
    assert.ok(['stopped', 'ready'].includes(example.status), 'Owned Example must be idle before acceptance');
    assert.ok(!apps.some(app => app.id !== example.id && ['running', 'starting', 'stopping'].includes(app.status)), 'Another application is active');
    const identity = new URL(example.stream_url, base);
    const host = Number(identity.searchParams.get('hostId')), app = Number(identity.searchParams.get('appId'));
    assert.ok(host > 0 && app > 0 && app === example.sunshine_app_id, 'Owned Example has no consistent streaming identity');
    const sessions = await api('/stream-sessions');
    assert.ok(!sessions.some(s => s.host_id === host && s.app_id === app && Object.values(s.connections).some(c => c.state === 'connected' && Date.parse(c.expires_at) > Date.now())), 'Example already has viewers');
    report.preflight = { control_commit: health.commit, app_status: example.status, other_active_apps: 0 };
    const browserConfig = path.join(output, 'cli.config.json');
    fs.writeFileSync(browserConfig, JSON.stringify({ browser: { browserName: 'chromium', launchOptions: { channel: 'chrome' }, contextOptions: { ignoreHTTPSErrors: false, storageState: state, viewport: { width: 1440, height: 1000 } } }, outputDir: output }), { mode: 0o600 });
    cliRun('open', 'about:blank', '--config', browserConfig); opened = true;
    const script = path.join(output, 'live-browser.js');
    const browserOptions = { base: base.origin, appId: example.id, name: example.name, host, app, output };
    fs.writeFileSync(script, `async (page) => { const cfg = ${JSON.stringify(browserOptions)}; return await (${browserAcceptance.toString()})(page, cfg); }`, { mode: 0o600 });
    ownsRun = true;
    const result = cliRun('run-code', '--filename', script);
    assert.ok(result.includes('LIVE_MANAGEMENT_ACCEPTANCE_OK'), 'Live browser checks did not finish successfully');
    const stopped = await api('/apps/' + example.id);
    assert.equal(stopped.status, 'stopped', 'Example did not stop');
    assert.equal((await api('/health')).commit, configuration.expected_control_commit, 'Control source changed during acceptance');
    report.passed = true;
    report.checks = ['trusted HTTPS and exact deployed control commit', 'permanent link visible before launch', 'real Example launch and two decoded WebRTC viewers',
      'UI grant, transfer and revoke with server authority checks', 'viewer permission projection', 'Example stop and read-only history', 'desktop/mobile screenshots and console errors'];
  } catch (error) { report.error = redact(error.message); }
  finally {
    if (opened) { try { cliRun('close'); } catch { report.browser_close_failed = true; report.passed = false; } }
    if (ownsRun) { try { await api('/apps/' + configuration.example_app_id + '/stop', 'POST'); } catch { report.cleanup_failed = true; report.passed = false; } }
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
  const requireTrue = (value, message) => { if (!value) throw Error(message); };
  const watchErrors = target => { target.on('pageerror', error => errors.push('JavaScript: ' + String(error.message).slice(0, 1000))); target.on('console', message => { if (message.type() === 'error') errors.push('Console: ' + message.text().slice(0, 1000)); }); };
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
  const screenshot = (target, name, mask = []) => target.screenshot({ path: cfg.output + '/' + name + '.png', fullPage: true, mask });
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
    }); const decoded = values.find(value => value.frames > 0); if (decoded) return decoded; } catch { /* Navigation may replace the viewer frame. */ } }
    return { bytes: 0, frames: 0 };
  };
  try {
    await page.goto(cfg.base + '/apps');
    await page.locator('a[href="/apps/' + cfg.appId + '"]').first().click();
    await page.getByRole('heading', { name: cfg.name, exact: true }).waitFor();
    const link = page.getByRole('textbox', { name: '固定观看链接', exact: true });
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
    const browser = page.context().browser(); requireTrue(browser, 'CLI browser context unavailable');
    const context = await browser.newContext({ ignoreHTTPSErrors: false, viewport: { width: 1280, height: 800 } }); contexts.push(context);
    await context.addInitScript(observePeers);
    const secondPage = await context.newPage(); viewers.push(secondPage); watchErrors(secondPage); await secondPage.goto(watch);
    await role(secondPage, '仅观看');
    const live = await waitFor(currentSession, s => Object.values(s.connections).filter(c => c.state === 'connected').length === 2, 'Two viewers');
    const second = Object.values(live.connections).find(c => c.state === 'connected' && c.connection_id !== first.connection_id);
    requireTrue(second, 'Second independent connection missing');
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
    await page.getByRole('button', { name: '停止串流（含程序）', exact: true }).click();
    await waitFor(() => api('/apps/' + cfg.appId), app => app.status === 'stopped', 'Example stopped');
    await waitFor(() => api('/stream-sessions'), sessions => {
      const ended = sessions.find(session => session.session_id === live.session_id);
      return ended && ended.state === 'stopped' && !ended.controller_connection_id && Object.keys(ended.connections).length === 0;
    }, 'Stopped generation released all clients and authority');
    await page.goto(cfg.base + '/stream-sessions?app=' + encodeURIComponent(cfg.appId));
    await page.getByRole('button', { name: /已结束记录/ }).click();
    await page.getByRole('heading', { name: '已结束的应用串流', exact: true }).waitFor();
    requireTrue(await page.getByRole('button', { name: /授予控制权|转移控制权|释放控制权/ }).count() === 0, 'History exposes live control commands');
    await screenshot(page, 'history-mobile');
    await page.setViewportSize({ width: 1440, height: 1000 }); await screenshot(page, 'history-desktop');
    requireTrue(errors.length === 0, 'Browser console or JavaScript errors: ' + JSON.stringify(errors));
    return JSON.stringify({ result: 'LIVE_MANAGEMENT_ACCEPTANCE_OK', decoded_video_metrics: metrics, console_errors: errors.length });
  } finally { for (const viewer of viewers) await viewer.close().catch(() => {}); for (const context of contexts) await context.close().catch(() => {}); }
}

main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
