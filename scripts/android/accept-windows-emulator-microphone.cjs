'use strict';

// Independent Windows guest AudioRecord reference. Optionally stages the signed
// candidate in a fresh, separate guest for subsequent product verification.
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {execFile, spawn} = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {promisify, parseArgs} = require('node:util');
const {setTimeout: delay} = require('node:timers/promises');

const exec = promisify(execFile);
const {values: args} = parseArgs({options: {
  observer: {type: 'string'}, output: {type: 'string'}, 'emulator-dir': {type: 'string'},
  'candidate-directory': {type: 'string'}, 'source-commit': {type: 'string'},
}});
assert.equal(process.platform, 'win32');
assert.ok(args.observer && args.output);
const sdk = path.join(process.env.LOCALAPPDATA, 'Android/Sdk');
const emulatorDir = path.resolve(args['emulator-dir'] || path.join(sdk, 'emulator'));
const emulator = path.join(emulatorDir, 'emulator.exe');
const adb = path.join(sdk, 'platform-tools/adb.exe');
const candidateRoot = args['candidate-directory'] && path.resolve(args['candidate-directory']);
assert.equal(Boolean(candidateRoot), Boolean(args['source-commit']));
const avd = candidateRoot ? 'StreamKit_AudioFixture' : 'StreamKit_API_36';
const serial = 'emulator-5582', controlPort = 8556;
const observer = 'io.github.bei612.streamkit.inputobserver';
const product = 'io.github.bei612.streamkit';
const output = path.resolve(args.output), apk = path.resolve(args.observer);
const summary = {platform: 'Windows 11 x64', disposable_read_only_avd: avd, passed: false,
  started_at: new Date().toISOString(), product_app_modified: false};

async function run(command, parameters, timeout = 8000, env = process.env) {
  try { return (await exec(command, parameters, {timeout, encoding: 'utf8', windowsHide: true, env})).stdout; }
  catch (error) {
    const diagnostic = Error('Required fixture command failed');
    diagnostic.code = error.killed ? 'COMMAND_TIMEOUT' : Number.isInteger(error.code) ? `EXIT_${error.code}` : error.code;
    throw diagnostic;
  }
}
const guest = (...commands) => run(adb, ['-s', serial, ...commands]);

async function installObserver() {
  const options = {timeout: 45000, encoding: 'utf8', windowsHide: true};
  const install = () => exec(adb, ['-s', serial, 'install', '-r', '-t', apk], options);
  try {
    assert.match((await install()).stdout, /^Success\r?$/m);
  } catch (error) {
    const details = String(error.stdout || '') + String(error.stderr || '');
    summary.observer_install_failure = details.match(/\bINSTALL_(?:FAILED|PARSE_FAILED)_[A-Z_]+\b/)?.[0]
      || (error.killed ? 'ADB_INSTALL_TIMEOUT' : 'ADB_INSTALL_FAILED');
    // A previous read-only run may have a test observer with another test key
    // in its base image. Retire that package only in this disposable guest.
    if (summary.observer_install_failure !== 'INSTALL_FAILED_UPDATE_INCOMPATIBLE') throw error;
    const state = await guest('shell', 'dumpsys', 'package', observer);
    assert.match(state, /^\s*(?:pkgFlags|flags)\s*=\s*\[[^\r\n\]]*\bTEST_ONLY\b/m);
    assert.match(await guest('uninstall', observer), /^Success\r?$/m);
    assert.match((await install()).stdout, /^Success\r?$/m);
    summary.disposable_observer_replaced = true;
  }
  summary.observer_installed = true;
}

async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const socket = net.createServer().once('error', reject);
    socket.listen(port, '127.0.0.1', () => socket.close(resolve));
  });
}

function discoveryToken(started) {
  const names = [...new Set([path.join(os.tmpdir(), 'avd/running'),
    path.join(process.env.LOCALAPPDATA, 'Temp/avd/running')])];
  const matching = [];
  for (const directory of names) {
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      if (!entry.isFile() || !/^pid_\d+(?:_info)?\.ini$/.test(entry.name)) continue;
      const file = path.join(directory, entry.name), stat = fs.statSync(file);
      if (stat.mtimeMs < started || stat.size > 65536) continue;
      const data = fs.readFileSync(file, 'utf8');
      if (!/^grpc.port=8556\r?$/m.test(data) || !data.split(/\r?\n/).includes(`avd.id=${avd}`)) continue;
      const credential = data.match(/^grpc.token=(.+)$/m)?.[1].trim();
      if (credential) matching.push(credential);
    }
  }
  assert.ok(matching.length <= 1, 'Multiple emulator discovery entries matched');
  return matching[0];
}

