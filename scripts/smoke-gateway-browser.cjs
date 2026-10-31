// Validates release assets and the generated Rust/WASM ABI in the selected engine.
// Authentication responses are fixtures; this is not a streaming E2E test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const gateway = path.join(root, 'third_party/moonlight-web-stream');
const viewerAssets = process.argv[2] ? path.resolve(process.argv[2]) : path.join(gateway, 'dist');
const {engine,launchBrowser,evidenceDirectory} = require('./lib/test-browser.cjs');
const output = evidenceDirectory(path.join(root, 'artifacts/gateway-browser'));
const gatewayRequire = createRequire(path.join(gateway, 'package.json'));
const webpack = gatewayRequire('webpack');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, status: 'running', at: new Date().toISOString() }));
const entry = path.join(output, 'probe.ts');
fs.writeFileSync(entry, `
import { uniffiInitAsync, keyStatesEmpty, keyStatesSetPressed, keyStatesIsPressed, KeyAction, webrtcLinkHeaderParse } from ${JSON.stringify(path.join(gateway, 'web/uniffi/entry').replaceAll('\\', '/'))};
uniffiInitAsync().then(() => {
  const states = keyStatesSetPressed(keyStatesEmpty(), 65, KeyAction.Down);
  if (keyStatesIsPressed(states, 65) !== KeyAction.Down) throw new Error('Key-down ABI round trip failed');
  const released = keyStatesSetPressed(states, 65, KeyAction.Up);
  if (keyStatesIsPressed(released, 65) !== KeyAction.Up) throw new Error('Key-up ABI round trip failed');
  if (webrtcLinkHeaderParse('<stun:example.test:3478>; rel="ice-server"').length !== 1) throw new Error('ICE header ABI failed');
  document.body.dataset.ready = 'true';
});
`);

