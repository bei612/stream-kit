// Native IPC/lifecycle acceptance, without opening a microphone or speaker.
const { startAudioProbe } = require('./lib/audio-probe.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
async function run() {
  const executable = path.resolve(process.argv[2] || 'artifacts/example/audio-probe.exe');
  const probe = startAudioProbe(executable);
  const command = (op, device_id, schema_version=1, frequency_hz) =>
    probe.command(op, {device_id,schema_version,frequency_hz});
  try {
    const catalog=await command('devices');
    assert.equal(catalog.schema_version,1); assert.ok(Array.isArray(catalog.data.devices));
    assert.ok(catalog.data.devices.every(d=>d.id && d.name && (d.input||d.output)));
    for (const op of ['capture','tone','playback']) {
      assert.match((await command(op,'')).error,/explicit audio device/);
      assert.match((await command(op,'invalid-endpoint')).error,/.+/);
    }
    assert.match((await command('status',undefined,2)).error,/protocol version/);
    assert.match((await command('unknown')).error,/Unknown probe command/);
    assert.match((await command('analyze')).error,/Specify an analysis frequency/);
    assert.match((await command('analyze',undefined,1,1499)).error,/recorded audio/);
    assert.match((await command('analyze',undefined,1,24000)).error,/frequency/);
    const state=(await command('status')).data;
    assert.equal(state.state,'idle'); assert.equal(state.captured_frames,0); assert.equal(state.played_frames,0);
    assert.equal(state.input_state,'idle'); assert.equal(state.output_state,'idle');
    for (const op of ['stop_capture','stop_playback']) {
      const stopped=(await command(op)).data;
      assert.equal(stopped.input_state,'idle'); assert.equal(stopped.output_state,'idle');
    }
    assert.equal((await command('stop')).data.state,'idle');
    await probe.close();
    await assert.rejects(probe.command('status'), /closed/);
    const result={passed:true,scope:'Real native device enumeration, command validation and EOF lifecycle; no audio streams opened',devices:catalog.data.devices.length,finished_at:new Date().toISOString()};
    fs.mkdirSync('artifacts/example',{recursive:true});
    fs.writeFileSync('artifacts/example/audio-protocol-result.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
  } finally { await probe.close(); }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