async function provisionFreshAvd(environment) {
  // The AVD location is supplied only via the child's SDK environment.
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const command = "$manager = Join-Path $env:ANDROID_HOME 'cmdline-tools/23.0/bin/avdmanager.bat'\n"
    + "'no' | & $manager create avd --name StreamKit_AudioFixture --package 'system-images;android-36;google_apis;x86_64' --device pixel_6\n"
    + 'exit $LASTEXITCODE';
  await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], 45000, environment);
  assert.ok(fs.statSync(path.join(environment.ANDROID_AVD_HOME, `${avd}.ini`)).isFile());
}

async function installSignedCandidate(environment) {
  const provenance = JSON.parse(fs.readFileSync(path.join(candidateRoot, 'provenance.json'), 'utf8'));
  const signing = require('../../third_party-manifests/android-signing.json');
  assert.match(args['source-commit'], /^[a-f0-9]{40}$/);
  assert.equal(provenance.source_commit, args['source-commit']);
  assert.equal(provenance.schema_version, 1);
  assert.equal(provenance.application_id, product);
  assert.equal(provenance.kind, 'signed-release-candidate');
  assert.match(provenance.version, /^\d+\.\d+\.\d+$/);
  assert.ok(Number.isSafeInteger(provenance.version_code) && provenance.version_code > 0);
  const file = path.join(candidateRoot, `stream-kit-android-${provenance.version}.apk`);
  const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(digest, provenance.apk_sha256);
  const tools = path.join(sdk, 'build-tools/37.0.0');
  const verified = await run(path.join(environment.JAVA_HOME, 'bin/java.exe'),
    ['-jar', path.join(tools, 'lib/apksigner.jar'), 'verify', '--verbose', '--print-certs', file], 20000, environment);
  const expected = signing.certificate_sha256.replace(/[\s:]/g, '').toLowerCase();
  assert.equal(provenance.signing_certificate_sha256, expected);
  const {verifyApkSigner} = await import('../verify-input-acceptance-sources.mjs');
  verifyApkSigner(verified, expected);
  assert.match(verified, /^Verified using v3 scheme.*: true\r?$/m);
  const existing = await guest('shell', 'pm', 'list', 'packages', product);
  assert.ok(!existing.split(/\r?\n/).includes(`package:${product}`), 'Candidate requires a clean guest');
  assert.match(await run(adb, ['-s', serial, 'install', file], 45000), /^Success\r?$/m);
  const installed = await guest('shell', 'dumpsys', 'package', product);
  assert.equal(Number(installed.match(/^\s*versionCode=(\d+)\b/m)?.[1]), provenance.version_code);
  assert.equal(installed.match(/^\s*versionName=(.+?)\s*$/m)?.[1], provenance.version);
  const installedPaths = await guest('shell', 'pm', 'path', product);
  const paths = installedPaths.trim().split(/\r?\n/);
  assert.equal(paths.length, 1);
  const apkPath = paths[0].match(/^package:(\/[A-Za-z0-9_=/.~-]+)$/)?.[1];
  assert.ok(apkPath, 'Expected one installed base APK');
  const installedDigest = (await guest('shell', 'sha256sum', apkPath)).split(/\s/)[0];
  assert.equal(installedDigest, digest);
  summary.candidate = {installed: true, version: provenance.version, version_code: provenance.version_code,
    source_commit: provenance.source_commit, apk_sha256: digest, release_signer_verified: true, watch_link_opened: false};
}

