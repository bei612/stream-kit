'use strict';

// CI-only positive control of the common AudioFlinger/HAL/emulator/PA output.
// This is not product audio acceptance and never supplies a product sample.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const readline = require('node:readline');
const {promisify} = require('node:util');
const {setTimeout: delay} = require('node:timers/promises');
const {startAudioProbe} = require('../lib/audio-probe.cjs');
const execFile = promisify(cp.execFile);
const CLIENT = 'io.github.bei612.streamkit';
const OBSERVER = CLIENT + '.inputobserver';
const SOURCE = 'streamkit_android_capture';
const FREQUENCIES = [697, 1209];
const RATE = 48000, FRAMES = 192000, LIMIT_MS = 6500;
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  if (!['--serial', '--adb', '--probe', '--output', '--volume-evidence'].includes(key)
      || options[key] || !process.argv[index + 1]) throw Error('Invalid control arguments');
  options[key] = process.argv[index + 1];
}
const serial = options['--serial'], adb = options['--adb'];
let probe, tone, evidenceReady = false;
const result = {schema_version: 1, fixture_only: true, product_audio_result: null,
  product_app_entered: false, host_changed: false, volume_changed: false,
  status: 'pending', passed: false, started_at_ms: Date.now(), phase: 'guards',
  expected_frequencies_hz: FREQUENCIES, sample_rate: RATE, minimum_frames: FRAMES,
  collection_limit_ms: LIMIT_MS, minimum_median_amplitude: 0.01,
  pa_observations: [], pcm_saved: false};
