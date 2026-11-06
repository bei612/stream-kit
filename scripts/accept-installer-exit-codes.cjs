// Executes the production Inno exit-code handler in private, non-admin setup
// fixtures. No services, drivers, registry entries or application files change.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
assert.equal(process.platform, 'win32');
assert.equal(process.argv.length, 4, 'Expected ISCC OUTPUT_DIRECTORY');
const compiler = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
assert.ok(!fs.existsSync(output), 'Use a new fixture directory');
const source = fs.readFileSync(path.join(__dirname, '../deploy/windows/stream-kit.iss'), 'utf8');
const handler = source.match(/^function GetCustomSetupExitCode: Integer;\r?\n[\s\S]*?^end;/m)?.[0];
assert.ok(handler, 'Production exit-code handler missing');
fs.mkdirSync(output, {recursive: true});
const results = [];
for (const [name, code, statements] of [
  ['failed', 1, "RaiseException('Fixture post-install failure');"],
  ['ready', 0, 'PlatformSetupCompleted := True;'],
  ['restart', 3010, 'AudioDriverRestartRequired := True; PlatformSetupCompleted := True;'],
]) {
  const script = `[Setup]
AppName=Stream Kit installer outcome fixture
AppVersion=1.0
DefaultDirName={tmp}\\StreamKitOutcomeFixture
CreateAppDir=no
Uninstallable=no
CreateUninstallRegKey=no
PrivilegesRequired=lowest
DisableWelcomePage=yes
DisableReadyPage=yes
CloseApplications=no
RestartApplications=no
OutputDir=${output}
OutputBaseFilename=${name}
[Code]
var PlatformSetupCompleted, AudioDriverRestartRequired: Boolean;
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    ${statements}
  end;
end;
${handler}
`;
  const file = path.join(output, name + '.iss');
  fs.writeFileSync(file, script);
  const built = cp.spawnSync(compiler, ['/Q', file], {encoding: 'utf8', windowsHide: true, timeout: 60000});
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const run = cp.spawnSync(path.join(output, name + '.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/SP-', '/NORESTART', '/LOG=' + path.join(output, name + '.log')], {encoding: 'utf8', windowsHide: true, timeout: 30000});
  results.push({name, expected: code, actual: run.status});
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({passed: results.every(r => r.expected === r.actual), results}, null, 2));
  assert.equal(run.status, code, name + ': ' + (run.error?.message || run.stderr));
}
console.log(JSON.stringify({passed: true, results}));
