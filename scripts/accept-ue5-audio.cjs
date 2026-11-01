const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {startAudioProbe}=require('./lib/audio-probe.cjs');
const {listUE5Devices,startUE5Capture}=require('./lib/ue5-recorder.cjs');

async function main(){
 const args=process.argv.slice(2);
 assert.equal(args.length,6,'Expected UE_EDITOR_CMD COMPILED_PROBE_PROJECT AUDIO_PROBE RENDER_DEVICE CAPTURE_DEVICE NEW_EVIDENCE_DIRECTORY');
 const [editor,project,audioProbe]=args.slice(0,3).map(file=>path.resolve(file));
 const [renderDevice,captureDevice]=args.slice(3,5),output=path.resolve(args[5]);
 assert.notEqual(renderDevice,captureDevice);
 assert.ok(!fs.existsSync(output),'Evidence directory must be new');fs.mkdirSync(output);
 const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const build=JSON.parse(fs.readFileSync(path.join(path.dirname(project),'build-result.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(build.project,project);assert.equal(hash(build.module),build.module_sha256);
 const result={schema_version:1,passed:false,scope:'Actual UE5 AudioCaptureCore records a selected virtual input and a native generated tone; no browser microphone, human speech, business UE project, hardware default changes or raw audio files',module_sha256:build.module_sha256,source_files:build.source_files,engine:build.engine,probe_sha256:hash(audioProbe),render_device_id:renderDevice,capture_device_id:captureDevice};
 const save=()=>fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n');save();
 let native,recording;
 try{
  native=startAudioProbe(audioProbe);const endpoints=await native.command('devices');
  assert.ok(!endpoints.error&&endpoints.data.devices.some(d=>d.id===renderDevice&&d.output)&&endpoints.data.devices.some(d=>d.id===captureDevice&&d.input),'Explicit native endpoint pair is unavailable');
  const catalog=await listUE5Devices({editor,project,resultFile:path.join(output,'catalog.json'),logFile:path.join(output,'catalog.log')});
  const selected=catalog.devices.filter(d=>d.id===captureDevice.replace(/^wasapi:/,''));
  assert.equal(selected.length,1,'Native endpoint must have one exact UE5 device ID match; no name/default fallback');
  result.ue_device=selected[0];save();
  const options={editor,project,deviceId:selected[0].id};
  recording=await startUE5Capture({...options,durationMs:1000,resultFile:path.join(output,'baseline.json'),logFile:path.join(output,'baseline.log')});
  result.baseline=await recording.done;recording=null;save();
  assert.ok(result.baseline.program_tone.peak_amplitude<0.003&&result.baseline.client_tone.peak_amplitude<0.003,'Virtual endpoint is not idle before this owned test');
  recording=await startUE5Capture({...options,durationMs:4000,resultFile:path.join(output,'native-tone.json'),logFile:path.join(output,'native-tone.log')});
  const tone=await native.command('tone',{device_id:renderDevice});assert.ok(!tone.error,tone.error);
  result.tone=await recording.done;recording=null;save();
  assert.ok(result.tone.captured_frames>=48000,'UE5 did not capture one second of actual PCM');
  assert.ok(result.tone.program_tone.mean_amplitude>0.01,'Native generated tone did not reach UE5');
  assert.ok(result.tone.client_tone.peak_amplitude<0.003,'Unexpected second carrier in the isolated virtual input');
  await native.command('stop');await native.close();native=null;
  result.passed=true;result.clean_exit=true;save();console.log(JSON.stringify({passed:true,engine_version:result.tone.engine_version,mean_amplitude:result.tone.program_tone.mean_amplitude,frames:result.tone.captured_frames,output}));
 }catch(error){result.error=error.message;save();throw error}
 finally{if(recording){recording.cancel();await recording.done.catch(()=>{})}if(native)await native.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1});
