'use strict';

// The browser and HTTPS probes run outside the Windows guest, on its TAP LAN.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const {execFileSync, spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const {setTimeout: delay} = require('node:timers/promises');

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.platform, 'linux');
const [folder, output] = process.argv.slice(2);
const network = JSON.parse(fs.readFileSync(path.join(folder, 'network.json')));
const ca = fs.readFileSync(path.join(folder, 'ca.crt'));
const report = {passed:false, network};
const save = () => fs.writeFileSync(path.join(output, 'windows-lan-client.json'), JSON.stringify(report, null, 2) + '\n');

function tls(address, port, resource, obsolete) {
  return new Promise((resolve, reject) => {
    const req = https.get({hostname:address, port, path:resource, ca, localAddress:network.client_address, agent:false}, res => {
      const peer = res.socket.getPeerCertificate();
      res.resume();
      try {
        assert.equal(res.statusCode, 200);
        assert.equal(res.socket.remoteAddress, address);
        const cert = new crypto.X509Certificate(peer.raw);
        assert.equal(cert.checkIP(address), address);
        assert.equal(cert.checkIP(obsolete), undefined);
        resolve({address, port, leaf_fingerprint:cert.fingerprint256, obsolete_ip_absent:true});
      } catch (error) { reject(error); }
    });
    req.on('error', reject);
    req.setTimeout(2500, () => req.destroy(Error('TLS probe timed out')));
  });
}

const browser = spawn(process.execPath, ['tools/network-acceptance/browser.cjs'], {stdio:['pipe','pipe','ignore']});
const events = createInterface({input:browser.stdout})[Symbol.asyncIterator]();
browser.on('error', () => {});
browser.stdin.on('error', () => {});
process.once('SIGTERM', () => {
  browser.stdin.end();
  browser.kill('SIGTERM');
  server.closeAllConnections();
  server.close();
});
let sequence = 0;
async function ask(message) {
  const id = ++sequence;
  browser.stdin.write(JSON.stringify({...message,id}) + '\n');
  const line = await events.next();
  assert.equal(line.done, false, 'Independent browser exited');
  const response = JSON.parse(line.value);
  assert.equal(response.id, id);
  if (response.error) {
    report.browser_failure = response.state;
    throw Error(response.error);
  }
  return response.result;
}

let hostname, state = 'before';
async function observe(address, obsolete) {
  let lastFailure = 'no probe response';
  const start = Date.now();
  while (Date.now()-start < 80000) {
    try {
      const resolved = execFileSync('avahi-resolve-host-name', ['-4',hostname], {encoding:'utf8',timeout:4000,stdio:['ignore','pipe','pipe']}).trim();
      assert.equal(resolved, hostname+'\t'+address, 'mDNS did not return the current guest address');
      const listeners = await Promise.all([
        tls(address, 19000, '/api/v1/health', obsolete),
        tls(address, 18080, '/config.js', obsolete),
      ]);
      assert.equal(listeners[0].leaf_fingerprint, listeners[1].leaf_fingerprint);
      return {resolved, listeners, observed_after_ms:Date.now()-start};
    } catch (error) {
      lastFailure = error.message.split('\n', 1)[0];
      await delay(400);
    }
  }
  throw Error('Guest mDNS or HTTPS not ready: '+lastFailure);
}
function verifyMedia(media, ipv4) {
  assert.equal(media.remote_address, ipv4);
  assert.deepEqual(media.remote_host_addresses, [ipv4]);
  assert.ok(media.remote_port >= 51000 && media.remote_port <= 51100);
  assert.ok(media.frames >= 30 && media.audio_packets > 0);
}

let busy = false;
const server = http.createServer(async (req, res) => {
  const expectedPeer = state === 'before' ? network.old_address : network.new_address;
  if (busy || req.method !== 'POST' || req.url !== '/'+state || req.socket.remoteAddress !== expectedPeer) {
    req.resume(); res.writeHead(409).end(); return;
  }
  busy = true;
  report.stage = state;
  try {
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      assert.ok(text.length <= 2048, 'Oversized guest fixture message');
    }
    if (state === 'before') {
      const message = JSON.parse(text);
      assert.match(message.hostname, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/);
      assert.ok(typeof message.watch === 'string' && /^\/watch#key=[A-Za-z0-9_-]+$/.test(message.watch),
        'Guest did not provide a permanent viewing path');
      hostname = message.hostname;
      report.before = await observe(network.old_address, network.new_address);
      save();
      report.before.media = await ask({action:'start', hostname,
        url:new URL(message.watch,`https://${hostname}:19000`).href, address:network.old_address});
      verifyMedia(report.before.media, network.old_address);
      state = 'after';
    } else {
      report.after = await observe(network.new_address, network.old_address);
      assert.notEqual(report.after.listeners[0].leaf_fingerprint, report.before.listeners[0].leaf_fingerprint);
      save();
      report.after.media = await ask({action:'recover', address:network.new_address});
      verifyMedia(report.after.media, network.new_address);
      await ask({action:'close'});
      report.same_page_recovered = true;
      report.passed = true;
      state = 'done';
      browser.stdin.end();
    }
    save();
    res.writeHead(204).end();
    if (state === 'done') server.close();
  } catch (error) {
    report.error = error.message.split('\n', 1)[0];
    save();
    res.writeHead(500).end();
    browser.stdin.end();
    server.close();
    process.exitCode = 1;
  } finally { busy = false; }
});
server.once('error', error => { report.error=error.code; save(); browser.stdin.end(); process.exitCode=1; });
server.listen(18410, network.client_address);
