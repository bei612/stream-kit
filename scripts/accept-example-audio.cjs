// Explicit device pair only. Run against an isolated virtual audio server.
// Two native processes exercise the example's production recording/playback IPC.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {startAudioProbe} = require('./lib/audio-probe.cjs');

async function main() {
  const [executable, render, capture] = process.argv.slice(2);
  assert.ok(executable && render && capture && render !== capture,
    'Usage: node accept-example-audio.cjs AUDIO_PROBE RENDER_DEVICE CAPTURE_DEVICE');
  const output = path.resolve('artifacts/audio-target/example-pair-result.json');
  fs.mkdirSync(path.dirname(output), {recursive:true});
  const source = startAudioProbe(path.resolve(executable));
  const recorder = startAudioProbe(path.resolve(executable));
  const evidence = {passed:false, scope:'Two native example audio backends use explicitly selected virtual endpoints to record a tone and replay the recording. No browser, gateway, physical device or UE5 acceptance.'};
  const command = async (probe, op, parameters={}) => {
    const response = await probe.command(op, parameters);
    assert.equal(response.error, undefined, `${op}: ${response.error}`);
    return response.data;
  };
  const recorded = async (probe, frames) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const status = await command(probe, 'status');
      assert.equal(status.error, null);
      if (status.captured_frames >= frames) return status;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Recording did not reach ${frames} frames`);
  };
  const analyze = (probe, frequency_hz) => command(probe, 'analyze', {frequency_hz});
  try {
    for (const probe of [source, recorder]) {
      const {devices} = await command(probe, 'devices');
      assert.ok(devices.some(device => device.id === render && device.output));
      assert.ok(devices.some(device => device.id === capture && device.input));
    }
    await command(recorder, 'capture', {device_id:capture});
    await recorded(recorder, 24000);
    await command(recorder, 'stop_capture');
    evidence.baseline = await analyze(recorder, 997);
    assert.ok(evidence.baseline.peak_amplitude < 0.001, 'Isolated endpoint must start silent');

    await command(recorder, 'capture', {device_id:capture});
    await command(source, 'tone', {device_id:render});
    evidence.recording = await recorded(recorder, 240000);
    await command(recorder, 'stop_capture');
    await command(source, 'stop_playback');
    evidence.tone = await analyze(recorder, 997);
    evidence.foreign = await analyze(recorder, 1499);
    assert.ok(evidence.tone.peak_amplitude > 0.05, 'Recorded tone must contain the 997 Hz source');
    assert.ok(evidence.foreign.peak_amplitude < 0.005, 'Recording must reject unrelated frequency');

    // Swap roles: the previous recorder plays its stored samples, and the
    // previous generator independently records the resulting endpoint audio.
    await command(source, 'capture', {device_id:capture});
    await command(recorder, 'playback', {device_id:render});
    evidence.replay_recording = await recorded(source, 336000);
    await command(source, 'stop_capture');
    await command(recorder, 'stop_playback');
    evidence.replay = await analyze(source, 997);
    assert.ok(evidence.replay.peak_amplitude > 0.025, 'Re-recorded playback must contain the stored tone');
    evidence.passed = true;
  } catch (error) {
    evidence.error = error.message;
    console.error(JSON.stringify(evidence));
    throw error;
  } finally {
    const closed = await Promise.allSettled([source.close(), recorder.close()]);
    evidence.clean_exit = closed.every(result => result.status === 'fulfilled');
    evidence.passed &&= evidence.clean_exit;
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
    assert.ok(evidence.clean_exit, 'Both native processes must exit normally on EOF');
  }
  console.log('Example native tone, recording and replay acceptance passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
