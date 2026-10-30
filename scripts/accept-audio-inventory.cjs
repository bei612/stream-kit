// Called by the real gateway contract smoke with a newly built control binary.
// Only enumerates devices: never opens audio streams or starts rendering apps.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createRequire } = require('node:module');

module.exports = async function acceptAudioInventory({ root, binary, gatewayURL, secret, output, configuredRoutes }) {
  binary = path.resolve(binary);
  const scratch = fs.mkdtempSync(path.join(root, '.local/audio-inventory-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const credentials = { username: 'admin', password: crypto.randomBytes(32).toString('base64url') };
  const config = {
    server: { bind_address: `127.0.0.1:${port}`, ...credentials, jwt_secret: crypto.randomBytes(32).toString('hex'), media_ticket_secret: secret },
    components: {}, sunshine_api: { base_url: '' }, moonlight_web: { base_url: gatewayURL },
    storage: { apps_dir: 'apps', temp_dir: 'temp', db_path: 'control.db', max_upload_size_bytes: 10485760 },
    process: { monitor_interval_seconds: 2, graceful_shutdown_timeout_seconds: 2 },
    log: { level: 'info', file: { enabled: false }, access_log: { enabled: false } },
  };
  const configFile = path.join(scratch, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  fs.cpSync(path.join(root, 'orchestrator/web/dist'), path.join(scratch, 'dist'), { recursive: true });
  const log = fs.openSync(path.join(output, 'audio-inventory-control.log'), 'w');
  const child = spawn(binary, ['--config', configFile], { cwd: scratch, windowsHide: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  const exited = once(child, 'exit');
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      assert.equal(child.exitCode, null, 'Control process exited');
      try { ready = (await fetch(origin + '/api/v1/health', { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, 'Control process not ready');
    assert.equal((await fetch(origin + '/api/v1/audio-devices')).status, 401);
    const { chromium } = createRequire(path.join(root, 'third_party/moonlight-web-stream/package.json'))('playwright');
    browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let reads = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/v1/audio-devices') reads++; });
    await page.goto(origin + '/login');
    await page.getByLabel('用户名').fill(credentials.username);
    await page.getByLabel('密码', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: '登录控制台' }).click();
    await page.locator('nav a[href="/settings"]').click();
    await page.getByRole('button', { name: '读取设备', exact: true }).waitFor();
    assert.equal(reads, 0, 'Enumeration must be on explicit demand');
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/audio-devices');
    await page.getByRole('button', { name: '读取设备', exact: true }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    assert.equal(response.headers()['cache-control'], 'no-store');
    const inventory = (await response.json()).data;
    assert.deepEqual(inventory.configured_routes, configuredRoutes);
    assert.ok(Array.isArray(inventory.devices));
    await page.getByText(`${inventory.devices.length} 个设备 · ${configuredRoutes.length} 个应用绑定`, { exact: true }).waitFor();
    assert.equal(await page.getByText('设备当前不可见', { exact: true }).count(), 2);
    await page.locator('summary').filter({ hasText: '全部设备与标识' }).click();
    await page.screenshot({ path: path.join(output, 'audio-devices-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(output, 'audio-devices-narrow.png'), fullPage: true });
    await delay(1200);
    assert.equal(reads, 1, 'Device enumeration unexpectedly polled');
    assert.deepEqual(errors, []);
    return {
      passed: true, browser: browser.version(), device_count: inventory.devices.length,
      control_sha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
      web_assets_sha256: Object.fromEntries(fs.readdirSync(path.join(scratch, 'dist/assets')).map(name => [name,
        crypto.createHash('sha256').update(fs.readFileSync(path.join(scratch, 'dist/assets', name))).digest('hex')])),
      checks: ['real management login', 'anonymous denied', 'Go to Rust authenticated inventory', 'actual OS device enumeration',
        'missing configured endpoints visible', 'explicit refresh without polling', 'desktop and narrow viewport without overflow'],
      scope: 'Native device enumeration through real gateway, control process and production browser. No audio stream open or recording.',
    };
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null) child.kill();
    await exited;
  }
};
