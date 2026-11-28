const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');

const [manifestFile, resultFile, rawExit, mode] = process.argv.slice(2);
assert.ok(manifestFile && resultFile && /^\d+$/.test(rawExit) &&
  ['stage', 'resume', 'diagnostics'].includes(mode), 'Invalid guest report arguments');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifest = read(manifestFile);
const resultBytes = fs.readFileSync(resultFile);
const result = JSON.parse(resultBytes.toString('utf8'));
const exitCode = Number(rawExit);
assert.equal(result.commit, manifest.commit, 'Guest result source mismatch');
assert.equal(result.installer_sha256, manifest.file.sha256, 'Guest result installer mismatch');
assert.ok(
  (result.phase === 'awaiting_reboot' && mode === 'stage' && exitCode === 0 && result.passed === false) ||
  (result.phase === 'completed' && exitCode === 0 && result.passed === true) ||
  (result.phase === 'failed' && exitCode !== 0 && result.passed === false),
  'Acceptance exited without a valid result for its phase',
);
const report = {
  phase: result.phase,
  passed: result.passed,
  error: result.error ?? null,
  exit_code: exitCode,
  commit: result.commit,
  installer_source_commit: result.installer_source_commit,
  installer_sha256: result.installer_sha256,
  install_exit: result.install_exit,
  pre_reboot: result.pre_reboot,
  post_reboot: result.post_reboot,
  admin_login: result.admin_login,
  defaults_preserved: result.defaults_preserved,
  audio_default_observations: result.audio_default_observations,
  pcm_frames: result.pair?.captured_frames,
  pcm_dropped: result.pair?.target?.dropped_frames,
  scm_restarted: result.scm_restarted,
  gateway_restarted: result.gateway_restarted,
  uninstall_exit: result.uninstall_exit,
  service_removed: result.service_removed,
  data_preserved: result.data_preserved,
  reboot_checkpoint_sha256: result.phase === 'awaiting_reboot'
    ? createHash('sha256').update(resultBytes).digest('hex')
    : result.checkpoint_sha256,
  cleanup_stage: result.cleanup_stage,
  cleanup_error: result.cleanup_error,
  lan_address_change: result.lan_address_change,
  diagnostics: mode === 'diagnostics' ? JSON.parse(fs.readFileSync(0, 'utf8')) : null,
};
if (report.diagnostics && result.runtime_startup_failure) {
  report.diagnostics.runtime_startup = result.runtime_startup_failure;
}
const diagnoseInit = mode === 'stage' && result.phase === 'failed' && ![0, 3010].includes(result.install_exit);
const payload = Buffer.from(JSON.stringify(report), 'utf8').toString('base64');
console.log(`${result.phase} ${Number(diagnoseInit)} ${payload}`);
