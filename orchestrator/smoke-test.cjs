// Run against an isolated instance configured without Sunshine/Moonlight.
// PLAYWRIGHT_MODULE may point to an existing Playwright installation.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const root = path.resolve(__dirname, '..');
  const configPath = process.argv[2] || path.join(root, '.local/validation/config.json');
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(cfg.sunshine_api.base_url, '', 'Use an isolated instance with external integrations disabled');
  assert.equal(cfg.moonlight_web.base_url, '', 'Use an isolated instance with external integrations disabled');
  const base = `http://${cfg.server.bind_address}`;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/, 'Validation must use loopback');
  const output = path.join(root, 'artifacts/orchestrator');
  fs.mkdirSync(output, { recursive: true });
  const results = { scope: 'control plane only; media streaming is not tested', checks: [] };
  const health = await fetch(`${base}/api/v1/health`);
  assert.equal(health.status, 200);
  results.checks.push('health: 200');
  assert.equal((await fetch(`${base}/api/v1/apps`)).status, 401);
  results.checks.push('unauthenticated apps: 401');
  const login = await fetch(`${base}/api/v1/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.server.username, password: cfg.server.password }),
  });
  assert.equal(login.status, 200);
  const token = (await login.json()).data.token;
  assert.ok(token);
  const headers = { Authorization: `Bearer ${token}` };
  results.checks.push('login: 200');
  const name = `checkerboard-smoke-${Date.now()}`;
  const zip = path.join(root, 'artifacts/example/example.zip');
  const form = new FormData();
  form.set('name', name);
  form.set('args', '12 6');
  form.set('file', new Blob([fs.readFileSync(zip)], { type: 'application/zip' }), 'example.zip');
  const upload = await fetch(`${base}/api/v1/apps/upload`, { method: 'POST', headers, body: form });
  assert.equal(upload.status, 200);
  const id = (await upload.json()).data.app_id;
  let app;
  for (let attempt = 0; attempt < 100; attempt++) {
    app = (await (await fetch(`${base}/api/v1/apps/${id}`, { headers })).json()).data;
    if (['ready', 'error', 'register_failed'].includes(app.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(app.status, 'ready', app.error_message);
  const source = fs.readFileSync(path.join(root, 'artifacts/example/checkerboard.exe'));
  const extracted = fs.readFileSync(app.exe_path);
  assert.deepEqual(extracted, source, 'Uploaded executable differs after extraction');
  results.checks.push('example.zip upload, extraction, EXE detection and byte comparison: passed');
  results.uploadedExecutable = app.exe_path;
  results.appId = id;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    let wsConnected = false;
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => { if (socket.url().includes('/api/v1/ws')) wsConnected = true; });
    await page.goto(base, { waitUntil: 'networkidle' });
    assert.match(page.url(), /\/login$/);
    await page.locator('#username').fill(cfg.server.username);
    await page.locator('#password').fill(cfg.server.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${base}/`);
    await page.goto(`${base}/apps`, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name, exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'apps.png'), fullPage: true });
    await page.getByRole('link', { name, exact: true }).click();
    await page.waitForURL(`${base}/apps/${id}`);
    await page.getByText('checkerboard.exe', { exact: true }).waitFor();
    assert.equal(await page.locator('textarea').inputValue(), '12\n6');
    await page.screenshot({ path: path.join(output, 'example-detail.png'), fullPage: true });
    assert.deepEqual(errors, [], 'Browser runtime errors');
    assert.equal(wsConnected, true, 'Management WebSocket did not connect');
    results.checks.push('browser login, apps list, example detail and management WebSocket: passed');
    results.checks.push('browser uncaught errors: 0');
  } finally { if (browser) await browser.close(); }
  fs.writeFileSync(path.join(output, 'smoke-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