function fail(code) { const error = new Error(code); error.controlCode = code; throw error; }
function check(condition, code) { if (!condition) fail(code); }
function save() { if (evidenceReady) fs.writeFileSync(options['--output'], JSON.stringify(result, null, 2) + '\n', {mode: 0o600}); }
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function run(executable, args, allowed = [0]) {
  try { return (await execFile(executable, args, {encoding: 'utf8', timeout: 2500, maxBuffer: 512 * 1024})).stdout.replace(/\r/g, ''); }
  catch (error) { if (allowed.includes(error.code)) return String(error.stdout || '').replace(/\r/g, ''); fail('CONTROL_METADATA_COMMAND_FAILED'); }
}
const android = (args, allowed) => run(adb, ['-s', serial, ...args], allowed);
async function productAbsent() {
  check(!(await android(['shell', 'pidof', CLIENT], [0, 1])).trim(), 'CONTROL_PRODUCT_ALREADY_RUNNING');
}
async function pa(requireWriter) {
  const [sinks, sources, inputs] = await Promise.all(['sinks', 'sources', 'sink-inputs'].map(async kind =>
    JSON.parse(await run('pactl', ['--format=json', 'list', kind]))));
  const sink = sinks.find(item => item.name === 'streamkit_android');
  const source = sources.find(item => item.name === SOURCE);
  const master = sources.find(item => item.name === 'streamkit_android.monitor');
  // Ubuntu noble's PulseAudio 16.1 pactl source JSON names the string field
  // "monitor_source" even though the C API member is monitor_of_sink_name.
  // https://git.launchpad.net/ubuntu/+source/pulseaudio/tree/src/utils/pactl.c?h=applied/ubuntu/noble-updates
  check(sink && source && master && source.properties?.['device.master_device'] === master.name
    && master.monitor_source === sink.name, 'CONTROL_CAPTURE_GRAPH_INVALID');
  const writers = inputs.filter(item => item.sink === sink.index);
  check(writers.every(item => Number(item.properties?.['application.process.id']) === result.emulator_pid),
    'CONTROL_UNOWNED_ANDROID_WRITER');
  check(!requireWriter || writers.length === 1, 'CONTROL_EMULATOR_OUTPUT_UNAVAILABLE');
  check(writers.length <= 1 && !sink.mute && Object.values(sink.volume).every(v => v.value === 65536)
    && !source.mute && Object.values(source.volume).every(v => v.value === 65536), 'CONTROL_PA_GAIN_INVALID');
  check(writers.every(item => !item.mute && (!requireWriter || !item.corked)
    && Object.values(item.volume).every(v => v.value === 65536)), 'CONTROL_PA_WRITER_MUTED');
  result.pa_observations.push({at_ms: Date.now(),sink_index: sink.index,capture_source_index: source.index,
    master_source_index: master.index,capture_master_verified: true,writer_count: writers.length,
    writer_pids: writers.map(item => Number(item.properties['application.process.id'])),
    writer_sample_specifications: writers.map(item => item.sample_specification)});
  save();
}
async function af() {
  const pid = result.tone.tone_process_id, session = result.tone.tone_session_id;
  const unknown = reason => ({at_ms: Date.now(),process_id: pid,session_id: session,
    available: false,reason,track_count: null,active_track_count: null});
  let dump;
  try { dump = await android(['shell', 'dumpsys', 'media.audio_flinger']); }
  catch { return unknown('af_command_unavailable'); }
  if (!dump.split('\n').some(line => line.includes('Client(pid/uid)') && line.includes('Session') && line.includes('Active')))
    return unknown('af_schema_unrecognized');
  const rows = dump.split('\n').map(line => line.match(/\b(yes|no)\s+([0-9]+)\s*\/\s*([0-9]+)\s+([0-9]+)(?:\s|$)/)).filter(Boolean);
  if (!rows.length) return unknown('af_rows_unavailable');
  const owned = rows.filter(row => Number(row[2]) === pid && Number(row[4]) === session);
  return {at_ms: Date.now(),process_id: pid,session_id: session,available: true,
    basis: 'recognized_client_session_rows',track_count: owned.length,
    active_track_count: owned.filter(row => row[1] === 'yes').length};
}
function startTone() {
  const child = cp.spawn(adb, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-e', 'action',
    'playout-control', OBSERVER + '/.Observer'], {stdio: ['ignore', 'pipe', 'pipe']});
  let resolveReady, rejectReady, resolved = false, closed = false, bytes = 0, timedOut = false;
  const status = {}, final = {};
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const lines = readline.createInterface({input: child.stdout});
  const numbers = new Set(['tone_duration_ms', 'tone_stream', 'tone_volume_percent', 'tone_process_id',
    'tone_started_elapsed_ms', 'tone_session_id', 'tone_low_hz', 'tone_high_hz', 'tone_finished_elapsed_ms']);
  lines.on('line', line => {
    const match = line.match(/^INSTRUMENTATION_(STATUS|RESULT): ([a-z_]+)=([A-Za-z0-9_.-]+)$/);
    if (match) {
      const target = match[1] === 'STATUS' ? status : final;
      if (numbers.has(match[2]) && /^[0-9]+$/.test(match[3]) && Number.isSafeInteger(Number(match[3]))) target[match[2]] = Number(match[3]);
      else if (['tone_started', 'tone_stopped', 'tone_released'].includes(match[2])) target[match[2]] = match[3] === 'true';
      else if (match[2] === 'tone_result' && ['complete', 'failed'].includes(match[3])) target.tone_result = match[3];
    }
    if (!resolved && /^INSTRUMENTATION_STATUS_CODE:/.test(line) && status.tone_started === true) {
      resolved = true; resolveReady({...status,host_observed_at_ms: Date.now()});
    }
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    bytes += data.length; if (bytes > 16384) child.kill();
  });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10000);
  const done = new Promise(resolve => {
    const finish = (code, signal) => {
      if (closed) return; closed = true; clearTimeout(timer); lines.close();
      if (!resolved) rejectReady(Error('CONTROL_TONE_NOT_STARTED'));
      resolve({code,signal,timed_out: timedOut,...final,host_finished_at_ms: Date.now()});
    };
    child.once('error', () => finish(null, 'spawn_failed'));
    child.once('close', finish);
  });
  return {ready,done,child,get closed() { return closed; }};
}
async function command(op, parameters = {}) {
  const response = await probe.command(op, parameters);
  check(!response.error, 'CONTROL_PROBE_COMMAND_FAILED');
  return response.data;
}
async function main() {
  check(process.platform === 'linux' && process.getuid() !== 0 && process.env.GITHUB_ACTIONS === 'true'
    && process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'CONTROL_REQUIRES_OWNED_CI_AVD');
  check(serial === 'emulator-5580' && options['--probe'] && options['--output'] && options['--volume-evidence'], 'CONTROL_ARGUMENTS_INVALID');
  check(fs.realpathSync(adb) === fs.realpathSync(path.join(process.env.ANDROID_HOME, 'platform-tools/adb')),
    'CONTROL_ADB_BINARY_INVALID');
  const evidenceDirectory = path.resolve('artifacts/android-audio-evidence');
  check(path.dirname(path.resolve(options['--output'])) === evidenceDirectory
    && fs.realpathSync(evidenceDirectory) === evidenceDirectory, 'CONTROL_EVIDENCE_PATH_INVALID');
  check(!fs.existsSync(options['--output']), 'CONTROL_EVIDENCE_ALREADY_EXISTS');
  evidenceReady = true;
  const privateSocket = String(process.env.PULSE_SERVER || '');
  check(privateSocket.startsWith('unix:') && path.resolve(privateSocket.slice(5)).startsWith(path.resolve(process.env.RUNNER_TEMP) + path.sep), 'CONTROL_REQUIRES_PRIVATE_PA');
  check((await android(['emu', 'avd', 'name'])).trim().split('\n').filter(line => line !== 'OK').join('\n') === 'StreamKit_Audio_CI', 'CONTROL_AVD_NOT_OWNED');
  check((await android(['shell', 'id', '-u'])).trim() === '2000', 'CONTROL_AVD_NOT_UNROOTED');
  const emulators = (await run(adb, ['devices'])).split('\n').filter(line => /^emulator-[0-9]+\s/.test(line));
  check(emulators.length === 1 && emulators[0].startsWith(serial + '\tdevice'), 'CONTROL_OTHER_AVD_PRESENT');
  const expected = fs.realpathSync(path.join(process.env.ANDROID_HOME, 'emulator/qemu/linux-x86_64/qemu-system-x86_64'));
  result.emulator_pid = Number(process.env.STREAM_KIT_AUDIO_EMULATOR_ROOT_PID);
  check(Number.isSafeInteger(result.emulator_pid) && result.emulator_pid > 0
    && fs.realpathSync('/proc/' + result.emulator_pid + '/exe') === expected, 'CONTROL_EMULATOR_BINARY_INVALID');
  const volume = JSON.parse(fs.readFileSync(options['--volume-evidence'], 'utf8'));
  check(volume.status === 'passed' && volume.after === volume.max && volume.shell_uid === 2000
    && volume.fixture_only === true && volume.host_changed === false && volume.avd_serial === serial,
    'CONTROL_VOLUME_BASELINE_UNAVAILABLE');
  result.volume = {before: volume.before,after: volume.after,min: volume.min,max: volume.max};
  result.probe_sha256 = hash(options['--probe']);
  result.observer_apk_sha256 = hash('artifacts/input-example/android/observer.apk');
  await productAbsent(); await pa(false);
  result.phase = 'probe_start';
  probe = startAudioProbe(path.resolve(options['--probe']));
  result.probe_pid = probe.pid;
  check((await command('devices')).devices.some(device => device.id === 'pulseaudio:' + SOURCE && device.input), 'CONTROL_CAPTURE_DEVICE_MISSING');
  result.phase = 'tone_start'; tone = startTone(); result.tone = await tone.ready;
  check(result.tone.tone_duration_ms === 6000 && result.tone.tone_stream === 3 && result.tone.tone_volume_percent === 100
    && result.tone.tone_low_hz === 697 && result.tone.tone_high_hz === 1209
    && result.tone.tone_process_id > 0 && result.tone.tone_session_id > 0, 'CONTROL_TONE_START_INVALID');
  check((await android(['shell', 'pidof', OBSERVER])).trim().split(/\s+/).map(Number).includes(result.tone.tone_process_id), 'CONTROL_TONE_OWNER_INVALID');
  await pa(true);
  result.phase = 'capture'; const started = Date.now(); result.capture_started_at_ms = started;
  result.initial_status = await command('capture', {device_id: 'pulseaudio:' + SOURCE}); save();
  const track = af(); void track.catch(() => {});
  let status, nextPA = started;
  while (Date.now() - started < LIMIT_MS) {
    status = await command('status');
    check(!tone.closed, 'CONTROL_TONE_ENDED_DURING_CAPTURE');
    check(status.input_state === 'capture' && status.sample_rate === RATE && status.dropped_frames === 0 && !status.error, 'CONTROL_CAPTURE_FAILED');
    if (Date.now() >= nextPA) { await pa(true); nextPA = Date.now() + 500; }
    if (status.captured_frames >= FRAMES) break;
    await delay(100);
  }
  result.capture_finished_at_ms = Date.now(); result.capture = await command('stop_capture');
  result.capture_completed_before_tone_completion_observed = !tone.closed;
  check(result.capture_completed_before_tone_completion_observed, 'CONTROL_TONE_ENDED_DURING_CAPTURE');
  result.active_track = await track;
  check(result.capture.captured_frames >= FRAMES && result.capture.dropped_frames === 0
    && result.capture_finished_at_ms - started <= LIMIT_MS, 'CONTROL_CAPTURE_WINDOW_INVALID');
  result.signals = [];
  for (const frequency_hz of FREQUENCIES) result.signals.push(await command('analyze', {frequency_hz}));
  result.tone_completion = await tone.done;
  result.clock_boundary = 'Capture starts after host receipt of tone_started and finishes before host observes instrumentation completion. Host timestamps and device elapsedRealtime are separate clocks; neither establishes the physical tone onset.';
  check(result.tone_completion.code === 0 && !result.tone_completion.signal && !result.tone_completion.timed_out
    && result.tone_completion.tone_result === 'complete' && result.tone_completion.tone_stopped
    && result.tone_completion.tone_released, 'CONTROL_TONE_CLEANUP_FAILED');
  result.released_track = await af();
  await productAbsent();
  check(result.signals.every(signal => signal.sample_rate === RATE && signal.analyzed_frames >= FRAMES
    && signal.windows >= 40 && signal.median_amplitude > 0.01), 'CONTROL_SYSTEM_PLAYOUT_MISSING');
  result.status = 'passed'; result.passed = true;
}
main().catch(error => {result.status = 'failed'; result.failure_class = error.controlCode || 'CONTROL_FAILED'; process.exitCode = 1;}).finally(async () => {
  if (probe) {
    try { await command('stop_capture'); }
    catch { result.failure_class ||= 'CONTROL_PROBE_STOP_FAILED'; result.status = 'failed'; result.passed = false; process.exitCode = 1; }
    try { await probe.close(); result.probe_closed = true; }
    catch { result.probe_closed = false; result.failure_class ||= 'CONTROL_PROBE_CLEANUP_FAILED'; result.status = 'failed'; result.passed = false; process.exitCode = 1; }
  }
  if (tone) {
    const completion = await tone.done; result.tone_completion ||= completion;
    if (completion.timed_out || completion.code !== 0 || !completion.tone_stopped || !completion.tone_released) {
      try { await android(['shell', 'am', 'force-stop', OBSERVER]); } catch {}
      result.status = 'failed'; result.passed = false; process.exitCode = 1;
    }
  }
  result.finished_at_ms = Date.now();
  save();
  console.log(JSON.stringify({passed: result.passed,fixture_only: true,phase: result.phase,failure_class: result.failure_class || null}));
}).catch(() => { console.error('Control evidence or cleanup failed'); process.exitCode = 1; });
