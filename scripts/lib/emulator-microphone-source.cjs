'use strict';

const assert = require('node:assert/strict');
const {execFile} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {promisify} = require('node:util');
const {setTimeout: delay} = require('node:timers/promises');
const {startToneInjection} = require('./emulator-audio-injection.cjs');

const sinkName = 'streamkit_guest_input';
const sourceName = `${sinkName}.monitor`;
const exec = promisify(execFile);

// Host-input forwarding is permitted only on a disposable runner whose private
// server has no hardware sources. Both guest capture and product tests use it.
async function configureMicrophoneSource(unary, evidence) {
  const kind = process.env.STREAM_KIT_AUDIO_MICROPHONE_SOURCE || 'emulator-rpc';
  assert.ok(['emulator-rpc', 'pulse-monitor'].includes(kind));
  evidence.microphone_source = kind;
  evidence.physical_microphone_used = false;
  const setForwarding = async enabled => {
    await unary('setMicrophoneState', {realAudioEnabled: enabled});
    assert.equal((await unary('getMicrophoneState', {})).realAudioEnabled, enabled);
    evidence.host_microphone_forwarding = enabled;
  };
  const close = async () => {
    await setForwarding(false);
    evidence.microphone_input_restored = true;
  };
  if (kind === 'emulator-rpc') {
    await setForwarding(false);
    return {start: startToneInjection, close};
  }

  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  const socket = process.env.STREAM_KIT_AUDIO_PULSE_SOCKET;
  assert.ok(path.isAbsolute(socket) && fs.statSync(socket).isSocket());
  assert.equal(process.env.PULSE_SERVER, `unix:${socket}`);
  const pulse = async (command, ...args) => JSON.parse((await exec('pactl',
    [`--server=unix:${socket}`, '--format=json', command, ...args], {timeout: 2500})).stdout);
  const [info, modules, sources, sinks] = await Promise.all([
    pulse('info'), pulse('list', 'modules'), pulse('list', 'sources'), pulse('list', 'sinks'),
  ]);
  assert.equal(info.default_source_name, sourceName);
  assert.ok(modules.every(module => ['module-null-sink', 'module-remap-source', 'module-native-protocol-unix'].includes(module.name)),
    'Isolated PulseAudio server must not load hardware or network sources');
  const sink = sinks.find(item => item.name === sinkName);
  const source = sources.find(item => item.name === sourceName);
  assert.ok(sink && source && source.monitor_source === sinkName && !sink.mute && !source.mute);
  const emulator = process.env.STREAM_KIT_AUDIO_EMULATOR_ROOT_PID;
  assert.match(emulator, /^[1-9][0-9]*$/);
  const expected = fs.realpathSync(path.join(process.env.STREAM_KIT_AUDIO_EMULATOR_DIR, 'qemu/linux-x86_64/qemu-system-x86_64'));
  assert.equal(fs.realpathSync(`/proc/${emulator}/exe`), expected);
  evidence.private_pulse_monitor_verified = true;
  try { await setForwarding(true); }
  catch (error) { await close(); throw error; }

  return {
    close,
    start(client, metadata, progress) {
      const tone = startToneInjection(client, metadata, progress, {pulseSink: sinkName});
      return {...tone, async verifyRoute() {
        const deadline = Date.now() + 3500;
        do {
          const [reads, writes] = await Promise.all([pulse('list', 'source-outputs'), pulse('list', 'sink-inputs')]);
          const readers = reads.filter(item => item.properties?.['application.process.id'] === emulator);
          const writers = writes.filter(item => item.sink === sink.index);
          assert.ok(readers.every(item => item.source === source.index), 'Emulator has another PulseAudio capture route');
          assert.ok(writers.every(item => item.properties?.['application.process.id'] === String(tone.pid)),
            'Unexpected writer on the synthetic source');
          if (readers.some(item => !item.mute && !item.corked) && writers.some(item => !item.mute && !item.corked)) {
            evidence.guest_input_route = {source_index: source.index, sink_index: sink.index,
              emulator_pid: Number(emulator), tone_pid: tone.pid, observed_at_ms: Date.now()};
            return;
          }
          await delay(50);
        } while (Date.now() < deadline);
        throw Error('Emulator did not read the isolated synthetic sound source');
      }};
    },
  };
}

module.exports = {configureMicrophoneSource};
