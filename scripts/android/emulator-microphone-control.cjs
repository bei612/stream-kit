'use strict';

const assert = require('node:assert/strict');
const {execFile, spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {createInterface} = require('node:readline');
const {promisify, parseArgs} = require('node:util');
const grpc = require('./emulator-audio/node_modules/@grpc/grpc-js');
const loader = require('./emulator-audio/node_modules/@grpc/proto-loader');
const {startToneInjection, RATE, FREQUENCY} = require('../lib/emulator-audio-injection.cjs');

const observer = 'io.github.bei612.streamkit.inputobserver';
const run = promisify(execFile);
const {values: args} = parseArgs({options: {serial: {type: 'string'}, adb: {type: 'string'},
  output: {type: 'string'}, 'grpc-config': {type: 'string'}}});
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.match(args.serial, /^emulator-[0-9]+$/);
assert.ok(args.adb && args.output && args['grpc-config']);

const evidence = {schema_version: 1, fixture_only: true, passed: false,
  pcm_saved: false, sample_rate: RATE, frequency_hz: FREQUENCY, expected_frames: 240000,
  host_microphone_enabled: null, capture_released: false, started_at_ms: Date.now()};
const source = {packets: 0, senderEnded: false, rpcEnded: false};
const adb = (...command) => run(args.adb, ['-s', args.serial, ...command], {encoding: 'utf8', timeout: 7000});

function instrumentation() {
  const child = spawn(args.adb, ['-s', args.serial, 'shell', 'am', 'instrument', '-w', '-r',
    '-e', 'action', 'microphone-control', `${observer}/.Observer`], {stdio: ['ignore', 'pipe', 'ignore']});
  const values = new Map();
  let ready, code;
  const started = new Promise(resolve => { ready = resolve; });
  const limit = setTimeout(() => child.kill(), 18000);
  const lines = createInterface({input: child.stdout});
  lines.on('line', line => {
    if (line === 'INSTRUMENTATION_STATUS: mic_control_started=recording') ready(true);
    const result = line.match(/^INSTRUMENTATION_RESULT: (mic_control_[a-z_]+|error_type)=([A-Za-z0-9]+)$/);
    if (result) values.set(result[1], result[2]);
    const status = line.match(/^INSTRUMENTATION_CODE: (-?\d+)$/);
    if (status) code = Number(status[1]);
  });
  child.once('error', () => ready(false));
  const closed = new Promise(resolve => child.once('close', exit => {
    clearTimeout(limit);
    ready(false);
    resolve({exit, code, values});
  }));
  return {started, closed, stop: () => child.kill()};
}

async function fixtureInactive(packageName) {
  try { return !(await adb('shell', 'pidof', packageName)).stdout.trim(); }
  catch (error) { return error.code === 1 && !String(error.stdout || '').trim(); }
}

async function main() {
  let client, probe, injection;
  try {
    evidence.phase = 'check_owned_emulator';
    assert.ok(await fixtureInactive('io.github.bei612.streamkit'), 'Product already running');
    const configuration = JSON.parse(fs.readFileSync(args['grpc-config'], 'utf8'));
    assert.match(configuration.address, /^127\.0\.0\.1:[0-9]+$/);
    assert.ok(configuration.token?.length > 16);
    const proto = grpc.loadPackageDefinition(loader.loadSync(path.join(process.env.ANDROID_HOME, 'emulator/lib/emulator_controller.proto'),
      {longs: String, defaults: true}));
    client = new proto.android.emulation.control.EmulatorController(configuration.address, grpc.credentials.createInsecure());
    const metadata = new grpc.Metadata();
    metadata.add('authorization', 'Bearer ' + configuration.token);
    const unary = (method, request) => new Promise((resolve, reject) => client[method](request, metadata,
      {deadline: Date.now() + 5000}, (error, response) => error ? reject(error) : resolve(response)));
    await unary('setMicrophoneState', {realAudioEnabled: false});
    assert.equal((await unary('getMicrophoneState', {})).realAudioEnabled, false);
    evidence.host_microphone_enabled = false;

    evidence.phase = 'guest_recording';
    await adb('shell', 'pm', 'grant', observer, 'android.permission.RECORD_AUDIO');
    probe = instrumentation();
    assert.equal(await probe.started, true, 'Foreground Android capture was not ready');
    evidence.capture_started = true;
    injection = startToneInjection(client, metadata, source);
    const observation = await probe.closed;
    await injection.finish();
    evidence.rpc_completed = true;
    assert.equal(observation.exit, 0);
    assert.equal(observation.code, -1);
    evidence.capture_released = await fixtureInactive(observer);
    assert.equal(evidence.capture_released, true);
    evidence.frames = Number(observation.values.get('mic_control_frames'));
    evidence.windows_above_threshold = Number(observation.values.get('mic_control_windows_above'));
    evidence.median_amplitude_ppm = Number(observation.values.get('mic_control_amplitude_ppm'));
    evidence.route_type = Number(observation.values.get('mic_control_route_type'));
    evidence.client_silenced = observation.values.get('mic_control_silenced');
    assert.equal(evidence.frames, evidence.expected_frames);
    assert.ok(Number.isInteger(evidence.windows_above_threshold) && Number.isInteger(evidence.median_amplitude_ppm));
    assert.ok(Number.isInteger(evidence.route_type));
    assert.ok(['true', 'false', 'unknown'].includes(evidence.client_silenced));
    assert.ok(source.packets >= 200, 'Synthetic source did not cover the capture window');
    evidence.phase = 'signal';
    evidence.passed = evidence.windows_above_threshold >= 30 && evidence.median_amplitude_ppm > 10000;
    if (!evidence.passed) evidence.failure_class = 'CONTROL_GUEST_MICROPHONE_SIGNAL_MISSING';
  } catch {
    evidence.failure_class = 'CONTROL_GUEST_MICROPHONE_MEASUREMENT_FAILED';
  } finally {
    if (probe) {
      if (!evidence.capture_released) probe.stop();
      const {exit, code, values} = await probe.closed;
      evidence.instrumentation = {exit, code, error_type: values.get('error_type')};
    }
    if (injection) await injection.cancel();
    client?.close();
    evidence.synthetic_packets_submitted = source.packets;
    evidence.finished_at_ms = Date.now();
    fs.writeFileSync(args.output, JSON.stringify(evidence, null, 2) + '\n', {mode: 0o600});
  }
  if (!evidence.passed) {
    console.error(`Android microphone control failed: ${evidence.failure_class} (${evidence.phase})`);
    process.exitCode = 1;
  }
}

main().catch(() => { console.error('Unable to retain independent Android microphone control'); process.exitCode = 1; });
