#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && $EUID != 0 ]]
[[ ${ANDROID_TEST_API:-36} == 35 || ${ANDROID_TEST_API:-36} == 36 ]]
test -c /dev/kvm
scratch=$(mktemp -d "$RUNNER_TEMP/stream-kit-audio.XXXXXXXX")
evidence="$GITHUB_WORKSPACE/artifacts/android-audio-evidence"
tls="$scratch/tls"
mkdir -p "$tls" "$evidence"
umask 077
export ANDROID_AVD_HOME="$scratch/avd"
mkdir -p "$ANDROID_AVD_HOME"
serial=emulator-5580
display_pid='' wm_pid='' emulator_pid='' pulse_pid=''
cleanup() {
  # Retain only resource/termination diagnostics, never intent URLs, full
  # logcat, UI contents or credentials. These remain test artifacts only.
  if [[ -n "$emulator_pid" ]]; then
    timeout 5s adb -s "$serial" shell cat /proc/meminfo > "$evidence/android-memory.txt" 2>/dev/null || true
    timeout 5s adb -s "$serial" shell dumpsys cpuinfo > "$evidence/android-cpu.txt" 2>/dev/null || true
    timeout 5s adb -s "$serial" logcat -d -b events -s am_kill:I am_proc_died:I '*:S' > "$evidence/android-process-exits.txt" 2>/dev/null || true
    timeout 5s adb -s "$serial" logcat -d -s lowmemorykiller:I lmkd:I '*:S' > "$evidence/android-memory-kills.txt" 2>/dev/null || true
  fi
  if [[ -n "$emulator_pid" ]]; then timeout 10s adb -s "$serial" emu kill >/dev/null 2>&1 || true; kill "$emulator_pid" 2>/dev/null || true; fi
  if [[ -n "$wm_pid" ]]; then kill "$wm_pid" 2>/dev/null || true; fi
  if [[ -n "$display_pid" ]]; then kill "$display_pid" 2>/dev/null || true; fi
  if [[ -n "$pulse_pid" ]]; then kill "$pulse_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj '/CN=Stream Kit isolated input CI CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$tls/ca.key" -out "$tls/ca.crt" >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=Stream Kit isolated input CI' \
  -keyout "$tls/server.key" -out "$tls/server.csr" >/dev/null 2>&1
cat > "$tls/leaf.ext" <<'CERT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1,IP:10.0.2.2,DNS:localhost
CERT
openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial \
  -days 1 -sha256 -extfile "$tls/leaf.ext" -out "$tls/server.crt" >/dev/null 2>&1
openssl verify -CAfile "$tls/ca.crt" "$tls/server.crt"
openssl x509 -in "$tls/ca.crt" -noout -fingerprint -sha256 > "$evidence/test-ca-fingerprint.txt"
# Trust belongs only to this disposable CI machine and official AVD. No TLS
# error overrides, custom TrustManager, debug APK or production CA is used.
sudo install -m 644 "$tls/ca.crt" /usr/local/share/ca-certificates/stream-kit-isolated-input.crt
sudo update-ca-certificates >/dev/null
mkdir -p "$HOME/.pki/nssdb"
if [[ ! -f "$HOME/.pki/nssdb/cert9.db" ]]; then certutil -N -d "sql:$HOME/.pki/nssdb" --empty-password; fi
certutil -A -d "sql:$HOME/.pki/nssdb" -n StreamKitIsolatedInput -t 'C,,' -i "$tls/ca.crt"
export NODE_EXTRA_CA_CERTS="$tls/ca.crt"
# Private real PulseAudio server and separate endpoints. No host defaults change.
mkdir -p "$scratch/pulse-runtime" "$scratch/pulse-state"
export PULSE_RUNTIME_PATH="$scratch/pulse-runtime" PULSE_STATE_PATH="$scratch/pulse-state"
export PULSE_SERVER="unix:$scratch/pulse.sock"
cat > "$scratch/pulse.pa" <<EOF
load-module module-null-sink sink_name=streamkit_host rate=48000 channels=2
load-module module-null-sink sink_name=streamkit_android rate=48000 channels=2
load-module module-remap-source master=streamkit_android.monitor source_name=streamkit_android_capture
load-module module-null-sink sink_name=streamkit_program rate=48000 channels=2
load-module module-null-sink sink_name=streamkit_microphone rate=48000 channels=2
load-module module-remap-source master=streamkit_microphone.monitor source_name=streamkit_microphone_capture
load-module module-native-protocol-unix socket=$scratch/pulse.sock auth-anonymous=1
set-default-sink streamkit_host
EOF
pulseaudio -n --daemonize=no --use-pid-file=no --exit-idle-time=-1 --file="$scratch/pulse.pa" --log-target="file:$evidence/pulse.log" &
pulse_pid=$!
for attempt in $(seq 1 50); do if pactl info >/dev/null 2>&1; then break; fi; kill -0 "$pulse_pid"; sleep 0.1; done
pactl info >/dev/null

# The official Linux -no-window launcher selects a headless binary whose public
# implementation links PulseAudio stubs. Use the full official binary on this
# isolated X server so an actual PulseAudio output backend is required.
export DISPLAY=:91
Xvfb "$DISPLAY" -screen 0 1280x720x24 -nolisten tcp > "$evidence/xvfb.log" 2>&1 &
display_pid=$!
for attempt in $(seq 1 30); do if xdpyinfo >/dev/null 2>&1; then break; fi; kill -0 "$display_pid"; sleep 1; done
xdpyinfo >/dev/null
openbox > "$evidence/window-manager.log" 2>&1 &
wm_pid=$!

sudo chmod a+rw /dev/kvm
avdmanager create avd --name StreamKit_Audio_CI --package "system-images;android-${ANDROID_TEST_API:-36};google_apis;x86_64" --device pixel_6 <<< no
PULSE_SINK=streamkit_android "$ANDROID_HOME/emulator/emulator" -avd StreamKit_Audio_CI -port 5580 -memory 4096 -no-snapshot -no-boot-anim -gpu swiftshader -grpc 8554 -grpc-use-token \
  > "$evidence/emulator.log" 2>&1 &
emulator_pid=$!
export STREAM_KIT_AUDIO_EMULATOR_ROOT_PID="$emulator_pid"
wait_for_owned_boot() {
  local previous_boot="${1:-}" current_boot='' boot_deadline=$((SECONDS + 300))
  while (( SECONDS < boot_deadline )); do
    kill -0 "$emulator_pid"
    current_boot=$(timeout 5s adb -s "$serial" shell cat /proc/sys/kernel/random/boot_id 2>/dev/null | tr -d '\r' || true)
    if [[ "$current_boot" =~ ^[0-9a-f-]{36}$ && "$current_boot" != "$previous_boot" && "$(timeout 5s adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)" == 1 ]]; then return 0; fi
    sleep 2
  done
  echo 'Owned official AVD boot did not complete' >&2
  return 1
}
wait_for_owned_boot
# Restarting adbd can close its requesting transport before the acknowledgement.
# Verify the resulting identity after reconnection; never trust only exit status.
adb_identity() {
  local action="$1" expected="$2" deadline=$((SECONDS + 40))
  while (( SECONDS < deadline )); do
    timeout 8s adb -s "$serial" "$action" >/dev/null 2>&1 || true
    timeout 5s adb -s "$serial" wait-for-device >/dev/null 2>&1 || true
    if [[ "$(timeout 5s adb -s "$serial" shell id -u 2>/dev/null | tr -d '\r' || true)" == "$expected" ]]; then return 0; fi
    sleep 1
  done
  echo "Official test emulator did not enter requested adb identity: $expected" >&2
  return 1
}
# AOSP UserCertificateSource reads the user store under /data/misc/user/<id>.
# Provision the public test CA on the root-capable official CI image before
# launching the release APK, then return adbd to its ordinary shell identity.
adb_identity root 0
[[ $(adb -s "$serial" shell am get-current-user | tr -d '\r') == 0 ]]
ca_hash=$(openssl x509 -in "$tls/ca.crt" -subject_hash_old -noout)
[[ "$ca_hash" =~ ^[0-9a-f]{8}$ ]]
adb -s "$serial" shell mkdir -p /data/misc/user/0/cacerts-added
adb -s "$serial" shell chown system:system /data/misc/user/0/cacerts-added
adb -s "$serial" shell chmod 755 /data/misc/user/0/cacerts-added
adb -s "$serial" push "$tls/ca.crt" "/data/misc/user/0/cacerts-added/$ca_hash.0" >/dev/null
adb -s "$serial" shell chown system:system "/data/misc/user/0/cacerts-added/$ca_hash.0"
adb -s "$serial" shell chmod 644 "/data/misc/user/0/cacerts-added/$ca_hash.0"
adb -s "$serial" shell restorecon -R /data/misc/user/0/cacerts-added
adb_identity unroot 2000
# Build the disposable guest's installed baseline before audio-service startup.
# Android 16 initializes NativePermissionController from a PackageManager
# snapshot, while post-install updates arrive asynchronously via broadcasts.
# A package-handler barrier alone does not synchronize that separate consumer.
# Reboot only this owned AVD once; no host reboot, permission bypass, synthetic
# package-map writes, global broadcast reprioritization or AudioTrack retries.
# https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/services/core/java/com/android/server/audio/AudioService.java
adb -s "$serial" shell wm size 720x1280
adb -s "$serial" shell wm density 240
adb -s "$serial" install artifacts/input-download/*.apk
adb -s "$serial" install -t artifacts/input-example/android/observer.apk
boot_before=$(adb -s "$serial" shell cat /proc/sys/kernel/random/boot_id | tr -d '\r')
[[ "$boot_before" =~ ^[0-9a-f-]{36}$ ]]
adb -s "$serial" reboot
timeout 90s adb -s "$serial" wait-for-device
wait_for_owned_boot "$boot_before"
boot_after=$(adb -s "$serial" shell cat /proc/sys/kernel/random/boot_id | tr -d '\r')
[[ "$boot_after" =~ ^[0-9a-f-]{36}$ && "$boot_before" != "$boot_after" ]]
[[ $(adb -s "$serial" shell id -u | tr -d '\r') == 2000 ]]
printf '%s\n' '{"fixture_only":true,"owned_avd":"StreamKit_Audio_CI","post_install_guest_reboot":true,"boot_identity_changed":true,"host_rebooted":false,"shell_uid":2000}' > "$evidence/installed-guest-baseline.json"
# Calibrate only this disposable official AVD's STREAM_MUSIC gain before the
# release APK starts. Keep the PCM acceptance threshold unchanged. AOSP's
# MediaShellCommand's --get reports current/min/max. Set through AudioService's
# own official shell command, retaining its MANAGE_AUDIO_POLICY check. Unlike
# VolumeCtrl, this uses the service's AudioManager context for attribution.
# The explicitly selected API 35 guest uses its public VolumeCtrl setter;
# API 36 uses AudioManagerShellCommand. This is version dispatch, never a
# retry with different privileges or a fallback after a permission failure.
# https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/media/VolumeCtrl.java
# https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/services/core/java/com/android/server/audio/AudioManagerShellCommand.java
node - "$serial" "$evidence/media-volume.json" <<'NODE'
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const {setTimeout: delay} = require('node:timers/promises');
const [serial, evidence] = process.argv.slice(2);
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.notEqual(process.getuid(), 0);
assert.equal(serial, 'emulator-5580');
const started = performance.now();
const result = {
  schemaVersion: 2, fixture_only: true, host_changed: false, avd_serial: serial,
  stream: 3, before: null, after: null, min: null, max: null, set_attempts: 0,
  set_interface: 'cmd audio set-volume', get_interface: 'cmd media_session volume --get',
  shell_uid: null, audio_service_before: null, set_command_supported: false,
  timeout_ms: 5000, elapsed_ms: 0, observation_attempts: 0, observations_count: 0, observations: [],
  phase: 'avd_identity',
  status: 'pending', failure_class: null,
};
function save() {
  result.elapsed_ms = Math.round(performance.now() - started);
  result.observations_count = result.observations.length;
  fs.writeFileSync(evidence, JSON.stringify(result, null, 2) + '\n', {mode: 0o600});
}
function fail(code) {
  const error = new Error(code);
  error.fixtureCode = code;
  throw error;
}
function commandFailure(text) {
  if (/SecurityException|Permission Denial|Permission denied|requires .*permission|Not allowed to change Do Not Disturb/i.test(text))
    return 'MEDIA_VOLUME_PERMISSION_DENIED';
  if (/(?:safe (?:media )?volume|sound dose|hearing safety).*(?:blocked|denied|rejected|exceeded|warning)/i.test(text))
    return 'MEDIA_VOLUME_SAFETY_POLICY';
  if (/unknown command|unknown option|not found|inaccessible|can.t connect|can(?:not|'t) find service/i.test(text))
    return 'MEDIA_VOLUME_COMMAND_UNAVAILABLE';
  if (/^\[E\]|^Error:|(?:java|android)\.[\w.]+Exception:/m.test(text))
    return 'MEDIA_VOLUME_COMMAND_REJECTED';
  return null;
}
function adb(args, timeout = 10000) {
  const command = spawnSync('adb', ['-s', serial, ...args], {
    encoding: 'utf8', timeout, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Some Android shell errors return zero; check both output streams without
  // retaining raw text, device names or other unbounded diagnostics.
  const code = commandFailure(String(command.stdout || '') + '\n' + String(command.stderr || ''));
  if (code) fail(code);
  if (command.error || command.status !== 0)
    fail(command.error?.code === 'ETIMEDOUT' ? 'MEDIA_VOLUME_COMMAND_TIMEOUT' : 'MEDIA_VOLUME_COMMAND_FAILED');
  return command.stdout.replace(/\r/g, '');
}
function getVolume(timeout) {
  const output = adb(['shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--get'], timeout);
  const matches = [...output.matchAll(/^\[V\] volume is (\d+) in range \[(\d+)\.\.(\d+)\]\s*$/gm)];
  if (matches.length !== 1) fail('MEDIA_VOLUME_RANGE_UNAVAILABLE');
  const [current, min, max] = matches[0].slice(1).map(Number);
  if (![current, min, max].every(Number.isSafeInteger)
      || min < 0 || max <= min || current < min || current > max)
    fail('MEDIA_VOLUME_RANGE_INVALID');
  return {current, min, max};
}
async function calibrate() {
  try {
    assert.deepEqual(adb(['emu', 'avd', 'name']).trim().split('\n').filter(line => line !== 'OK'),
      ['StreamKit_Audio_CI']);
    result.shell_uid = Number(adb(['shell', 'id', '-u']).trim());
    if (result.shell_uid !== 2000) fail('MEDIA_VOLUME_FIXTURE_IDENTITY_INVALID');
    result.guest_sdk = Number(adb(['shell', 'getprop', 'ro.build.version.sdk']).trim());
    if (![35,36].includes(result.guest_sdk) || result.guest_sdk !== Number(process.env.ANDROID_TEST_API || 36))
      fail('MEDIA_VOLUME_GUEST_VERSION_MISMATCH');
    result.set_interface = result.guest_sdk === 35 ? 'cmd media_session volume --set' : 'cmd audio set-volume';
    result.phase = 'before_get';
    const before = getVolume();
    Object.assign(result, {before: before.current, min: before.min, max: before.max});
    save();
    // Android 16's handler does not route an explicit "help" subcommand to
    // onHelp. Query its real read-only API instead of treating empty help as
    // evidence that the setter is missing. No privilege changes are attempted.
    if (result.guest_sdk === 36) {
      result.phase = 'audio_service_get';
      const serviceOutput = adb(['shell', 'cmd', 'audio', 'get-stream-volume', '3']);
      const serviceMatch = serviceOutput.match(/^AudioManager\.getStreamVolume\(3\) -> (\d+)\s*$/m);
      if (!serviceMatch) fail('MEDIA_VOLUME_COMMAND_UNAVAILABLE');
      result.audio_service_before = Number(serviceMatch[1]);
      save();
      if (result.audio_service_before !== before.current) fail('MEDIA_VOLUME_READERS_DISAGREE');
    }
    // Set once. Observe actual state until the deadline, rather than retrying
    // writes or assuming that a successful shell status means volume changed.
    result.set_attempts = 1;
    result.phase = 'set';
    save();
    if (result.guest_sdk === 35) {
      // Android 15 VolumeCtrl.java: setStreamVolume with shell attribution.
      // Require its acknowledgement AND the independent observed volume below.
      const setOutput = adb(['shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--set', String(before.max)]);
      if (!setOutput.split('\n').includes('[V] will set volume to index=' + before.max))
        fail('MEDIA_VOLUME_COMMAND_UNAVAILABLE');
    } else {
      const setOutput = adb(['shell', 'cmd', 'audio', 'set-volume', '3', String(before.max)]);
      if (setOutput.trim() !== 'calling AudioManager.setStreamVolume(3, ' + before.max + ', 0)')
        fail('MEDIA_VOLUME_COMMAND_UNAVAILABLE');
    }
    result.set_command_supported = true;
    save();
    const observedAt = performance.now(), deadline = observedAt + result.timeout_ms;
    result.phase = 'after_get';
    while (performance.now() < deadline) {
      const remaining = Math.max(1, Math.floor(deadline - performance.now()));
      result.observation_attempts++;
      save();
      const after = getVolume(Math.min(2000, remaining));
      result.after = after.current;
      result.observations.push({
        index: result.observations.length + 1,
        elapsed_ms: Math.round(performance.now() - observedAt),
        value: after.current, min: after.min, max: after.max,
      });
      save();
      if (after.min !== before.min || after.max !== before.max) fail('MEDIA_VOLUME_RANGE_CHANGED');
      if (after.current === before.max) {
        result.status = 'passed';
        return;
      }
      const wait = Math.min(200, Math.floor(deadline - performance.now()));
      if (wait > 0) await delay(wait);
    }
    // AudioService may reject a change without a shell error. This observation
    // alone cannot distinguish policy rejection from a state/routing change.
    fail('MEDIA_VOLUME_NOT_OBSERVED');
  } catch (error) {
    result.status = 'failed';
    result.failure_class = error.fixtureCode || 'MEDIA_VOLUME_FIXTURE_INVALID';
  } finally {
    save();
  }
}
calibrate().then(() => {
  if (result.status !== 'passed') {
    console.error('AVD media-volume calibration failed: ' + result.failure_class);
    process.exitCode = 1;
  }
}).catch(() => {
  console.error('AVD media-volume evidence could not be saved');
  process.exitCode = 1;
});
NODE
# Installation success is not a PM queue barrier. Check the target identities
# and collect passive diagnostics without reprioritizing unrelated broadcasts;
# none of these observations proves that the native UID/package map is ready.
node - "$ANDROID_HOME/platform-tools/adb" "$serial" "$evidence/install-synchronization.json" <<'NODE'
const fs = require('node:fs'), cp = require('node:child_process');
const [adb, serial, output] = process.argv.slice(2);
const result = { schema_version: 1, fixture_only: true, status: 'failed',
  npc_package_table_readiness: 'not_observed', global_broadcast_barrier: 'not_used',
  raw_dumps_retained: false, commands: [], package_uids: {} };
function check(ok, code) { if (!ok) throw new Error(code); }
function command(type, args, diagnosticOnly = false) {
  const run = cp.spawnSync(adb, ['-s', serial, 'shell', ...args], {
    encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
    maxBuffer: diagnosticOnly ? 524288 : 16384,
  });
  const closed = !run.pid || Number.isInteger(run.status) || typeof run.signal === 'string';
  result.commands.push({ command_type: type, exit_code: run.status,
    completed_at_ms: Date.now(), timed_out: run.error?.code === 'ETIMEDOUT',
    signal: run.signal, diagnostic_only: diagnosticOnly, child_cleanup_confirmed: closed });
  check(closed, 'OWNED_ADB_CLEANUP_UNCONFIRMED');
  if (diagnosticOnly && (run.error || run.status !== 0)) return null;
  check(!run.error && run.status === 0, type.toUpperCase() + '_FAILED');
  return run.stdout.trim();
}
function broadcasts(text) {
  const targets = Object.keys(result.package_uids);
  const projection = Object.fromEntries(targets.map(name => [name, { status: 'unknown', records: [] }]));
  if (!text?.includes('ACTIVITY MANAGER BROADCAST STATE')) return projection;
  for (const block of text.split(/(?=^\s*BroadcastRecord\{)/m)) {
    if (!/^\s*BroadcastRecord\{/.test(block) || !/\bact=android\.intent\.action\.PACKAGE_ADDED\b/.test(block)) continue;
    const name = /\bdat=package:([A-Za-z0-9_.]+)(?=\s|\})/.exec(block)?.[1];
    if (!targets.includes(name) || projection[name].records.length >= 12) continue;
    const terminal = /\bterminalCount=([0-9]+)/.exec(block);
    if (!terminal) continue;
    const clock = field => new RegExp('\\b' + field + '=(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3})').exec(block)?.[1] ?? null;
    const receiverStates = [...block.matchAll(/^\s*(PENDING|DELIVERED|SKIPPED|TIMEOUT|SCHEDULED|FAILURE|DEFERRED)\b[^\r\n]*#([0-9]+):/gm)]
      .slice(0, 128).map(match => ({ index: Number(match[2]), state: match[1] }));
    projection[name].status = 'observed';
    projection[name].records.push({ enqueue_clock: clock('enqueueClockTime'),
      dispatch_clock: clock('dispatchClockTime'), finish_time_present: /\bfinishTime=/.test(block),
      terminal_count: Number(terminal[1]), receiver_states: receiverStates });
  }
  return projection;
}
function lifecycle(text) {
  const lines = text?.split(/\r?\n/) ?? [];
  const start = lines.findIndex(line => line.includes('audio services lifecycle'));
  const events = [];
  if (start >= 0) {
    const labels = { 'AudioService()': 'service_created',
      'Controller start task complete': 'controller_start_task_complete',
      'onAudioServerDied() audioserver died': 'audioserver_died',
      'onAudioServerDied() audioserver started': 'audioserver_started' };
    for (const line of lines.slice(start + 1, start + 65)) {
      const label = Object.keys(labels).find(value => line.trim().endsWith(value));
      if (label) events.push({ event: labels[label],
        device_clock: /\b(\d{2}-\d{2} \d{2}:\d{2}:\d{2}[:.]\d{3})\b/.exec(line)?.[1] ?? null });
    }
  }
  return { status: events.length ? 'observed' : 'unknown', events };
}
try {
  check(process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true'
    && process.env.RUNNER_ENVIRONMENT === 'github-hosted' && process.getuid() !== 0
    && serial === 'emulator-5580', 'OWNED_AVD_REQUIRED');
  check(command('shell_identity', ['id', '-u']) === '2000', 'SHELL_IDENTITY_REQUIRED');
  check(command('package_handler_barrier', ['cmd', 'package', 'wait-for-handler',
    '--timeout', '10000']) === 'Success', 'PACKAGE_HANDLER_ACK_INVALID');
  for (const name of ['io.github.bei612.streamkit', 'io.github.bei612.streamkit.inputobserver']) {
    const lines = command('target_package_uid', ['cmd', 'package', 'list', 'packages',
      '--user', '0', '-U', name]).split(/\r?\n/);
    const matches = lines.map(line => /^package:([A-Za-z0-9_.]+) uid:([0-9]+)$/.exec(line))
      .filter(match => match && match[1] === name);
    check(matches.length === 1, 'TARGET_PACKAGE_UID_UNAVAILABLE');
    const uid = Number(matches[0][2]);
    check(Number.isSafeInteger(uid) && uid >= 10000 && uid < 100000, 'TARGET_PACKAGE_UID_INVALID');
    result.package_uids[name] = uid;
  }
  check(new Set(Object.values(result.package_uids)).size === 2, 'TARGET_PACKAGE_UID_COLLISION');
  result.target_package_broadcasts = broadcasts(command('target_broadcast_diagnostic',
    ['dumpsys', 'activity', '-a', 'broadcasts', 'filter', '--action',
      'android.intent.action.PACKAGE_ADDED'], true));
  result.audio_service_lifecycle = lifecycle(command('audio_lifecycle_diagnostic', ['dumpsys', 'audio'], true));
  check(result.audio_service_lifecycle.events.some(event => event.event === 'controller_start_task_complete'),
    'INITIAL_AUDIO_CONTROLLER_NOT_OBSERVED');
  result.installed_baseline = JSON.parse(fs.readFileSync('artifacts/android-audio-evidence/installed-guest-baseline.json', 'utf8'));
  check(result.installed_baseline.post_install_guest_reboot === true
    && result.installed_baseline.boot_identity_changed === true
    && result.installed_baseline.host_rebooted === false, 'INSTALLED_GUEST_BASELINE_INVALID');
  result.status = 'passed';
} catch (error) {
  result.failure_class = /^[A-Z_]+$/.test(error.message) ? error.message : 'INSTALL_SYNCHRONIZATION_FAILED';
} finally {
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
}
if (result.status !== 'passed') {
  console.error('AVD installation synchronization failed: ' + result.failure_class);
  process.exitCode = 1;
}
NODE
adb -s "$serial" shell input keyevent KEYCODE_WAKEUP
adb -s "$serial" shell wm dismiss-keyguard
# Locate the official owned emulator discovery entry, retaining its token only
# in this private scratch directory. Never print/upload discovery or token data.
node - "$scratch/grpc.json" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const matches=new Map();
function walk(dir,depth){if(depth>7||!fs.existsSync(dir))return;let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch{return}for(const entry of entries){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())walk(file,depth+1);else if(/^pid_[0-9]+(?:_info)?\.ini$/.test(entry.name)){let value;try{if(fs.statSync(file).size>65536)continue;value=fs.readFileSync(file,'utf8')}catch{continue}if(/^grpc.port=8554\s*$/m.test(value)){const token=value.match(/^grpc.token=(.+)$/m)?.[1].trim();if(token)matches.set(file,token)}}}}
for(const root of [os.tmpdir(),'/run/user/'+process.getuid(),path.join(os.homedir(),'.android'),process.env.RUNNER_TEMP].filter(Boolean))walk(root,0);
assert.equal(matches.size,1,'Expected one authenticated official emulator discovery entry');
fs.writeFileSync(process.argv[2],JSON.stringify({address:'127.0.0.1:8554',token:[...matches.values()][0]}),{mode:0o600});
NODE
# A separate testOnly system tone must establish the common emulator output
# before the production APK enters. Its PCM/results never enter product metrics.
node scripts/android/emulator-playout-control.cjs --serial "$serial" \
  --adb "$ANDROID_HOME/platform-tools/adb" --probe artifacts/input-example/audio-probe \
  --output "$evidence/system-playout-control.json" --volume-evidence "$evidence/media-volume.json" --grpc-config "$scratch/grpc.json"
runtime=artifacts/input-runtime/opt/stream-kit
node scripts/accept-source-stream.cjs --sunshine "$runtime/sunshine/bin/sunshine" --gateway "$runtime/media-gateway/web-server" \
  --orchestrator "$runtime/orchestrator/orchestrator" --web-assets "$runtime/media-gateway/dist" \
  --example artifacts/input-example/x11-audio-program --example-output streamkit_program --android-audio --clients 2 --hold-seconds 0 \
  --android-serial "$serial" --android-adb "$ANDROID_HOME/platform-tools/adb" --tls-dir "$tls" \
  --android-grpc-config "$scratch/grpc.json" --audio-probe artifacts/input-example/audio-probe \
  --target-render-device pulseaudio:streamkit_microphone --target-capture-device pulseaudio:streamkit_microphone_capture
