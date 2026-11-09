// Official AVD microphone injection and output capture, with real native target
// recording and a real Web observer. No capture/transport API is replaced.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const grpc = require('../android/emulator-audio/node_modules/@grpc/grpc-js');
const loader = require('../android/emulator-audio/node_modules/@grpc/proto-loader');
const { assertContinuousInjection, validMonoPCM } = require('./emulator-audio-evidence.cjs');

async function verifyAndroidAudio({ android, adb, serial, page, api, sessionId, app, example, audioProbe, captureDevice, grpcConfig, sdk, report, save }) {
  assert.equal(process.platform, 'linux'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const state = report.android_audio = { passed: false, synthetic_source: true, physical_speech: false,
    scope: 'Published default-settings APK: actual application 997Hz to Android/Web, Android 1499Hz to native recorder/Web, continuous injection across revocation; no speech quality or physical device claim' }; save();
  const config = JSON.parse(fs.readFileSync(grpcConfig, 'utf8'));
  assert.match(config.address, /^127\.0\.0\.1:[0-9]+$/); assert.ok(config.token?.length > 16);
  const proto = grpc.loadPackageDefinition(loader.loadSync(path.join(sdk, 'emulator/lib/emulator_controller.proto'), { longs: String, defaults: true }));
  const client = new proto.android.emulation.control.EmulatorController(config.address, grpc.credentials.createInsecure());
  const metadata = new grpc.Metadata(); metadata.add('authorization', 'Bearer ' + config.token);
  const unary = (method, request) => new Promise((resolve, reject) => client[method](request, metadata, { deadline: Date.now()+5000 }, (error, result) => error ? reject(Error('Official emulator RPC failed: ' + method + '/' + error.code)) : resolve(result)));
  const command = async (op, parameters = {}) => { const response = await audioProbe.command(op, parameters); assert.ok(!response.error, 'Native recorder rejected ' + op); return response.data; };
  const until = async (read, check, label, timeout = 20000) => { const end = Date.now()+timeout; while (Date.now()<end) { const value = await read(); if (check(value)) return value; await delay(100); } throw Error('Android audio timeout: ' + label); };
  const current = () => api('/stream-sessions/' + sessionId);
  const run = args => { try { return cp.execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000, stdio: ['ignore','pipe','pipe'] }); } catch { throw Error('Official AVD UI command failed'); } };
  const click = target => { const output = run(['shell','am','instrument','-w','-e','action','click','-e','target',target,'io.github.bei612.streamkit.inputobserver/.Observer']); assert.match(output, /INSTRUMENTATION_RESULT: clicked=true/); };
  const audience = frequency => page.evaluate(async frequency => {
    const track = window.__acceptancePeers.at(-1).getReceivers().find(receiver => receiver.track.kind === 'audio')?.track;
    if (!track) throw Error('Real observer audio track missing');
    const context = new AudioContext(); await context.resume();
    try {
      const source = context.createMediaStreamSource(new MediaStream([track])), analyser = context.createAnalyser(), mute = context.createGain();
      analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0; mute.gain.value = 0;
      source.connect(analyser); analyser.connect(mute); mute.connect(context.destination);
      const bin = Math.round(frequency*4096/context.sampleRate), spectrum = new Float32Array(analyser.frequencyBinCount), values = [];
      for (let i=0;i<20;i++) { analyser.getFloatFrequencyData(spectrum); values.push(Math.max(-140,...spectrum.slice(bin-2,bin+3))); await new Promise(resolve => setTimeout(resolve,100)); }
      values.sort((a,b)=>a-b); return values[10];
    } finally { await context.close(); }
  }, frequency);
  const capture = async (phase, frequency = 1499) => {
    await command('capture', { device_id: captureDevice });
    await until(() => command('status'), value => !value.error && value.captured_frames >= 96000, 'native target PCM');
    await command('stop_capture');
    const signal = await command('analyze', { frequency_hz: frequency }), foreign = await command('analyze', { frequency_hz: 997 }), status = await command('status');
    assert.ok(signal.analyzed_frames >= 96000); assert.equal(status.dropped_frames, 0);
    state[phase] = { signal, program_997: foreign, status }; save(); return signal;
  };
  let injection, sending = false, sender, injectionDone, injectionError, native;
  const source = { packets: 0, senderEnded: false, rpcEnded: false, error: undefined };
  const stopWrites = new AbortController();
  try {
    await unary('setMicrophoneState', { realAudioEnabled: false });
    assert.equal((await unary('getMicrophoneState', {})).realAudioEnabled, false); state.host_microphone_enabled = false;
    // A fresh disposable AVD has no viewer preference override. Grant only the
    // ordinary OS permission; the actual UI still initiates microphone capture.
    run(['shell','pm','grant','io.github.bei612.streamkit','android.permission.RECORD_AUDIO']);
    const session = await current(), web = await page.evaluate(() => window.app.getStream().mediaAccess.connectionId);
    const ids = Object.keys(session.connections); assert.equal(ids.length, 2); native = ids.find(id => id !== web); assert.ok(native); assert.ok(!session.controller_connection_id);
    state.default_processing = { device_id: '', echoCancellation: true, noiseSuppression: true, autoGainControl: true, source: 'Fresh AVD; no preference writes or processing overrides' };
    const log = path.join(app.app_dir, 'output.log');
    const ownership = await until(() => fs.existsSync(log) ? fs.readFileSync(log,'utf8').split(/\r?\n/).flatMap(line => { try { const entry=JSON.parse(line); return entry.type==='stream-kit-audio-program'?[entry]:[]; } catch { return []; } }) : [], value => value.length===1, 'audio program ownership');
    const owned = ownership[0]; assert.equal(fs.realpathSync('/proc/'+owned.process_id+'/exe'), fs.realpathSync(example));
    assert.match(fs.readFileSync('/proc/'+owned.audio_process_id+'/status','utf8'), new RegExp('^PPid:\\s*'+owned.process_id+'$','m'));
    const sinks = JSON.parse(cp.execFileSync('pactl', ['--format=json','list','sink-inputs'], { encoding:'utf8' }));
    const stream = sinks.filter(item => item.properties?.['application.process.id'] === String(owned.audio_process_id)); assert.equal(stream.length,1,'Actual paplay child must own program audio');
    state.program_process_tree = { parent_pid:owned.process_id, audio_pid:owned.audio_process_id, pulse_sink_input_index:stream[0].index, pulse_sink:stream[0].sink }; save();
    state.web_program_997_db = report.program_audio_db?.[0];
    assert.ok(Number.isFinite(state.web_program_997_db) && state.web_program_997_db > -65, 'Real shared-harness Web program audio measurement missing');
    const pcm = []; let size = 0, playbackError;
    const playback = client.streamAudio({ samplingRate:'48000',channels:0,format:1 }, metadata, { deadline:Date.now()+8000 });
    const playbackDone = new Promise(resolve => { playback.on('error', error => { playbackError ??= error.code; resolve(); }); playback.on('end',resolve); });
    playback.on('data', packet => { if(!validMonoPCM(packet)){playbackError='incompatible_pcm_format';playback.cancel();return;} size += packet.audio.length; if(size>960000) playback.cancel(); else pcm.push(packet.audio); });
    await until(async()=>size,value=>value>=384000,'Android native output PCM',6500); playback.cancel(); await playbackDone;
    assert.ok(playbackError===undefined || playbackError===grpc.status.CANCELLED); assert.ok(size<=960000);
    const bytes=Buffer.concat(pcm), levels=[];
    for(let offset=0;offset+9600<=bytes.length;offset+=9600){let re=0,im=0;for(let i=0;i<4800;i++){const sample=bytes.readInt16LE(offset+i*2)/32768;re+=sample*Math.cos(2*Math.PI*997*i/48000);im+=sample*Math.sin(2*Math.PI*997*i/48000);}levels.push(2*Math.hypot(re,im)/4800);}
    levels.sort((a,b)=>a-b); state.android_program_pcm_bytes=bytes.length; state.android_program_997_median=levels[Math.floor(levels.length/2)]||0;
    assert.ok(state.android_program_997_median>0.01, 'Android playout missing 997Hz program'); save();
    const baseline = await capture('baseline'); assert.ok(baseline.peak_amplitude<0.001); assert.ok(state.baseline.program_997.peak_amplitude<0.005, 'Program audio leaked into microphone target');
    await api('/stream-sessions/'+sessionId+'/controller/'+native,'POST'); await android.role(true);
    click('打开串流工具栏'); click('麦克风已关闭');
    await until(current,s=>s.connections[native]?.microphone_live===true,'Android microphone capture');
    injectionDone = new Promise(resolve => { injection=client.injectAudio(metadata,{deadline:Date.now()+35000},error=>{injectionError=error?.code;source.error=injectionError;source.rpcEnded=true;stopWrites.abort();resolve();}); injection.on('error',()=>{}); });
    sending=true; sender=(async()=>{let n=0;const started=Date.now();while(sending&&n<1500){if(source.rpcEnded)throw Error('Official microphone injection ended while sending');const data=Buffer.alloc(1920);for(let i=0;i<960;i++)data.writeInt16LE(Math.round(32767*Math.pow(10,-18/20)*Math.sin(2*Math.PI*1499*(n*960+i)/48000)),i*2);
      if(!injection.write({format:{samplingRate:'48000',channels:0,format:1,mode:1},timestamp:String(Date.now()*1000),audio:data})) {
        try { await once(injection,'drain',{signal:stopWrites.signal}); }
        catch(error) { if(!sending&&error.name==='AbortError')break;throw error; }
      }
      n++;source.packets=n;await delay(Math.max(0,started+n*20-Date.now()));}source.senderEnded=true;if(!source.rpcEnded)injection.end();})();
    void sender.catch(()=>{}); // The measurement branch awaits and reports its actual failure below.
    const [authorized, audible] = await Promise.all([capture('authorized'),audience(1499)]); state.authorized_web_1499_db=audible;
    assert.ok(authorized.mean_amplitude>0.01,'Authorized Android microphone absent at native target'); assert.ok(audible>-60,'Authorized Android microphone absent at Web observer'); save();
    assertContinuousInjection(source, 0);
    const packetsBeforeRevocation=source.packets; state.injection_packets_before_revocation=packetsBeforeRevocation;
    const granted = await current(); state.authorized_control_epoch=granted.control_epoch;
    await api('/stream-sessions/'+sessionId+'/controller','DELETE');
    const revoked = await until(current,s=>!s.controller_connection_id&&!s.connections[native]?.microphone_live,'revoked Android capture stops'); state.revoked_control_epoch=revoked.control_epoch; assert.ok(revoked.control_epoch>granted.control_epoch);
    await android.role(false); await delay(1500); state.capture_stop_settling_ms=1500;
    const [silent, inaudible] = await Promise.all([capture('revoked'),audience(1499)]); state.revoked_web_1499_db=inaudible;
    assertContinuousInjection(source, packetsBeforeRevocation); state.injection_packets_after_revoked_measurement=source.packets;
    assert.ok(silent.peak_amplitude<0.001,'Revoked microphone reached native target'); assert.ok(inaudible<-65,'Revoked microphone reached Web observer');
    state.web_program_after_revocation_997_db=await audience(997); assert.ok(state.web_program_after_revocation_997_db>-65,'Revocation interrupted program audio');
    sending=false; await sender; await injectionDone; assert.equal(injectionError,undefined,'Official emulator injection failed'); state.injection_completed=true;
    assert.equal(run(['shell','getprop','sys.boot_completed']).trim(),'1'); state.passed=true; save();
  } finally {
    sending=false;
    stopWrites.abort();
    if(injection)injection.cancel();
    if (sender) await sender.catch(()=>{});
    client.close();
    try { await command('stop_capture'); } catch { state.recorder_cleanup_failed=true; state.passed=false; save(); }
    if(native){const session=await current(); if(session.controller_connection_id===native)await api('/stream-sessions/'+sessionId+'/controller','DELETE');}
  }
}
module.exports = { verifyAndroidAudio };
