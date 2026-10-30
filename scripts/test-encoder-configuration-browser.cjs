// Built native settings page with controlled API failures; no encoder process is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const gatewayRequire = createRequire(path.resolve('third_party/moonlight-web-stream/package.json'));
const { chromium } = gatewayRequire('playwright');

async function run() {
  const root = path.resolve('.local/cmake-build-sunshine/assets/web');
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  let reply = { status: 500, body: { status: false, committed: false, error: 'Encoder configuration persistence failed' } };
  let posts = 0;
  let expectedRevision = '"initial"';
  let readFailed = false;
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'encoder.test') return route.abort();
      if (url.pathname.startsWith('/api/')) {
        let body = {};
        if (url.pathname === '/api/configLocale') body = { locale: 'en' };
        if (url.pathname === '/api/config') {
          if (route.request().method() === 'POST') {
            posts++;
            assert.equal(route.request().headers()['if-match'], expectedRevision);
            assert.equal(typeof route.request().postDataJSON(), 'object');
            return route.fulfill({ status: reply.status, headers: { ETag: '"next"' }, contentType: 'application/json', body: JSON.stringify(reply.body) });
          }
          if (readFailed) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
          body = { status: true, platform: 'windows', version: 'test' };
          return route.fulfill({ headers: { ETag: '"initial"' }, contentType: 'application/json', body: JSON.stringify(body) });
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      }
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
      return route.fulfill({ path: file, contentType: types[path.extname(file)] || 'application/octet-stream' });
    });
    await page.goto('http://encoder.test/config.html');
    const save = page.getByRole('button', { name: 'Save', exact: true });
    await save.waitFor();
    await save.click();
    const alert = page.locator('#content [role="alert"]');
    await alert.getByText('Encoder configuration persistence failed', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Apply', exact: true }).count(), 0);

    reply = { status: 200, body: { status: false } };
    await save.click();
    await alert.getByText('Encoder configuration save was not confirmed.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Apply', exact: true }).count(), 0);

    reply = { status: 500, body: { status: false, committed: true } };
    await save.click();
    await alert.getByText(/Reload before retrying/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Apply', exact: true }).count(), 0);

    reply = { status: 412, body: { status: false, error: 'Configuration changed; reload before saving' } };
    await page.locator('#sunshine_name').fill('Unsaved editor change');
    await save.click();
    await alert.getByText('Configuration changed; reload before saving', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Apply', exact: true }).count(), 0);
    assert.equal(await page.locator('#sunshine_name').inputValue(), 'Unsaved editor change');

    reply = { status: 200, body: { status: true, apply_policy: 'encoder_restart' } };
    await save.click();
    await page.getByRole('button', { name: 'Apply', exact: true }).waitFor();
    assert.equal(await alert.count(), 0);
    expectedRevision = '"next"';
    await save.click();
    await page.getByRole('button', { name: 'Apply', exact: true }).waitFor();
    assert.equal(posts, 6);
    readFailed = true;
    await page.reload();
    await alert.getByText(/Unable to read a versioned encoder configuration/).waitFor();
    assert.equal(await save.count(), 0);
    assert.deepEqual(errors, []);
    const output = 'artifacts/encoder-configuration';
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'browser-result.json'), JSON.stringify({ passed: true, scope: 'Built settings page, mocked API save outcomes; no restart invoked', posts, finished_at: new Date().toISOString() }, null, 2));
    console.log('Built encoder configuration page save acknowledgement checks passed');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
