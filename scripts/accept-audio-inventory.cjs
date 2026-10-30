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
    assert.equal(await page.getByText('设备当前不可见', { exact: true }).count(), configuredRoutes.length * 2);
    await page.locator('summary').filter({ hasText: '全部设备与标识' }).click();
    await page.screenshot({ path: path.join(output, 'audio-devices-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(output, 'audio-devices-narrow.png'), fullPage: true });
    await delay(1200);
    assert.equal(reads, 1, 'Device enumeration unexpectedly polled');
    const token = await page.evaluate(() => localStorage.getItem('auth_token'));
    const command = async (resource,method,body,status=200) => {
      const response=await fetch(origin+'/api/v1'+resource,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
      assert.equal(response.status,status); return response.json();
    };
    const created=(await command('/stream-sessions','POST',{host_id:1,app_id:2})).data;
    await page.locator('nav a[href="/stream-sessions"]').click();
    await page.getByLabel('发送方式',{exact:true}).selectOption('disabled');
    const saveResponse=page.waitForResponse(response => response.request().method()==='PATCH' && new URL(response.url()).pathname.endsWith('/audio-target'));
    await page.getByRole('button',{name:'保存并应用目标'}).click();
    const saved=await saveResponse; assert.equal(saved.status(),200);
    const changed=(await saved.json()).data;
    assert.equal(changed.audio.target.mode,'disabled');
    assert.ok(changed.audio.target.epoch>created.audio.target.epoch);
    await page.getByRole('button',{name:'重新应用目标'}).waitFor();
    await command(`/stream-sessions/${created.session_id}/audio-target`,'PATCH',{
      expected_epoch:created.audio.target.epoch,target:{mode:'upstream',render_device_id:'',capture_device_id:''},
    },409);
    await command(`/stream-sessions/${created.session_id}/audio-target`,'PATCH',{
      expected_epoch:changed.audio.target.epoch,target:{mode:'local',render_device_id:'not-present-render',capture_device_id:'not-present-capture'},
    },400);
    let observation;
    for(let i=0;i<20;i++) {
      const response=await fetch(origin+'/api/v1/media-control',{headers:{Authorization:`Bearer ${token}`}});
      const status=(await response.json()).data;
      observation=status.observations?.[created.session_id];
      if(status.observations_valid && observation?.microphone_target.epoch===changed.audio.target.epoch)break;
      await delay(100);
    }
    assert.equal(observation?.microphone_target.epoch,changed.audio.target.epoch);
    assert.equal(observation.microphone_target.state,'idle','Unstarted application must not claim an open device');
    await page.screenshot({path:path.join(output,'audio-target-management.png'),fullPage:true});
    assert.deepEqual(errors, []);
    return {
      passed: true, browser: browser.version(), device_count: inventory.devices.length,
      control_sha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
      web_assets_sha256: Object.fromEntries(fs.readdirSync(path.join(scratch, 'dist/assets')).map(name => [name,
        crypto.createHash('sha256').update(fs.readFileSync(path.join(scratch, 'dist/assets', name))).digest('hex')])),
      checks: ['real management login', 'anonymous denied', 'Go to Rust authenticated inventory', 'actual OS device enumeration',
        configuredRoutes.length ? 'missing configured endpoints visible' : 'no configured target shown', 'explicit refresh without polling', 'desktop and narrow viewport without overflow',
        'real browser target update', 'stale target command rejected', 'missing endpoint selection rejected', 'gateway acknowledgement binds target epoch without inventing device open'],
      scope: 'Native device enumeration through real gateway, control process and production browser. No audio stream open or recording.',
    };
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null) child.kill();
    await exited;
  }
};
