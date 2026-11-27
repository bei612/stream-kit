'use strict';

// Exercises the operator tool on a disposable installed Windows service.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {once} = require('node:events');
const {RuntimeMaintenance, execute, serviceStartTimeout, endpointPolicyVersion} = require('../maintain-windows-runtime.cjs');

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function configureTLS(program, data, origin, openssl) {
  const control = path.join(program, 'orchestrator', 'orchestrator.exe');
  const config = path.join(data, 'orchestrator.json');
  const gateway = path.join(data, 'gateway', 'config.json');
  const settings = read(config), media = read(gateway);
  const gatewayURL = new URL(settings.moonlight_web.base_url);
  assert.equal(gatewayURL.hostname, '127.0.0.1');
  assert.equal(settings.server.bind_address, `${origin.hostname}:${origin.port}`);
  execute(control, ['service', 'stop', '--config', config]);

  const caCert = path.join(data, 'rollback-fixture-ca.crt');
  const caKey = path.join(data, 'rollback-fixture-ca.key');
  const leafCert = path.join(data, 'gateway', 'rollback-fixture-server.crt');
  const leafKey = path.join(data, 'gateway', 'rollback-fixture-server.key');
  execute(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '35',
    '-subj', '/CN=Stream Kit hosted rollback fixture', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKey, '-out', caCert]);
  settings.server.tls_cert = leafCert;
  settings.server.tls_key = leafKey;
  settings.server.lan_tls = {ca_cert: caCert, ca_key: caKey, hosts: ['localhost', '127.0.0.1']};
  gatewayURL.protocol = 'https:';
  settings.moonlight_web.base_url = gatewayURL.origin;
  settings.components.web_server.health_check.url = new URL('/stream.html', gatewayURL).href;
  media.web_server.control_plane_url = origin.origin;
  media.web_server.certificate = {certificate_pem: leafCert, private_key_pem: leafKey};
  media.web_server.session_cookie_secure = true;
  fs.writeFileSync(config, JSON.stringify(settings));
  fs.writeFileSync(gateway, JSON.stringify(media));
  // Production startup issues the leaf and the Node maintenance client loads
  // this fixture CA from configuration. No machine trust store is changed.
  execute(control, ['service', 'start', '--config', config], undefined, serviceStartTimeout);
  return [caCert, caKey, leafKey];
}

class PortConflictMaintenance extends RuntimeMaintenance {
  async startService() {
    if (this.report.step !== 'starting_service') return super.startService();
    const listener = net.createServer(socket => socket.destroy());
    try {
      const bound = once(listener, 'listening');
      listener.listen({host: this.origin.hostname, port: Number(this.origin.port), exclusive: true});
      await bound;
      this.portReserved = true;
      await super.startService();
    } finally {
      if (listener.listening) await new Promise(resolve => listener.close(resolve));
    }
  }
}

async function verifyWindowsMaintenance({program, data, output, candidate, candidateCommit, openssl, example, control, request, baselineCommit}) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.match(candidateCommit, /^[a-f0-9]{40}$/);
  assert.notEqual(candidateCommit, baselineCommit, 'Select two distinct immutable runtime builds');

  const origin = new URL(control);
  assert.equal(origin.hostname, '127.0.0.1');
  origin.protocol = 'https:';
  const registration = await request('/apps/local', 'POST', {
    name: 'Windows maintenance Example', exe_path: example, working_dir: path.dirname(example), capture_mode: 'desktop',
  });
  assert.match(registration.id, /^[a-zA-Z0-9-]+$/);
  const watchPath = `/apps/${registration.id}/watch-link`;
  const before = await request(watchPath, 'POST');
  assert.ok(before.enabled && /^\/watch#key=[A-Za-z0-9_-]+$/.test(before.path), 'Baseline viewing link unavailable');

  const trustFiles = configureTLS(program, data, origin, openssl);
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const trustBefore = trustFiles.map(digest);
  const result = path.join(output, 'maintenance-result.json');
  const maintenance = new PortConflictMaintenance({
    '--platform': candidate, '--program-dir': program, '--data-dir': data, '--origin': origin.href,
    '--expected-commit': candidateCommit, '--result': result, '--apply': true,
  });
  await assert.rejects(maintenance.run(), /Runtime maintenance failed/);
  const record = read(result);
  assert.equal(maintenance.portReserved, true, 'Candidate control socket was not reserved by the fixture');
  assert.equal(record.failed_step, 'starting_service');
  assert.equal(record.command_failure?.executable, 'orchestrator.exe');
  assert.ok(Number.isInteger(record.command_failure?.exit_code) && record.command_failure.exit_code !== 0,
    'The native candidate service start must return a real failure');
  assert.equal(record.success, false);
  assert.equal(record.rollback, true);
  assert.equal(record.previous_source, baselineCommit);
  assert.equal(record.source, candidateCommit);
  const endpointPolicyChanged = endpointPolicyVersion(program) !== endpointPolicyVersion(candidate);
  if (endpointPolicyChanged) {
    assert.equal(record.audio_policy_migrated, true, 'Candidate endpoint policy was not applied before service startup');
    assert.equal(record.audio_policy_rolled_back, true, 'Baseline endpoint policy was not restored');
  }
  const health = await maintenance.api('/health');
  assert.equal(health.commit, baselineCommit);
  assert.ok(['sunshine', 'web_server'].every(name => health.components[name]?.status === 'running'));
  const after = await maintenance.api(watchPath);
  assert.ok(after.enabled && after.path === before.path, 'The original viewing link did not survive rollback');
  assert.deepEqual(trustFiles.map(digest), trustBefore, 'Deployment trust changed during rollback');
  return {passed: true, baseline_commit: baselineCommit, candidate_commit: candidateCommit,
    real_listener_conflict: true, original_runtime_ready: true, original_watch_link_preserved: true,
    ca_and_private_keys_preserved: true, machine_trust_changed: false,
    endpoint_policy_migrated_and_restored: endpointPolicyChanged};
}

module.exports = {verifyWindowsMaintenance};
