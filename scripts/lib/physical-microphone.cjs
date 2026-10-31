const assert=require('node:assert/strict');
const {setTimeout:delay}=require('node:timers/promises');
const {captureEnvelope,compareEnvelopes}=require('./audio-envelope.cjs');

// Uses actual browser capture and the native target input. Only aggregate
// similarity/level metrics escape this helper; no waveform or speech file.
async function exercisePhysicalMicrophone({pages,api,sessionId,probe,targetCapture,deviceId,result,save,programLevels}){
 assert.ok(probe&&targetCapture&&deviceId,'Physical microphone acceptance requires an explicit physical input and native target recording');
 const ids=await Promise.all(pages.map(page=>page.evaluate(()=>window.app.getStream().mediaAccess.connectionId)));
 const evidence={passed:false,cases:{},source:'physical browser getUserMedia',signal_comparison:'10 ms energy envelope after 997 Hz program notch; bounded delay/gain correlation',permission_prompt_tested:false};
 result.physical_microphone=evidence;save();
 const live=page=>page.evaluate(()=>window.app.getStream().getMicrophoneListener()?.isLive()??false);
 const begin=async page=>{
  await page.waitForFunction(()=>window.app.getStream().mediaAccess.role==='controller');
  await page.evaluate(()=>window.app.getStream().getMicrophoneListener().onUserInteraction());
  await page.waitForFunction(()=>window.app.getStream().getMicrophoneListener().isLive());
  const actual=await page.evaluate(()=>window.__acceptancePeers.at(-1).getSenders().find(s=>s.track?.kind==='audio').track.getSettings().deviceId);
  assert.equal(actual,deviceId,'Product capture did not use the selected physical microphone');
 };
 const attachHostile=page=>page.evaluate(async deviceId=>{
  const stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:{exact:deviceId},echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
  const sender=window.__acceptancePeers.at(-1).getTransceivers().find(t=>t.direction==='sendonly').sender;
  window.__physicalHostile={stream,sender};await sender.replaceTrack(stream.getAudioTracks()[0]);
 },deviceId);
 const detachHostile=page=>page.evaluate(async()=>{
  const owned=window.__physicalHostile;if(!owned)return;
  owned.stream.getTracks().forEach(track=>track.stop());await owned.sender.replaceTrack(null);window.__physicalHostile=null;
 });
 const observe=async(phase,speakerIndex,allowed)=>{
  console.log(`Physical microphone observation: ${phase}`);
  await delay(1000);
  const started=await probe.command('capture',{device_id:targetCapture});assert.ok(!started.error,started.error);
  let snapshots,stopped;
  try{
   snapshots=await Promise.all([captureEnvelope(pages[speakerIndex],'sent'),...pages.filter((_,i)=>i!==speakerIndex).map(page=>captureEnvelope(page))]);
  }finally{stopped=await probe.command('stop')}
  assert.ok(!stopped.error&&!stopped.data.error&&stopped.data.captured_frames>=48000,'Native target capture failed');
  assert.ok(stopped.data.dropped_frames<stopped.data.captured_frames/100,'Native target recording dropped more than 1% of frames');
  const analyzed=await probe.command('envelope');assert.ok(!analyzed.error,analyzed.error);
  const target=compareEnvelopes(snapshots[0],analyzed.data),audience=snapshots.slice(1).map(value=>compareEnvelopes(snapshots[0],value));
  const record={allowed,source_label:snapshots[0].label,target,audience,native_recording:stopped.data};
  evidence.cases[phase]=record;save();
  assert.ok(target.reference_rms>0.00005&&target.reference_variation>0.15,'Physical microphone needs an audible changing signal; speak during this acceptance');
  if(allowed){
   assert.ok(target.correlation>0.3,'Physical microphone was not correlated with target recording');
   assert.ok(audience.every(value=>value.correlation>0.3),'Physical microphone was not correlated with every other viewer');
  }else{
   assert.ok(target.correlation<0.2,'Unauthorized physical microphone correlated with target input');
   assert.ok(audience.every(value=>value.correlation<0.2),'Unauthorized physical microphone correlated with audience output');
  }
 };
 // A viewer's product UI must not open capture. An explicitly hostile native
 // track then proves server-side rejection independently of the UI guard.
 console.log('Physical microphone acceptance starts in 5 seconds; a changing native input signal is required.');
 await delay(5000);
 await pages[0].evaluate(()=>window.app.getStream().getMicrophoneListener().onUserInteraction());
 assert.equal(await live(pages[0]),false);
 try{await attachHostile(pages[0]);await observe('viewer_denied',0,false)}finally{await detachHostile(pages[0])}
 await api(`/stream-sessions/${sessionId}/controller/${ids[0]}`,'POST');await begin(pages[0]);
 await observe('controller',0,true);
 const program=await programLevels();evidence.simultaneous_program_db=program;save();
 assert.ok(program.every(value=>value>-65),'Program audio must continue while physical microphone is broadcast');
 await api(`/stream-sessions/${sessionId}/controller/${ids[1]}`,'POST');
 await pages[0].waitForFunction(()=>!window.app.getStream().getMicrophoneListener().isLive());await begin(pages[1]);
 await observe('transferred_controller',1,true);
 // Pause the valid controller so two clients capturing the same physical
 // hardware cannot make an old-controller rejection test ambiguous.
 await pages[1].evaluate(()=>window.app.getStream().getMicrophoneListener().setAllowed(false));
 try{await attachHostile(pages[0]);await observe('old_controller_denied',0,false)}finally{await detachHostile(pages[0])}
 await api(`/stream-sessions/${sessionId}/controller`,'DELETE');
 await pages[1].waitForFunction(()=>!window.app.getStream().getMicrophoneListener().isLive());
 try{await attachHostile(pages[1]);await observe('released',1,false)}finally{await detachHostile(pages[1])}
 evidence.passed=true;save();
}
module.exports={exercisePhysicalMicrophone};
