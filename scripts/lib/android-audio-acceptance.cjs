// Official AVD microphone injection, actual isolated PulseAudio playout and
// native target recording, with a real Web observer. No product API is replaced.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const grpc = require('../android/emulator-audio/node_modules/@grpc/grpc-js');
const loader = require('../android/emulator-audio/node_modules/@grpc/proto-loader');
const { assertContinuousInjection } = require('./emulator-audio-evidence.cjs');

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
  const metadataCommand=(executable,args)=>new Promise(resolve=>{
    const started=Date.now();cp.execFile(executable,args,{encoding:'utf8',timeout:5000,maxBuffer:512*1024},(error,output)=>resolve({started_at_ms:started,finished_at_ms:Date.now(),...(error?{error_code:error.code||'command_failed'}:{output})}));
  });
  const recorderRoute=(sourcesResult,outputsResult,modulesResult,infoResult,expectedActive)=>{
    const route={recorder_expected_active:expectedActive,recorder_process_id:audioProbe.pid,recorder_owner_verified:false,unavailable:[],pulse_source_outputs:[],pulse_readers:[],pulse_source_outputs_observation:{started_at_ms:outputsResult.started_at_ms,finished_at_ms:outputsResult.finished_at_ms}};
    try{route.recorder_owner_verified=fs.realpathSync('/proc/'+audioProbe.pid+'/exe')===fs.realpathSync(audioProbe.executable);}catch{}
    const parse=(result,name)=>{if(result.error_code){route.unavailable.push({source:name,code:result.error_code});return [];}try{const value=JSON.parse(result.output);if(name==='pulse_info'?(!value||typeof value!=='object'||Array.isArray(value)):!Array.isArray(value))throw Error('Invalid metadata shape');return value;}catch{route.unavailable.push({source:name,code:'invalid_metadata_json'});return [];}};
    const sources=parse(sourcesResult,'pulse_sources'),outputs=parse(outputsResult,'pulse_source_outputs'),modules=parse(modulesResult,'pulse_modules'),info=parse(infoResult,'pulse_info');
    const source=sources.find(item=>item.name==='streamkit_android_capture'),master=sources.find(item=>item.name==='streamkit_android.monitor');
    const module=modules.find(item=>item.index===source?.owner_module);
    const args=module?.argument?.trim().split(/\s+/)||[];
    const verifiedRemap=!!(source&&master&&module?.name==='module-remap-source'&&args.includes('master=streamkit_android.monitor')&&args.includes('source_name=streamkit_android_capture')&&source.properties?.['device.master_device']===master.name);
    route.capture_source_index=source?.index;route.master_source_index=master?.index;route.remap_module_index=module?.index;route.remap_module_verified=verifiedRemap;
    const knownSources=new Set(['streamkit_host.monitor','streamkit_android.monitor','streamkit_android_capture','streamkit_program.monitor','streamkit_microphone.monitor','streamkit_microphone_capture']);
    route.default_source=knownSources.has(info.default_source_name)?info.default_source_name:'unrecognized';
    for(const item of outputs.filter(item=>item.source===source?.index||item.source===master?.index)){
      const pid=/^[1-9][0-9]*$/.test(item.properties?.['application.process.id']||'')?Number(item.properties['application.process.id']):undefined;
      let owner='unidentified';
      if(pid===audioProbe.pid&&route.recorder_owner_verified)owner='owned_probe';
      else if(pid&&(state.emulator_audio_backend?.process_tree||[]).some(proc=>proc.pid===pid&&proc.exe===state.emulator_audio_backend.required_binary)){
        try{if(fs.realpathSync('/proc/'+pid+'/exe')===state.emulator_audio_backend.required_binary)owner='owned_emulator';}catch{}
      }
      if(owner==='unidentified'&&verifiedRemap&&item.owner_module===module.index&&item.source===master.index&&(item.client===null||item.client===4294967295)&&item.properties?.['media.role']==='filter')owner='verified_internal_remap';
      if(owner==='unidentified'&&pid)owner='other_client';
      const knownNames=new Set(['qemu','QEMU','cpal','audio-probe','PulseAudio']);
      const reader={index:item.index,source:item.source,client:Number.isInteger(item.client)?item.client:null,owner_module:Number.isInteger(item.owner_module)?item.owner_module:null,process_id:pid,owner,application_name:knownNames.has(item.properties?.['application.name'])?item.properties['application.name']:'unrecognized',sample_specification:item.sample_specification,mute:item.mute,corked:item.corked,volume:item.volume};
      route.pulse_readers.push(reader);
      if(owner==='owned_probe'&&source&&item.source===source.index)route.pulse_source_outputs.push(reader);
    }
    route.other_reader_count=route.pulse_readers.filter(item=>item.owner!=='owned_probe').length;
    return route;
  };
  const observeRecordingRoute=async()=>{
    const started=Date.now();
    const results=await Promise.all(['sources','source-outputs','modules'].map(kind=>metadataCommand('pactl',['--format=json','list',kind])).concat(metadataCommand('pactl',['--format=json','info'])));
    const snapshot={started_at_ms:started,finished_at_ms:Date.now(),...recorderRoute(...results,true)};
    (state.playback_metadata||={}).during_recording=snapshot;save();return snapshot;
  };
  const playbackMetadata=async phase=>{
    const started=Date.now();
    const results=await Promise.all([
      metadataCommand(adb,['-s',serial,'shell','pidof','io.github.bei612.streamkit']),
      metadataCommand(adb,['-s',serial,'shell','dumpsys','audio']),
      metadataCommand(adb,['-s',serial,'shell','dumpsys','media.audio_flinger']),
      ...['sink-inputs','sinks','sources','source-outputs','modules'].map(kind=>metadataCommand('pactl',['--format=json','list',kind])),
      metadataCommand('pactl',['--format=json','info']),
      android.diagnostics()
    ]);
    const snapshot={started_at_ms:started,finished_at_ms:Date.now(),native_client:results[9],unavailable:results.flatMap((value,index)=>value.error_code?[{source:['app_pid','android_audio','audio_flinger','pulse_inputs','pulse_sinks','pulse_sources','pulse_source_outputs','pulse_modules','pulse_info'][index],code:value.error_code}]:[])};
    const pids=(results[0].output||'').trim().split(/\s+/).filter(pid=>/^[1-9][0-9]*$/.test(pid));snapshot.application_pids=pids.map(Number);
    const audio=(results[1].output||'').split(/\r?\n/),streams={};let stream;
    snapshot.focus=audio.filter(line=>/\b(?:gain|loss):/.test(line)&&/\bpack:/.test(line)).slice(0,16).map(line=>{
      const fields={application_owner:/\bpack:\s*io\.github\.bei612\.streamkit(?:\s|$)/.test(line)};
      for(const key of ['gain','loss','flags','notified','uid','sdk'])fields[key]=line.match(new RegExp('\\b'+key+':\\s*([A-Za-z0-9_.+-]+)'))?.[1];
      fields.usage=line.match(/\busage=(USAGE_[A-Z_]+)/)?.[1];return fields;
    });
    snapshot.audio_mode={requested:audio.join('\n').match(/Requested mode:\s*(MODE_[A-Z_]+)/)?.[1],actual:audio.join('\n').match(/Actual mode:\s*(MODE_[A-Z_]+)/)?.[1]};
    for(const line of audio){
      const header=line.match(/^\s*(?:-\s*)?(STREAM_[A-Z_]+):/);
      if(header){stream=['STREAM_VOICE_CALL','STREAM_MUSIC'].includes(header[1])?(streams[header[1]]={}):null;}
      if(!stream)continue;
      for(const key of ['Muted','Min','Max']){const value=line.match(new RegExp('\\b'+key+':\\s*(true|false|[0-9]+)'));if(value)stream[key.toLowerCase()]=value[1]==='true'?true:value[1]==='false'?false:Number(value[1]);}
      if(/\bCurrent:/.test(line))stream.current_devices=[...line.matchAll(/([0-9a-fx]+)\s*\(([A-Za-z0-9_ -]+)\):\s*([0-9]+)/g)].map(match=>({device:match[1],name:match[2],volume:Number(match[3])}));
    }
    snapshot.streams=streams;
    snapshot.application_playback=audio.filter(line=>pids.some(pid=>new RegExp('\\b(?:u/pid:\\s*[0-9]+/|pid[:=]\\s*)'+pid+'\\b').test(line))).slice(0,12).map(line=>({
      state:line.match(/\bstate[:=]\s*([A-Za-z_]+)/)?.[1],usage:line.match(/\busage=(USAGE_[A-Z_]+)/)?.[1],content:line.match(/\bcontent=(CONTENT_TYPE_[A-Z_]+)/)?.[1]
    }));
    snapshot.output_threads=[];let thread;
    for(const line of (results[2].output||'').split(/\r?\n/)){
      if(/^Output thread\b/.test(line)){thread={tracks:[]};snapshot.output_threads.push(thread);}
      else if(/^\s*(?:-\s*)?(?:Input|Mmap|Record) thread\b/.test(line))thread=null;
      if(!thread)continue;
      const rate=line.match(/^\s*Sample rate:\s*([0-9]+)/),frames=line.match(/^\s*Frames written:\s*([0-9]+)/),standby=line.match(/^\s*Standby:\s*(yes|no)/);
      if(rate)thread.sample_rate=Number(rate[1]);if(frames)thread.frames_written=Number(frames[1]);if(standby)thread.standby=standby[1];
      if(line.includes('Client(pid/uid)'))thread.track_columns=line.trim();
      if(/^\s*(?:[A-Za-z*+-]\s+)?[0-9]+\s/.test(line)&&/^[0-9A-Za-z_+*./()%?\s-]+$/.test(line)&&pids.some(pid=>new RegExp('(?:^|\\s)'+pid+'\\s*/\\s*[0-9]+(?:\\s|$)').test(line)))thread.tracks.push(line.trim());
    }
    for(const thread of snapshot.output_threads)thread.owned_track_count=thread.tracks.length;
    const pulse=(index,name)=>{try{return JSON.parse(results[index].output||'[]').filter(item=>name(item)).map(item=>({index:item.index,name:item.name,sink:item.sink,process_id:item.properties?.['application.process.id'],sample_specification:item.sample_specification,mute:item.mute,corked:item.corked,volume:item.volume,state:item.state,master_device:item.properties?.['device.master_device']}));}catch{snapshot.unavailable.push({source:['pulse_inputs','pulse_sinks','pulse_sources'][index-3],code:'invalid_metadata_json'});return [];}};
    const emulatorPids=new Set((state.emulator_audio_backend?.process_tree||[]).filter(proc=>proc.exe===state.emulator_audio_backend.required_binary).map(proc=>String(proc.pid)));
    snapshot.pulse_inputs=pulse(3,item=>emulatorPids.has(item.properties?.['application.process.id']));
    snapshot.pulse_sinks=pulse(4,item=>item.name==='streamkit_android');snapshot.pulse_sources=pulse(5,item=>item.name==='streamkit_android_capture');
    const route=recorderRoute(results[5],results[6],results[7],results[8],false);snapshot.unavailable.push(...route.unavailable);delete route.unavailable;Object.assign(snapshot,route);
    (state.playback_metadata||={})[phase]=snapshot;save();
  };
  const prepareObserver = () => page.evaluate(async () => {
    const track = window.__acceptancePeers.at(-1).getReceivers().find(receiver => receiver.track.kind === 'audio')?.track;
    if (!track) throw Error('Real observer audio track missing');
    const context = new AudioContext(); await context.resume();
    const source = context.createMediaStreamSource(new MediaStream([track])), analyser = context.createAnalyser(), mute = context.createGain();
    analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0; mute.gain.value = 0;
    source.connect(analyser); analyser.connect(mute); mute.connect(context.destination);
    window.__androidAudioObserver = { context, source, analyser, mute, track, peer: window.__acceptancePeers.at(-1) };
    return { started_at_ms: Date.now(), sample_rate: context.sampleRate, fft_size: analyser.fftSize, base_latency_s:context.baseLatency, output_latency_s:context.outputLatency };
  });
  const webSample = async () => {
    const before = Date.now();
    const sample = await page.evaluate(async () => {
      const observer = window.__androidAudioObserver;
      if (!observer || observer.peer !== window.__acceptancePeers.at(-1) || observer.context.state !== 'running') throw Error('Real observer graph changed or stopped');
      const spectrum = new Float32Array(observer.analyser.frequencyBinCount); observer.analyser.getFloatFrequencyData(spectrum);
      const frequency = value => { const bin = Math.round(value*observer.analyser.fftSize/observer.context.sampleRate); return Math.max(-140,...spectrum.slice(bin-2,bin+3)); };
      const allStats = [...(await observer.peer.getStats()).values()];
      const stats = allStats.filter(s => s.type==='inbound-rtp'&&(s.kind==='audio'||s.mediaType==='audio'));
      return { at_ms:Date.now(), context_time_s:observer.context.currentTime, track:{state:observer.track.readyState,enabled:observer.track.enabled,muted:observer.track.muted}, program_997_db:frequency(997), microphone_1499_db:frequency(1499),
        codecs:allStats.filter(s=>s.type==='codec'&&stats.some(track=>track.codecId===s.id)).map(s=>({mime:s.mimeType,clock_rate:s.clockRate,channels:s.channels,fmtp:s.sdpFmtpLine})),
        rtp:stats.map(s=>({packets:s.packetsReceived,bytes:s.bytesReceived,lost:s.packetsLost,jitter_s:s.jitter,jitter_buffer_delay_s:s.jitterBufferDelay,jitter_buffer_emitted:s.jitterBufferEmittedCount,samples:s.totalSamplesReceived,samples_duration_s:s.totalSamplesDuration,audio_energy:s.totalAudioEnergy,concealed_samples:s.concealedSamples})) };
    });
    return { ...sample, command_started_at_ms:before, command_finished_at_ms:Date.now(), injection_packets:source.packets, last_injection_at_ms:source.last_packet_at_ms };
  };
  state.web_windows = {};
  const audience = async (phase, frequency=1499) => {
    const samples = state.web_windows[phase] = [];
    for(let i=0;i<20;i++){ samples.push(await webSample()); await delay(100); }
    const levels=samples.map(s=>frequency===997?s.program_997_db:s.microphone_1499_db).sort((a,b)=>a-b); save(); return levels[10];
  };
  const measureWebProgram = async () => {
    const startup=state.program_startup={started_at_ms:Date.now(),limit_ms:5000,required_consecutive_samples:3,threshold_db:-65,samples:[]};save();
    try {
      let consecutive=0;
      while(Date.now()-startup.started_at_ms<5000){
        const sample=await webSample();startup.samples.push(sample);save();
        consecutive=sample.program_997_db>-65?consecutive+1:0;
        if(consecutive===3){startup.observed_ready_ms=Date.now()-startup.started_at_ms;break;}
        await delay(100);
      }
      assert.ok(startup.observed_ready_ms!==undefined&&startup.observed_ready_ms<=5000,'Real Web observer program did not reach three consecutive samples within 5000ms');
      startup.measurement_started_at_ms=Date.now();save();
      const samples=state.web_windows.program=[];
      for(let i=0;i<20;i++){samples.push(await webSample());save();await delay(100);}
      const levels=samples.map(sample=>sample.program_997_db).sort((a,b)=>a-b);
      state.web_program_997_db=(levels[9]+levels[10])/2;
      startup.measurement_finished_at_ms=Date.now();
      report.program_audio_db=[state.web_program_997_db];save();
      assert.ok(startup.measurement_finished_at_ms-startup.measurement_started_at_ms>=2000,'Web program measurement must span at least 2000ms');
      assert.ok(state.web_program_997_db>-65,'Real Web observer is missing sustained 997Hz program');
    } catch(error){startup.error=error.message;startup.failed_at_ms=Date.now();save();throw error;}
  };
  const waitForActualMicrophone = async () => {
    state.microphone_startup = { limit_ms:5000, required_consecutive_samples:3, threshold_db:-60, samples:[] }; save();
    let consecutive=0;
    while(Date.now()-source.started_at_ms<5000) {
      assertContinuousInjection(source,0);
      const sample=await webSample();state.microphone_startup.samples.push(sample);
      consecutive=sample.microphone_1499_db>-60?consecutive+1:0;
      if(consecutive===3){state.microphone_startup.observed_ready_ms=Date.now()-source.started_at_ms;save();return;}
      await delay(100);
    }
    save();throw Error('Real observer microphone did not reach three consecutive authorized samples within 5000ms');
  };
  const capture = async (phase, frequency = 1499, duringCapture) => {
    const started=Date.now(), packetsAtStart=source.packets;
    await command('capture', { device_id: captureDevice });
    let measurementError;
    try {
      if(duringCapture) await duringCapture();
      await until(() => command('status'), value => !value.error && value.captured_frames >= (duringCapture?4800:96000), 'native target PCM');
    } catch(error) { measurementError=error; }
    await command('stop_capture');
    const stopped=Date.now(), packetsAtStop=source.packets;
    const signal = await command('analyze', { frequency_hz: frequency }), foreign = await command('analyze', { frequency_hz: 997 }), envelope = await command('envelope'), status = await command('status');
    assert.ok(signal.analyzed_frames >= (duringCapture?4800:96000)); assert.equal(status.dropped_frames, 0);
    state[phase] = { started_at_ms:started, stopped_at_ms:stopped, injection_packets_at_start:packetsAtStart, injection_packets_at_stop:packetsAtStop, signal, program_997: foreign, envelope, status }; save();
    if(measurementError)throw measurementError;return signal;
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
    const sinkCatalog = JSON.parse(cp.execFileSync('pactl', ['--format=json','list','sinks'], { encoding:'utf8', timeout:5000 }));
    const sinkIndex = name => { const found=sinkCatalog.filter(s=>s.name===name); assert.equal(found.length,1,'Required isolated audio sink missing: '+name); return found[0].index; };
    const hostSink=sinkIndex('streamkit_host'),androidSink=sinkIndex('streamkit_android'),programSink=sinkIndex('streamkit_program'),microphoneSink=sinkIndex('streamkit_microphone');
    assert.equal(new Set([hostSink,androidSink,programSink,microphoneSink]).size,4);
    assert.equal(stream[0].sink,programSink,'Actual program child must render only to the program sink');
    const rootPid=process.env.STREAM_KIT_AUDIO_EMULATOR_ROOT_PID;
    assert.match(rootPid||'',/^[1-9][0-9]*$/,'Owned emulator launcher PID is required');
    const expectedEmulator=fs.realpathSync(path.join(sdk,'emulator/qemu/linux-x86_64/qemu-system-x86_64'));
    state.emulator_audio_backend={required_binary:expectedEmulator,launcher_pid:Number(rootPid),required_sink:'streamkit_android',status:'waiting_for_real_pulse_output',started_at_ms:Date.now()};save();
    const observeBackend=()=>{
      const processes=[];
      for(const entry of fs.readdirSync('/proc')){
        if(!/^[1-9][0-9]*$/.test(entry))continue;
        try{
          const status=fs.readFileSync('/proc/'+entry+'/status','utf8'),ppid=Number(status.match(/^PPid:\s*(\d+)$/m)?.[1]);
          processes.push({pid:Number(entry),parent_pid:ppid,exe:fs.realpathSync('/proc/'+entry+'/exe')});
        }catch(error){if(!['ENOENT','ESRCH','EACCES','EPERM'].includes(error.code))throw error;}
      }
      const descendants=new Set([Number(rootPid)]);
      let grew=true;while(grew){grew=false;for(const proc of processes)if(descendants.has(proc.parent_pid)&&!descendants.has(proc.pid)){descendants.add(proc.pid);grew=true;}}
      const tree=processes.filter(proc=>descendants.has(proc.pid));
      state.emulator_audio_backend.process_tree=tree;save();
      assert.ok(tree.some(proc=>proc.pid===Number(rootPid)),'Owned emulator launcher exited');
      assert.ok(!tree.some(proc=>/qemu-system-.*-headless$/.test(path.basename(proc.exe))),'Headless emulator cannot validate the real PulseAudio backend');
      const emulatorPids=new Set(tree.filter(proc=>proc.exe===expectedEmulator).map(proc=>String(proc.pid)));
      const actualInputs=JSON.parse(cp.execFileSync('pactl',['--format=json','list','sink-inputs'],{encoding:'utf8',timeout:5000}));
      const emulatorInputs=actualInputs.filter(item=>emulatorPids.has(item.properties?.['application.process.id']));
      const androidInputs=actualInputs.filter(item=>item.sink===androidSink);
      state.emulator_audio_backend.sink_inputs=emulatorInputs.map(item=>({index:item.index,process_id:Number(item.properties['application.process.id']),sink:item.sink,sample_specification:item.sample_specification,mute:item.mute,corked:item.corked,volume:item.volume}));
      state.emulator_audio_backend.android_sink_inputs=androidInputs.map(item=>({index:item.index,process_id:Number(item.properties?.['application.process.id']),sink:item.sink,sample_specification:item.sample_specification,mute:item.mute,corked:item.corked,volume:item.volume}));
      state.emulator_audio_backend.observed_at_ms=Date.now();
      save();
      assert.ok(emulatorInputs.every(item=>item.sink===androidSink),'Owned emulator audio must render only to its dedicated Android sink');
      assert.ok(androidInputs.every(item=>emulatorPids.has(item.properties?.['application.process.id'])),'A non-emulator process contaminated the dedicated Android sink');
      return emulatorPids.size>0&&emulatorInputs.length>0;
    };
    try { await until(observeBackend,ready=>ready,'full official emulator with an owned real PulseAudio output',5000); }
    catch(error){state.emulator_audio_backend.status='failed';state.emulator_audio_backend.error=error.message;state.emulator_audio_backend.failed_at_ms=Date.now();save();throw error;}
    state.emulator_audio_backend.status='verified_real_pulse_output';state.emulator_audio_backend.verified_at_ms=Date.now();save();
    await playbackMetadata('before_recording');
    state.observer = await prepareObserver(); save();
    const captureAndroidPlayout=async()=>{
      const androidCaptureDevice='pulseaudio:streamkit_android_capture';
      const devices=await command('devices');
      assert.ok(devices.devices.some(device=>device.id===androidCaptureDevice&&device.input),'Dedicated Android playout capture endpoint is unavailable');
      const playout=state.android_playout={capture_device_id:androidCaptureDevice,minimum_frames:192000,collection_limit_ms:6500,minimum_997_median_amplitude:0.01,started_at_ms:Date.now(),samples:[]};save();
      let playoutError,duringRecording,stopRpcObservation;
      try {
        // Independently observe the emulator's output in the same collection
        // window. This does not replace or relax the actual PulseAudio gate.
        try {stopRpcObservation=require('../android/emulator-playout-observation.cjs').observeEmulatorPlayout(client,metadata);}
        catch {playout.emulator_output_rpc={diagnostic_only:true,failure:'RPC_OBSERVATION_UNAVAILABLE'};save();}
        playout.initial_status=await command('capture',{device_id:androidCaptureDevice});save();
        duringRecording=observeRecordingRoute();void duringRecording.catch(()=>{});
        await until(async()=>{
          assert.ok(observeBackend(),'Owned emulator PulseAudio output disappeared during capture');
          const status=await command('status');
          playout.samples.push({at_ms:Date.now(),...status,emulator_sink_inputs:state.emulator_audio_backend.sink_inputs});save();
          assert.ok(!status.error,'Android playout recorder failed: '+status.error);
          assert.equal(status.input_state,'capture');assert.equal(status.sample_rate,48000);assert.equal(status.dropped_frames,0);
          return status.captured_frames;
        },frames=>frames>=192000,'dedicated Android playout PCM',6500-(Date.now()-playout.started_at_ms));
      } catch(error){playoutError=error;playout.collection_error=error.message;save();}
      finally {
        playout.collection_finished_at_ms=Date.now();
        try {playout.status=await command('stop_capture');}
        finally {if(stopRpcObservation)playout.emulator_output_rpc=await stopRpcObservation();save();}
        if(duringRecording)await duringRecording;await playbackMetadata('after_recording');
      }
      if(playout.status.captured_frames>=4800){
        playout.signal=await command('analyze',{frequency_hz:997});playout.envelope=await command('envelope');save();
      }
      if(playout.signal&&playout.signal.median_amplitude<=0.01){
        try{playout.stereo_diagnostics=await require('../android/pulse-playout-diagnostics.cjs').collectPulsePlayoutDiagnostics();}
        catch{playout.stereo_diagnostics={diagnostic_only:true,status:'diagnostic_failed'};}
        save();
      }
      if(playoutError)throw playoutError;
      assert.ok(observeBackend(),'Owned emulator PulseAudio output disappeared after capture');
      assert.equal(playout.status.sample_rate,48000);assert.equal(playout.status.dropped_frames,0);
      assert.ok(playout.status.captured_frames>=192000);assert.ok(playout.signal.analyzed_frames>=192000);
      assert.ok(playout.collection_finished_at_ms-playout.started_at_ms<=6500,'Android playout collection exceeded its 6500ms limit');
      const recorder=state.playback_metadata.during_recording;
      assert.ok(recorder.recorder_owner_verified&&recorder.pulse_source_outputs.length>0,'Owned native recorder stream must be observed on the Android capture source');
      assert.ok(recorder.pulse_source_outputs_observation.started_at_ms>=playout.started_at_ms&&recorder.pulse_source_outputs_observation.finished_at_ms<=playout.collection_finished_at_ms,'Recorder route observation must fall inside the actual recording window');
      state.android_program_997_median=playout.signal.median_amplitude;save();
      assert.ok(state.android_program_997_median>0.01,'Android playout missing sustained 997Hz program');
    };
    // Join both real observers even if one fails, so capture cleanup and all
    // failure evidence finish before the graph or probe can be closed.
    const programResults=await Promise.allSettled([captureAndroidPlayout(),measureWebProgram()]);
    for(const result of programResults)if(result.status==='rejected')throw result.reason;
    const baseline = await capture('baseline'); assert.ok(baseline.peak_amplitude<0.001); assert.ok(state.baseline.program_997.peak_amplitude<0.005, 'Program audio leaked into microphone target');
    state.observer_before_injection = await webSample();
    assert.ok(state.observer_before_injection.program_997_db>-65,'Persistent Web observer must hear the real program before injection'); save();
    await api('/stream-sessions/'+sessionId+'/controller/'+native,'POST'); await android.role(true);
    click('打开串流工具栏'); click('麦克风已关闭');
    await until(current,s=>s.connections[native]?.microphone_live===true,'Android microphone capture');
    const beforeInjection=await current();
    state.authority_before_injection={revision:beforeInjection.revision,control_epoch:beforeInjection.control_epoch,controller_connection_id:beforeInjection.controller_connection_id,web_connection_id:web,web_role:beforeInjection.connections[web]?.role,audio:beforeInjection.audio};
    assert.equal(beforeInjection.controller_connection_id,native);assert.equal(beforeInjection.audio.broadcast_controller_microphone,true);
    assert.equal(beforeInjection.connections[web]?.role,'viewer');
    source.started_at_ms=Date.now();state.injection_started_at_ms=source.started_at_ms;save();
    injectionDone = new Promise(resolve => { injection=client.injectAudio(metadata,{deadline:Date.now()+35000},error=>{injectionError=error?.code;source.error=injectionError;source.rpcEnded=true;stopWrites.abort();resolve();}); injection.on('error',()=>{}); });
    sending=true; sender=(async()=>{let n=0;const started=source.started_at_ms;while(sending&&n<1500){if(source.rpcEnded)throw Error('Official microphone injection ended while sending');const data=Buffer.alloc(1920);for(let i=0;i<960;i++)data.writeInt16LE(Math.round(32767*Math.pow(10,-18/20)*Math.sin(2*Math.PI*1499*(n*960+i)/48000)),i*2);
      if(!injection.write({format:{samplingRate:'48000',channels:0,format:1,mode:1},timestamp:String(Date.now()*1000),audio:data})) {
        try { await once(injection,'drain',{signal:stopWrites.signal}); }
        catch(error) { if(!sending&&error.name==='AbortError')break;throw error; }
      }
      n++;source.packets=n;source.last_packet_at_ms=Date.now();await delay(Math.max(0,started+n*20-Date.now()));}source.senderEnded=true;if(!source.rpcEnded)injection.end();})();
    void sender.catch(()=>{}); // The measurement branch awaits and reports its actual failure below.
    await capture('startup',1499,waitForActualMicrophone);
    const [authorized, audible] = await Promise.all([capture('authorized'),audience('authorized')]); state.authorized_web_1499_db=audible;
    assert.ok(authorized.mean_amplitude>0.01,'Authorized Android microphone absent at native target'); assert.ok(audible>-60,'Authorized Android microphone absent at Web observer'); save();
    assertContinuousInjection(source, 0);
    const packetsBeforeRevocation=source.packets; state.injection_packets_before_revocation=packetsBeforeRevocation;
    const granted = await current(); state.authorized_control_epoch=granted.control_epoch;
    await api('/stream-sessions/'+sessionId+'/controller','DELETE');
    const revoked = await until(current,s=>!s.controller_connection_id&&!s.connections[native]?.microphone_live,'revoked Android capture stops'); state.revoked_control_epoch=revoked.control_epoch; assert.ok(revoked.control_epoch>granted.control_epoch);
    await android.role(false); await delay(1500); state.capture_stop_settling_ms=1500;
    const [silent, inaudible] = await Promise.all([capture('revoked'),audience('revoked')]); state.revoked_web_1499_db=inaudible;
    assertContinuousInjection(source, packetsBeforeRevocation); state.injection_packets_after_revoked_measurement=source.packets;
    assert.ok(state.revoked.injection_packets_at_stop>state.revoked.injection_packets_at_start,'Synthetic microphone must advance during the actual revoked recording window');
    assert.ok(silent.peak_amplitude<0.001,'Revoked microphone reached native target'); assert.ok(inaudible<-65,'Revoked microphone reached Web observer');
    state.web_program_after_revocation_997_db=await audience('program_after_revocation',997); assert.ok(state.web_program_after_revocation_997_db>-65,'Revocation interrupted program audio');
    sending=false; await sender; await injectionDone; assert.equal(injectionError,undefined,'Official emulator injection failed'); state.injection_completed=true;
    assert.equal(run(['shell','getprop','sys.boot_completed']).trim(),'1'); state.passed=true; save();
  } catch(error) {
    await playbackMetadata('failure');throw error;
  } finally {
    sending=false;
    stopWrites.abort();
    if(injection)injection.cancel();
    if (sender) await sender.catch(()=>{});
    client.close();
    try { await page.evaluate(async()=>{if(window.__androidAudioObserver)await window.__androidAudioObserver.context.close();}); }
    catch { state.observer_cleanup_failed=true;state.passed=false;save(); }
    try { await command('stop_capture'); } catch { state.recorder_cleanup_failed=true; state.passed=false; save(); }
    if(native){const session=await current(); if(session.controller_connection_id===native)await api('/stream-sessions/'+sessionId+'/controller','DELETE');}
  }
}
module.exports = { verifyAndroidAudio };