async function main() {
  const compiler = webpack({
    mode: 'production', context: gateway, entry,
    output: { path: path.join(output, 'probe'), filename: 'probe.js' },
    resolve: { extensions: ['.ts', '.js'] },
    module: { rules: [
      { test: /\.ts$/, loader: gatewayRequire.resolve('ts-loader'), options: { configFile: path.join(gateway, 'tsconfig.json'), onlyCompileBundledFiles: true } },
      { test: /\.wasm$/, type: 'asset/resource' },
    ] },
  });
  await new Promise((resolve, reject) => compiler.run((error, stats) => {
    compiler.close(closeError => {
      if (error || closeError || stats?.hasErrors()) reject(error || closeError || new Error(stats.toString({ all: false, errors: true })));
      else resolve();
    });
  }));
  const missing = [];
  let networkUnavailable = false;
  const server = http.createServer((req, res) => {
    // Deny the fixture origin itself as well: browser offline emulation does
    // not consistently intercept service-worker network requests in all engines.
    if (networkUnavailable) { req.socket.destroy(); return; }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/gateway/config.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end('window.__CONFIG_JS__ = {path_prefix:"/gateway",managed_streaming:false,control_plane_url:null};');
      return;
    }
    if (pathname === '/gateway/api/authenticate') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthenticated fixture' }));
      return;
    }
    if (pathname === '/bindings/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><body><script src="probe.js"></script></body></html>');
      return;
    }
    const base = pathname.startsWith('/gateway/') ? viewerAssets : path.join(output, 'probe');
    const filename = path.resolve(base, '.' + pathname.replace(/^\/(gateway|bindings)/, '') + (pathname.endsWith('/') ? 'index.html' : ''));
    const relative = path.relative(base, filename);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
      missing.push(pathname); res.writeHead(404); res.end(); return;
    }
    const type = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(filename)];
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', type || 'application/octet-stream');
    fs.createReadStream(filename).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const diagnostics = [];
  try {
    browser = await launchBrowser({defaultChannel:'chromium'});
    const errors = [];
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const pathname of ['index.html', 'admin.html', 'stream.html?hostId=1&appId=2']) {
      const page = await browser.newPage();
      page.on('console', message => diagnostics.push({page: pathname, type: message.type(), text: message.text()}));
      page.on('pageerror', error => errors.push(`${pathname}: ${error.message}`));
      await page.goto(`${origin}/gateway/${pathname}`);
      await page.locator('#ml-api-name').waitFor();
      await page.waitForLoadState('networkidle');
      if (pathname === 'index.html') {
        await page.evaluate(() => Promise.race([
          navigator.serviceWorker.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker activation timed out')), 15000)),
        ]));
        const cached = await page.evaluate(async () => {
          const entries = [];
          for (const key of await caches.keys()) {
            for (const req of await (await caches.open(key)).keys()) entries.push(new URL(req.url).pathname);
          }
          return entries;
        });
        assert.deepEqual(cached, ['/gateway/offline.html']);
        await page.waitForFunction(() => !!navigator.serviceWorker.controller);
        networkUnavailable = true;
        await page.context().setOffline(true);
        await page.goto(`${origin}/gateway/stream.html?hostId=1&appId=2`);
        await page.getByRole('heading', { name: '连接已断开' }).waitFor();
        networkUnavailable = false;
      }
      await page.close();
    }
    // Exercise the production viewer with capability-based admission. Only the
    // HTTP peers are fixtures; WASM, RTCPeerConnection and page startup are real.
    const viewer = await browser.newPage();
    assert.equal(await viewer.evaluate(() => typeof RTCPeerConnection), 'function',
      `${engine} runtime has no RTCPeerConnection; real SDP acceptance cannot run in this environment`);
    viewer.on('console', message => diagnostics.push({page: 'managed', type: message.type(), text: message.text()}));
    viewer.on('pageerror', error => errors.push(`managed viewer: ${error.message}`));
    const viewerCalls = [];
    const joined = { session_id: 'browser-session', host_id: 1, app_id: 2,
      revision: 1, control_epoch: 0, audio: {microphone_enabled: false},
      connection_token: 'browser-connection', connection: { connection_id: 'browser-client', role: 'viewer' } };
    const profile = { permissions: { allow_transport_webrtc: true, allow_transport_websockets: false,
      allow_add_hosts: false }, default_settings: { dataTransport: 'webrtc', microphone: false,
      enterFullscreenOnStreamStart: false } };
    await viewer.route('**/gateway/config.js', route => route.fulfill({ contentType: 'text/javascript',
      body: `window.__CONFIG_JS__ = ${JSON.stringify({ path_prefix: '/gateway', managed_streaming: true, control_plane_url: origin })};` }));
    await viewer.route('**/api/**', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const headers = request.headers();
      viewerCalls.push({ pathname, method: request.method(), headers, body: request.postData() });
      const reply = data => route.fulfill({ json: { status: 'ok', data } });
      if (pathname === '/api/v1/client-sessions/join') {
        assert.equal(headers.authorization, 'Bearer browser-invitation');
        return reply(joined);
      }
      if (pathname.startsWith('/api/v1/client-sessions/browser-session/connections/browser-client')) {
        assert.equal(headers.authorization, 'Bearer browser-connection');
        if (pathname.endsWith('/ticket')) return reply({ ticket: 'browser-media-ticket',
          expires_at: new Date(Date.now() + 60000).toISOString(), role: 'viewer' });
        return reply(joined);
      }
      assert.equal(headers['x-stream-media-ticket'], 'browser-media-ticket');
      assert.equal(headers.authorization, undefined);
      assert.equal(headers.cookie, undefined);
      if (pathname === '/gateway/api/host/stream/profile') return route.fulfill({ json: profile });
      if (pathname === '/gateway/api/host/stream/webrtc' && request.method() === 'OPTIONS') return route.fulfill({ status: 200 });
      if (pathname === '/gateway/api/host/stream/webrtc' && request.method() === 'POST') {
        assert.match(request.postData(), /m=video/);
        // Stop before an upstream connection: this fixture has no Sunshine.
        return route.fulfill({ status: 503, body: 'Upstream intentionally absent in browser fixture' });
      }
      throw new Error(`Unexpected managed request: ${request.method()} ${pathname}`);
    });
    const offer = viewer.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/gateway/api/host/stream/webrtc'));
    await viewer.goto(`${origin}/gateway/stream.html?hostId=1&appId=2#join=browser-invitation`);
    await offer;
    await viewer.screenshot({ path: path.join(output, 'managed-connecting.png') });
    await viewer.evaluate(() => window.app.getStream().stop());
    assert.equal(new URL(viewer.url()).hash, '', 'Admission fragment must be removed');
    assert.equal(await viewer.locator('#ml-api-name').count(), 0, 'No gateway account login');
    assert.ok(viewerCalls.some(call => call.method === 'DELETE'), 'Stopping releases the client connection');
    assert.ok(viewerCalls.every(call => !/\/authenticate$|\/login$|\/role$/.test(call.pathname)), 'No native account bootstrap');
    await viewer.close();
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(`bindings: ${error.message}`));
    await page.goto(`${origin}/bindings/`);
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    assert.deepEqual(errors, [], 'Browser errors');
    assert.deepEqual(missing.filter(url => url !== '/favicon.ico'), [], 'Missing built resources');
    const result = { passed: true, engine, browser: browser.version(), at: new Date().toISOString(),
      assets: Object.fromEntries(fs.readdirSync(viewerAssets).filter(name => /\.(js|wasm|html)$/.test(name)).map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(viewerAssets, name))).digest('hex')])),
      scope: 'Three production pages at a path prefix; offline navigation and cache isolation; release WASM initialization and Rust keyboard/ICE ABI; managed viewing link reaches a real browser SDP offer without gateway login and releases the connection. HTTP authentication/media responses are fixtures, no real upstream.' };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(output, 'diagnostics.json'), JSON.stringify({diagnostics, pages: []}, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    const pages = [];
    if (browser) for (const context of browser.contexts()) for (const page of context.pages()) {
      pages.push({url: page.url(), text: await page.locator('body').innerText().catch(() => ''),
        capabilities: await page.evaluate(() => ({peerConnection: typeof RTCPeerConnection, serviceWorker: !!navigator.serviceWorker?.controller})).catch(() => null)});
    }
    fs.writeFileSync(path.join(output, 'diagnostics.json'), JSON.stringify({diagnostics, pages}, null, 2));
    throw error;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => {
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, status: 'failed', at: new Date().toISOString(), error: error.message }, null, 2));
  console.error(error); process.exitCode = 1;
});
