// Validate executed acceptance cases, not just the test process's exit status.
const assert = require('node:assert/strict');
const fs = require('node:fs');

const profiles = {
  capture: [
    'LinuxApplicationAudio.RejectsMissingTargetAndUnsupportedLayout',
    'LinuxApplicationAudio.RealMonitorExcludesUnownedAudioAndStopsOnRetirement',
    'LinuxCaptureTargetTest.BindsOnlyTheIsolatedLaunchAndRejectsUnrelatedProcesses',
    'LinuxCaptureTargetTest.RetainsKnownMembersAfterLauncherExitAndRejectsRetiredTargets',
    'LinuxCaptureTargetTest.RejectsProcessesThatLeaveTheLaunchGroup',
    'LinuxCaptureTargetTest.DoesNotReopenDeadIdentitiesByNumericPid',
    'LinuxCaptureTargetTest.IsolatesOwnedWindowPixelsAndInputUntilRetirement',
  ],
  management: [
    'ConfigHttpTest.CaptureCapabilitiesRequireAuthentication',
    'ConfigHttpTest.CaptureCapabilitiesExposeVersionedApplyPolicy',
    'ManagedAppsHttpTest.ApplicationModeSaveMatchesAdvertisedCapabilityAndLaunchRules',
  ],
};

function verify(report, profile) {
  const required = profiles[profile];
  assert.ok(required, 'Unknown acceptance profile');
  for (const field of ['failures', 'disabled', 'errors']) assert.equal(report[field], 0, field);
  assert.ok(Array.isArray(report.testsuites), 'Missing test suites');
  const cases = new Map();
  for (const suite of report.testsuites) {
    assert.ok(Array.isArray(suite.testsuite), 'Missing test cases');
    for (const test of suite.testsuite) {
      const name = `${suite.name}.${test.name}`;
      assert.ok(!cases.has(name), `Duplicate case: ${name}`);
      assert.equal(test.status, 'RUN', `Case did not run: ${name}`);
      assert.equal(test.result, 'COMPLETED', `Case was skipped: ${name}`);
      assert.ok(!test.failures?.length, `Case failed: ${name}`);
      cases.set(name, test);
    }
  }
  assert.equal(report.tests, cases.size, 'Summary count disagrees with executed cases');
  for (const name of required) assert.ok(cases.has(name), `Missing required case: ${name}`);
  return cases.size;
}

module.exports = {verify};
if (require.main === module) {
  try {
    const count = verify(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), process.argv[3]);
    console.log(`Native ${process.argv[3]} acceptance: ${count} executed cases verified`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
