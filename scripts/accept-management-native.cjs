// Source-CI management checks against the real orchestrator, SQLite and production SPA.
// This intentionally does not claim streaming, capture, microphone or controller acceptance.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { engine, launchBrowser } = require('./lib/test-browser.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function option(name) { const index = process.argv.indexOf(name); assert.ok(index > 1 && process.argv[index + 1], `Missing ${name}`); return path.resolve(process.argv[index + 1]); }
function copyAssets(source, destination) {
  assert.ok(fs.lstatSync(source).isDirectory(), 'Production dist must be a directory'); fs.mkdirSync(destination);
  for (const entry of fs.readdirSync(source)) {
    const from = path.join(source, entry), to = path.join(destination, entry), stat = fs.lstatSync(from);
    if (stat.isDirectory()) copyAssets(from, to);
    else { assert.ok(stat.isFile(), 'Linked or special asset rejected'); fs.copyFileSync(from, to); }
  }
}

(async () => {
  const binary = option('--binary'), dist = option('--dist'), output = option('--output');
  const componentCommands = process.argv.includes('--component-commands');
  assert.ok(fs.lstatSync(binary).isFile()); assert.ok(fs.lstatSync(path.join(dist, 'index.html')).isFile());
  assert.ok(!fs.existsSync(output), 'Use a new evidence directory'); fs.mkdirSync(output, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-kit-management-native-'));
  const configPath = path.join(workspace, 'config.json');
  const environment = { ...process.env }; for (const name of Object.keys(environment)) if (name.startsWith('ORCH_')) delete environment[name];
  let child, browser, secrets = [], serviceBase;
  const report = { passed: false, engine, scope: 'Real management API and SPA only; components absent by configuration, no media acceptance', cases: [], console: [], expected_unavailable: [], unexpected_http_errors: [] };
  if (componentCommands) report.scope = 'Real management API/SPA, owned native orchestrator component start/restart/stop and missing-executable failure; no encoder, gateway, application launch/popup or media acceptance';
  report.expected_component_errors = [];
  const sanitize = value => { let text = String(value); for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]'); return text.replace(/Bearer\s+[A-Za-z0-9_.-]+/g, 'Bearer [redacted]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]'); };
  let serviceLog = '';
  try {
    cp.execFileSync(binary, ['init-config', '--config', configPath], { cwd: workspace, env: environment, windowsHide: true, stdio: 'pipe' });
    const cfg = read(configPath); secrets = [cfg.server.password, cfg.server.jwt_secret, cfg.server.media_ticket_secret];
    const reservation = net.createServer(); await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    Object.assign(cfg.server, { bind_address: `127.0.0.1:${port}`, tls_cert: '', tls_key: '', media_ticket_secret: '', lan_tls: { ca_cert: '', ca_key: '', hosts: [] } });
    cfg.components = {}; cfg.sunshine_api = { base_url: '', username: '', password: '', verify_ssl: true }; cfg.moonlight_web = { base_url: '', public_url: '', username: '', password: '' };
    cfg.render_nodes = {}; cfg.storage.apps_dir = path.join(workspace, 'apps'); cfg.storage.temp_dir = path.join(workspace, 'temp'); cfg.storage.db_path = path.join(workspace, 'state.sqlite'); cfg.log.file.enabled = false;
    if (componentCommands) {
      const directory = path.join(workspace, 'owned-component'); fs.mkdirSync(directory);
      const componentConfig = path.join(directory, 'config.json');
      cp.execFileSync(binary, ['init-config', '--config', componentConfig], { cwd: directory, env: environment, windowsHide: true, stdio: 'pipe' });
      const native = read(componentConfig); secrets.push(native.server.password, native.server.jwt_secret, native.server.media_ticket_secret);
      const lease = net.createServer(); await new Promise((resolve, reject) => { lease.once('error', reject); lease.listen(0, '127.0.0.1', resolve); });
      const componentPort = lease.address().port; await new Promise(resolve => lease.close(resolve));
      const childConfig = structuredClone(cfg); childConfig.server = { ...cfg.server, ...native.server, bind_address: `127.0.0.1:${componentPort}`, media_ticket_secret: '' };
      childConfig.storage = { ...cfg.storage, apps_dir: path.join(directory, 'apps'), temp_dir: path.join(directory, 'temp'), db_path: path.join(directory, 'state.sqlite') };
      fs.writeFileSync(componentConfig, JSON.stringify(childConfig, null, 2), { mode: 0o600 });
      const owned = { exe_path: binary, args: `--config "${componentConfig}"`, working_dir: directory, auto_start: false, restart_on_crash: false, health_check: { type: 'http', url: `http://127.0.0.1:${componentPort}/api/v1/health`, interval_seconds: 1, timeout_seconds: 1, unhealthy_threshold: 1, healthy_threshold: 1, startup_timeout_seconds: 10 } };
      cfg.components = { owned_runtime: owned, unavailable_runtime: { ...owned, exe_path: path.join(directory, 'missing-native-program' + (process.platform === 'win32' ? '.exe' : '')), args: '', health_check: { type: 'process' } } };
      report.component_endpoint = `http://127.0.0.1:${componentPort}`;
    }
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    copyAssets(dist, path.join(workspace, 'dist'));
    child = cp.spawn(binary, ['--config', configPath], { cwd: workspace, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError; child.once('error', error => { spawnError = error; });
    child.stdout.on('data', chunk => serviceLog += chunk); child.stderr.on('data', chunk => serviceLog += chunk);
    const base = `http://127.0.0.1:${port}`;
    serviceBase = base;
    let health;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.ok(!spawnError && child.exitCode === null, 'Isolated orchestrator could not start');
      try { const response = await fetch(base + '/api/v1/health', { signal: AbortSignal.timeout(1000) }); if (response.ok) { health = (await response.json()).data; break; } } catch {}
      await delay(100);
    }
    assert.ok(health, 'Actual orchestrator health never became ready');
    if (componentCommands) {
      assert.deepEqual(Object.keys(health.components).sort(), ['owned_runtime', 'unavailable_runtime']);
      for (const state of Object.values(health.components)) assert.equal(state.status, 'stopped');
    } else assert.deepEqual(health.components, {}, 'Unexpected real service components started');
    report.control_commit = health.commit; report.binary_sha256 = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    report.dist_index_sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, 'index.html'))).digest('hex');
    const denied = await fetch(base + '/api/v1/stream-sessions'); assert.equal(denied.status, 401); report.cases.push('unauthenticated real API denied');
    browser = await launchBrowser(); report.browser_version = browser.version();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), javascriptErrors = [], responseChecks = [], verifiedResourceFailures = [];
    report.request_timeline = []; report.request_failures = []; report.navigations = []; report.javascript_errors = javascriptErrors;
    const pathname = value => { try { return new URL(value).pathname; } catch { return '[unavailable]'; } };
    const requestEvent = (request, event) => ({ event, time_ms: Date.now(), path: pathname(request.url()), method: request.method(), page_path: pathname(page.url()) });
    page.on('request', request => { if (pathname(request.url()).startsWith('/api/')) report.request_timeline.push(requestEvent(request, 'started')); });
    page.on('requestfinished', request => { if (pathname(request.url()).startsWith('/api/')) report.request_timeline.push(requestEvent(request, 'finished')); });
    page.on('requestfailed', request => { const event = { ...requestEvent(request, 'failed'), reason: sanitize(request.failure()?.errorText || 'unknown') }; report.request_timeline.push(event); report.request_failures.push(event); });
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) report.navigations.push({ time_ms: Date.now(), path: pathname(frame.url()) }); });
    page.on('pageerror', error => javascriptErrors.push({ time_ms: Date.now(), path: pathname(page.url()), message: sanitize(error.message), stack: sanitize(error.stack || '') }));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) report.console.push({ type: message.type(), text: sanitize(message.text()), location: message.location(), argument_count: message.args().length }); });
    page.on('response', response => {
      if (response.status() < 400) return; const pathname = new URL(response.url()).pathname, status = response.status();
      if (pathname === '/api/v1/configuration' && status === 409) return; // Explicitly asserted below, not ignored.
      const absent = {
        '/api/v1/media-control': [404, null],
        '/api/v1/components/web_server': [404, 'COMPONENT_NOT_FOUND'],
        '/api/v1/components/sunshine': [404, 'COMPONENT_NOT_FOUND'],
        '/api/v1/gateway-configuration': [503, 'GATEWAY_CONFIGURATION_UNAVAILABLE'],
        '/api/v1/encoder-configuration': [503, 'ENCODER_CONFIGURATION_UNAVAILABLE'],
        '/api/v1/audio-devices': [503, 'media_unconfigured'],
      }[pathname];
      responseChecks.push((async () => {
        const body = await response.text();
        let code; try { code = JSON.parse(body).code; } catch {}
        if (absent && status === absent[0] && (absent[1] === null ? body.trim() === '404 page not found' : code === absent[1])) {
          report.expected_unavailable.push({ pathname, status, code });
          verifiedResourceFailures.push({ url: response.url(), status });
        }
        else if (componentCommands && pathname === '/api/v1/components/unavailable_runtime/start' && response.request().method() === 'POST' && status === 500 && code === 'INTERNAL_ERROR') {
          const failure = JSON.parse(body); assert.ok(typeof failure.message === 'string' && failure.message.includes('missing-native-program'));
          report.expected_component_errors.push({ pathname, status, code }); verifiedResourceFailures.push({ url: response.url(), status });
        } else report.unexpected_http_errors.push({ pathname, status, code });
      })().catch(() => report.unexpected_http_errors.push({ pathname, status, body_unavailable: true })));
    });
    const screenshot = name => page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
    const api = (route, method = 'GET', body) => page.evaluate(async ({ route, method, body }) => {
      const response = await fetch('/api/v1' + route, { method, headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token'), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }, { route, method, body });
    await page.goto(base + '/login'); await page.getByLabel('用户名', { exact: true }).fill(cfg.server.username); await page.getByLabel('密码', { exact: true }).fill(cfg.server.password);
    await page.getByRole('button', { name: '登录控制台' }).click(); await page.waitForURL(base + '/');
    assert.ok(await page.evaluate(() => !!localStorage.getItem('auth_token'))); report.cases.push('UI login using native init-config generated credential');
    const documentOrigin = await page.evaluate(() => performance.timeOrigin);
    const navigate = async (label, target) => {
      await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: label, exact: true }).click();
      await page.waitForURL(base + target);
      assert.equal(await page.evaluate(() => performance.timeOrigin), documentOrigin, 'Normal management navigation unexpectedly replaced the document');
    };
    if (componentCommands) {
      assert.equal(await page.getByRole('button', { name: /^(启动|停止|重启)$/ }).count(), 0, 'Dashboard must not retain duplicate lifecycle controls');
      await navigate('组件管理', '/components');
      const owned = page.locator('#owned_runtime'), unavailable = page.locator('#unavailable_runtime');
      await owned.getByRole('button', { name: '启动', exact: true }).waitFor();
      const starts = () => report.request_timeline.filter(item => item.event === 'started' && item.method === 'POST' && item.path === '/api/v1/components/owned_runtime/start').length;
      await owned.getByRole('button', { name: '启动', exact: true }).evaluate(button => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await page.waitForFunction(() => document.querySelector('#owned_runtime')?.textContent.includes('运行中'));
      assert.equal(starts(), 1, 'Rapid UI clicks issued more than one start request');
      const runningComponent = await api('/components/owned_runtime'); assert.equal(runningComponent.body.data.status, 'running'); assert.ok(runningComponent.body.data.pid > 0);
      report.owned_component_pid = runningComponent.body.data.pid;
      const nativeHealth = await fetch(report.component_endpoint + '/api/v1/health'); assert.equal(nativeHealth.status, 200); assert.equal((await nativeHealth.json()).data.commit, health.commit);
      const failed = page.waitForResponse(response => response.url().endsWith('/components/unavailable_runtime/start') && response.request().method() === 'POST');
      await unavailable.getByRole('button', { name: '启动', exact: true }).click(); assert.equal((await failed).status(), 500);
      await unavailable.getByRole('alert').filter({ hasText: 'missing-native-program' }).waitFor();
      assert.equal(((await unavailable.innerText()).match(/missing-native-program/g) || []).length, 1, 'The same component error is displayed twice');
      assert.equal((await api('/components/unavailable_runtime')).body.data.status, 'error');
      assert.equal((await api('/components/owned_runtime')).body.data.status, 'running', 'Other resource failure affected owned component');
      await screenshot('components-real-running-and-error');
      await owned.getByRole('button', { name: '重启', exact: true }).click();
      await page.waitForFunction(previous => { const card = document.querySelector('#owned_runtime'); return card?.textContent.includes('运行中') && !card.textContent.includes('正在重启') && !card.textContent.includes(`PID: ${previous}`); }, report.owned_component_pid);
      const restarted = (await api('/components/owned_runtime')).body.data; assert.equal(restarted.status, 'running'); assert.notEqual(restarted.pid, report.owned_component_pid);
      await owned.getByRole('button', { name: '停止', exact: true }).evaluate(button => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await page.waitForFunction(() => { const card = document.querySelector('#owned_runtime'); return card?.textContent.includes('已停止') && !card.textContent.includes('正在停止'); });
      const stopped = (await api('/components/owned_runtime')).body.data; assert.equal(stopped.status, 'stopped'); assert.equal(stopped.pid, 0);
      await owned.getByText(/^运行时长:\s*-$/).waitFor();
      const componentDatabase = fs.readFileSync(path.join(workspace, 'owned-component', 'state.sqlite'));
      report.component_database = { format: componentDatabase.subarray(0, 16).toString('binary'), bytes: componentDatabase.length, sha256: crypto.createHash('sha256').update(componentDatabase).digest('hex') };
      assert.equal(report.component_database.format, 'SQLite format 3\u0000');
      assert.equal(report.request_timeline.filter(item => item.event === 'started' && item.method === 'POST' && item.path === '/api/v1/components/owned_runtime/stop').length, 1);
      await page.setViewportSize({ width: 390, height: 844 }); await screenshot('components-real-stopped-mobile');
      assert.equal(await owned.getByText(/^运行时长:\s*-$/).count(), 1, 'Stopped component retained an active uptime');
      assert.equal(((await unavailable.innerText()).match(/missing-native-program/g) || []).length, 1, 'Mobile layout duplicated the command error');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await page.setViewportSize({ width: 1440, height: 1000 });
      report.cases.push('Real owned native component start/restart/stop via SPA, actual health/PID transitions, same-frame repeated start and stop each produce one HTTP request, separate missing-executable HTTP500 is shown once without affecting running resource, stopped uptime is a dash on desktop/mobile');
    }
    await navigate('应用管理', '/apps'); await page.getByText('暂无应用', { exact: true }).waitFor();
    assert.equal((await api('/apps')).body.data.length, 0); await screenshot('apps-empty-desktop');
    await navigate('渲染会话', '/stream-sessions'); await page.getByRole('heading', { name: '串流会话', exact: true }).waitFor();
    assert.deepEqual((await api('/stream-sessions')).body.data, []); assert.equal(await page.locator('.client-card').count(), 0);
    await page.getByText('当前没有串流会话', { exact: true }).waitFor(); await screenshot('sessions-current-desktop');
    await page.getByRole('button', { name: /已结束记录/ }).click(); await page.getByText('暂无已结束记录', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /授予控制权|转移控制权|释放控制权/ }).count(), 0); report.cases.push('real empty current/history and zero clients; no fabricated stopped or running rows');
    await page.setViewportSize({ width: 390, height: 844 }); await screenshot('sessions-history-mobile');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: /当前会话/ }).click(); await screenshot('sessions-current-mobile');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await navigate('系统设置', '/settings'); await page.getByRole('heading', { name: '服务配置', exact: true }).waitFor();
    await page.locator('summary').filter({ hasText: '应用与存储' }).click();
    const count = page.getByLabel('解压文件数上限', { exact: true }); await count.waitFor(); const oldCount = Number(await count.inputValue()), draft = oldCount + 1;
    await count.fill(String(draft));
    const before = await api('/configuration'); assert.equal(before.status, 200);
    const concurrent = await api('/configuration', 'PATCH', { revision: before.body.data.revision, changes: { '/process/monitor_interval_seconds': cfg.process.monitor_interval_seconds + 1 } });
    assert.equal(concurrent.status, 200); assert.notEqual(concurrent.body.data.revision, before.body.data.revision);
    const conflict = page.waitForResponse(response => response.url().endsWith('/api/v1/configuration') && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: /保存配置（1 项）/ }).click(); const rejected = await conflict;
    assert.equal(rejected.status(), 409); assert.equal((await rejected.json()).code, 'CONFIG_REVISION_CONFLICT');
    verifiedResourceFailures.push({ url: rejected.url(), status: 409 });
    assert.equal(await count.inputValue(), String(draft)); assert.equal(read(configPath).storage.max_file_count, oldCount);
    await screenshot('configuration-real-cas-conflict'); report.cases.push('actual competing configuration writer triggers HTTP409; draft retained and disk unchanged by rejected save');
    await page.getByRole('button', { name: '放弃修改并重新读取', exact: true }).click();
    await page.waitForFunction(expected => document.getElementById('setting/storage/max_file_count')?.value === String(expected), oldCount);
    await count.fill(String(draft));
    const saved = page.waitForResponse(response => response.url().endsWith('/api/v1/configuration') && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: /保存配置（1 项）/ }).click(); assert.equal((await saved).status(), 200);
    await page.getByText('配置已保存。服务重启后生效，当前串流继续使用原配置。', { exact: true }).waitFor();
    assert.equal(read(configPath).storage.max_file_count, draft);
    const desired = await api('/configuration'), running = await api('/config');
    assert.equal(desired.body.data.restart_required, true); assert.equal(desired.body.data.values.storage.max_file_count, draft);
    assert.equal(running.body.data.storage.max_file_count, oldCount); report.cases.push('explicit reload and fresh CAS save persist real configuration; running/desired remain separate until restart');
    await screenshot('configuration-saved-desktop'); await page.setViewportSize({ width: 390, height: 844 }); await screenshot('configuration-saved-mobile');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await Promise.all(responseChecks);
    assert.deepEqual(javascriptErrors, []); assert.deepEqual(report.request_failures, []); assert.deepEqual(report.unexpected_http_errors, []);
    report.unexpected_console_errors = [];
    const unmatched = [...verifiedResourceFailures];
    for (const entry of report.console.filter(entry => entry.type === 'error')) {
      // Browser network diagnostics have no JS arguments. Application console.error
      // has an argument and a script location, and must never be exempted here.
      const resourceStatus = /^Failed to load resource: the server responded with a status of (404|409|500|503)(?: \([^\n]*\))?$/.exec(entry.text);
      const match = resourceStatus && entry.argument_count === 0
        ? unmatched.findIndex(request => request.url === entry.location.url && request.status === Number(resourceStatus[1])) : -1;
      if (match >= 0) { entry.verified_http_failure = unmatched.splice(match, 1)[0].status; }
      else report.unexpected_console_errors.push(entry);
    }
    assert.deepEqual(report.unexpected_console_errors, []);
    report.console_boundary = 'Only zero-argument browser resource errors matching one verified real response URL and status are allowed (404/409/503 unavailable/CAS, optional explicit missing-executable 500); warnings retained, unknown console.error and JavaScript exceptions fail.';
    report.cases.push('desktop/mobile screenshots; no horizontal page overflow'); report.passed = true;
  } catch (error) { report.error = sanitize(error.stack || error.message); }
  finally {
    if (componentCommands && child && child.exitCode === null && child.signalCode === null && serviceBase) {
      try {
        const cfg = read(configPath);
        const login = await fetch(serviceBase + '/api/v1/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: cfg.server.username, password: cfg.server.password }), signal: AbortSignal.timeout(3000) });
        const token = (await login.json()).data?.token; if (token) secrets.push(token);
        assert.ok(login.ok && token, 'Owned component cleanup login failed');
        const stopped = await fetch(serviceBase + '/api/v1/components/owned_runtime/stop', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) });
        assert.ok(stopped.ok, 'Owned component cleanup stop failed'); report.owned_component_cleanup_confirmed = true;
      } catch (error) { report.passed = false; report.cleanup_error = sanitize(error.message); }
    }
    if (browser) await browser.close().catch(error => { report.passed = false; report.cleanup_error = sanitize(error.message); });
    if (child && child.exitCode === null && child.pid) {
      child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(10000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]); }
      if (child.exitCode === null && child.signalCode === null) { report.passed = false; report.cleanup_error = 'Owned temporary process did not exit'; }
    }
    const database = path.join(workspace, 'state.sqlite');
    if (fs.existsSync(database)) { const data = fs.readFileSync(database); report.database = { format: data.subarray(0, 16).toString('binary'), bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }; if (report.database.format !== 'SQLite format 3\u0000') report.passed = false; }
    fs.writeFileSync(path.join(output, 'service.log'), sanitize(serviceLog));
    const resolved = fs.realpathSync(workspace), temporaryRoot = fs.realpathSync(os.tmpdir());
    assert.ok(path.dirname(resolved) === temporaryRoot && path.basename(resolved).startsWith('stream-kit-management-native-'), 'Refuse cleanup outside owned temporary directory');
    if (!report.cleanup_error) fs.rmSync(resolved, { recursive: true, force: true });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ passed: report.passed, engine, output })); if (!report.passed) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