async function main() {
  fs.mkdirSync(output);
  const configFile = path.join(output, 'emulator-control.private.json');
  let child, closed, ownedGuest = false, privateAvd;
  try {
    const environment = {...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk};
    if (candidateRoot) {
      summary.phase = 'provision_fresh_guest';
      privateAvd = fs.mkdtempSync(path.join(output, 'avd-'));
      environment.ANDROID_AVD_HOME = privateAvd;
      environment.JAVA_HOME = path.join(process.env.LOCALAPPDATA, 'Android/jdk/jdk-21.0.13+9');
      await provisionFreshAvd(environment);
    }
    summary.phase = 'validate_probe_and_ports';
    const manifest = await run(path.join(sdk, 'build-tools/37.0.0/aapt2.exe'),
      ['dump', 'xmltree', apk, '--file', 'AndroidManifest.xml']);
    assert.match(manifest, /package="io\.github\.bei612\.streamkit\.inputobserver"/);
    assert.match(manifest, /android:testOnly\(0x[0-9a-f]+\)=(?:true|0xffffffff)/i);
    assert.match(manifest, /MicrophoneCaptureActivity/);
    assert.ok(!(await run(adb, ['devices'])).includes(serial), 'Fixture device is already in use');
    await Promise.all([5582, 5583, controlPort].map(requireFreePort));
    const version = await run(emulator, ['-version']);
    summary.emulator_version = version.match(/Android emulator version ([0-9.]+) \(build_id (\d+)\)/)?.slice(1);
    assert.ok(summary.emulator_version);

    summary.phase = 'start_owned_avd';
    const logs = fs.openSync(path.join(output, 'emulator.log'), 'wx');
    const started = Date.now();
    try {
      child = spawn(emulator, ['-avd', avd, '-read-only', '-no-snapshot', '-no-window', '-no-boot-anim',
        '-gpu', 'swiftshader', '-port', '5582', '-grpc', String(controlPort), '-grpc-use-token'],
      {stdio: ['ignore', logs, logs], windowsHide: true, env: environment});
    } finally { fs.closeSync(logs); }
    closed = new Promise(resolve => child.once('close', resolve));
    child.on('error', () => {});
    summary.phase = 'wait_for_android_boot';
    const bootDeadline = Date.now() + 150000;
    let token;
    do {
      assert.equal(child.exitCode, null, 'Owned emulator exited before boot');
      const name = await guest('emu', 'avd', 'name').catch(() => '');
      if (name.split(/\r?\n/)[0].trim() === avd) {
        ownedGuest = true;
        if ((await guest('shell', 'getprop', 'sys.boot_completed').catch(() => '')).trim() === '1') {
          const platformPackage = await guest('shell', 'pm', 'path', 'android').catch(() => '');
          if (platformPackage.trimStart().startsWith('package:')) {
            token = discoveryToken(started);
            if (token) break;
          }
        }
      }
      await delay(1000);
    } while (Date.now() < bootDeadline);
    assert.ok(ownedGuest && token, 'Owned read-only Android guest did not finish booting');
    summary.phase = 'verify_emulator_rpc';
    assert.match(fs.readFileSync(path.join(output, 'emulator.log'), 'utf8'),
      /Started GRPC server at 127\.0\.0\.1:8556, security: Local, auth: \+token/);
    summary.phase = 'verify_android_api';
    summary.android_api_level = Number((await guest('shell', 'getprop', 'ro.build.version.sdk')).trim());
    assert.equal(summary.android_api_level, 36);

    summary.phase = 'install_test_observer';
    await installObserver();
    summary.phase = 'independent_microphone';
    fs.writeFileSync(configFile, JSON.stringify({address: '127.0.0.1:8556', token}), {flag: 'wx'});
    const measurement = path.join(output, 'system-microphone-control.json');
    try {
      await exec(process.execPath, [path.join(__dirname, 'emulator-microphone-control.cjs'), '--serial', serial,
        '--adb', adb, '--output', measurement, '--grpc-config', configFile, '--windows-read-only', '--avd', avd],
      {encoding: 'utf8', timeout: 65000, windowsHide: true, env: {...process.env,
        STREAM_KIT_AUDIO_EMULATOR_DIR: emulatorDir, STREAM_KIT_AUDIO_MICROPHONE_SOURCE: 'emulator-rpc'}});
    } catch { /* The fixture writes its classified result before exit. */ }
    summary.microphone = JSON.parse(fs.readFileSync(measurement, 'utf8'));
    if (candidateRoot) {
      summary.phase = 'stage_verified_candidate';
      await installSignedCandidate(environment);
    }
    summary.passed = summary.microphone.passed;
  } catch (error) {
    summary.failure = 'WINDOWS_FIXTURE_DID_NOT_COMPLETE';
    if (/^(?:[A-Z_0-9-]+)$/.test(String(error.code || ''))) summary.error_code = error.code;
    const location = String(error.stack || '').match(/accept-windows-emulator-microphone\.cjs:(\d+):\d+/);
    if (location) summary.fixture_line = Number(location[1]);
  } finally {
    if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
    if (Number.isInteger(child?.exitCode)) summary.emulator_exit_before_cleanup = child.exitCode;
    if (ownedGuest && child?.exitCode === null) {
      await guest('emu', 'kill').catch(() => '');
      await Promise.race([closed, delay(5000, undefined, {ref: false})]);
    }
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      // On Windows killing only the SDK launcher can leave its QEMU worker.
      try { await run(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F']); }
      catch (error) { if (child.exitCode === null) summary.emulator_cleanup_error = error.code; }
      await Promise.race([closed, delay(5000, undefined, {ref: false})]);
    }
    const remainingGuest = ownedGuest ? await guest('emu', 'avd', 'name').catch(() => '') : '';
    summary.emulator_stopped = (!child || child.exitCode !== null || child.signalCode !== null)
      && remainingGuest.split(/\r?\n/)[0].trim() !== avd;
    if (!summary.emulator_stopped) summary.passed = false;
    if (candidateRoot && privateAvd && summary.emulator_stopped) {
      try {
        const resolved = fs.realpathSync(privateAvd);
        assert.equal(path.dirname(resolved), fs.realpathSync(output));
        assert.match(path.basename(resolved), /^avd-[A-Za-z0-9]+$/);
        fs.rmSync(resolved, {recursive: true, maxRetries: 3});
        summary.private_avd_removed = true;
      } catch {
        summary.private_avd_removed = false;
        summary.passed = false;
      }
    }
    summary.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary));
    if (!summary.passed) process.exitCode = 1;
  }
}

main().catch(() => { console.error('Unable to retain Windows fixture evidence'); process.exitCode = 1; });
