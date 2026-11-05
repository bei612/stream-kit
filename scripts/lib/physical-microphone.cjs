const assert=require('node:assert/strict');
const {setTimeout:delay}=require('node:timers/promises');
const {captureEnvelope,compareEnvelopes,assessMicrophoneSignal,microphoneSignalPolicy}=require('./audio-envelope.cjs');

// Uses actual browser capture and the native target input. Only aggregate
// similarity/level metrics escape this helper; no waveform or speech file.
async function exercisePhysicalMicrophone({pages,api,sessionId,probe,targetCapture,deviceId,result,save,programLevels}){
 assert.ok(probe&&targetCapture&&deviceId,'Physical microphone acceptance requires an explicit physical input and native target recording');
 const ids=await Promise.all(pages.map(page=>page.evaluate(()=>window.app.getStream().mediaAccess.connectionId)));
 const evidence={passed:false,cases:{},failures:[],source:'physical browser getUserMedia',signal_comparison:'10 ms energy envelope after 997 Hz program notch; bounded delay/gain correlation',permission_prompt_tested:false};
 // Retain every independent measurement in a participant's single speaking
 // window. A failed gate remains a failure; device/transport errors still abort.
 const check=(phase,condition,message)=>{if(!condition)evidence.failures.push({phase,message});};
 result.physical_microphone=evidence;save();
 evidence.signal_policy=microphoneSignalPolicy;
 const setProgramGain=async gain=>{
  const current=(await api(`/stream-sessions/${sessionId}`)).audio;
  await api(`/stream-sessions/${sessionId}/audio`,'PATCH',{
   expected_audio:current,program_gain_db:gain,microphone_gain_db:current.microphone_gain_db,
   microphone_enabled:current.microphone_enabled,broadcast_controller_microphone:current.broadcast_controller_microphone,
   controller_monitor:current.controller_monitor,
  });
 };
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
  const targetAssessment=assessMicrophoneSignal(target,allowed),audienceAssessments=audience.map(value=>assessMicrophoneSignal(value,allowed));
  const record={allowed,source_label:snapshots[0].label,target,audience,target_assessment:targetAssessment,audience_assessments:audienceAssessments,native_recording:stopped.data};
  evidence.cases[phase]=record;
  check(phase,target.reference_rms>0.00005&&target.reference_variation>0.15,'Physical microphone needs an audible changing signal; speak during this acceptance');
  if(allowed){
   check(phase,targetAssessment.passed,'Physical microphone was not audibly correlated with target recording');
   check(phase,audienceAssessments.every(value=>value.passed),'Physical microphone was not audibly correlated with every other viewer');
  }else{
   check(phase,targetAssessment.passed,'Unauthorized microphone was not sufficiently suppressed at target input');
   check(phase,audienceAssessments.every(value=>value.passed),'Unauthorized microphone was not sufficiently suppressed at audience output');
  }
  save();
 };
 // A viewer's product UI must not open capture. An explicitly hostile native
 // track then proves server-side rejection independently of the UI guard.
 console.log('Physical microphone acceptance starts in 5 seconds; a changing native input signal is required.');
 await delay(5000);
 await pages[0].evaluate(()=>window.app.getStream().getMicrophoneListener().onUserInteraction());
 assert.equal(await live(pages[0]),false);
 // Denial checks isolate microphone transport from the intentionally audible
 // application tone, which can also enter a physical microphone acoustically.
 // Authorized cases below retain simultaneous program/microphone verification.
 evidence.denied_program_gain_db=-60;
 await setProgramGain(-60);
 try{await attachHostile(pages[0]);await observe('viewer_denied',0,false)}finally{await detachHostile(pages[0])}
 await setProgramGain(0);
 await api(`/stream-sessions/${sessionId}/controller/${ids[0]}`,'POST');await begin(pages[0]);
 await observe('controller',0,true);
 const program=await programLevels();evidence.simultaneous_program_db=program;save();
 check('controller',program.every(value=>value>-65),'Program audio must continue while physical microphone is broadcast');save();
 const current=await api(`/stream-sessions/${sessionId}`);
 await api(`/stream-sessions/${sessionId}/controller/${ids[1]}`,'PUT',{
  expected_controller_connection_id:current.controller_connection_id??'',expected_control_epoch:current.control_epoch,
 });
 await pages[0].waitForFunction(()=>!window.app.getStream().getMicrophoneListener().isLive());await begin(pages[1]);
 await observe('transferred_controller',1,true);
 // Pause the valid controller so two clients capturing the same physical
 // hardware cannot make an old-controller rejection test ambiguous.
 await pages[1].evaluate(()=>window.app.getStream().getMicrophoneListener().setAllowed(false));
 await setProgramGain(-60);
 try{await attachHostile(pages[0]);await observe('old_controller_denied',0,false)}finally{await detachHostile(pages[0])}
 await api(`/stream-sessions/${sessionId}/controller`,'DELETE');
 await pages[1].waitForFunction(()=>!window.app.getStream().getMicrophoneListener().isLive());
 try{await attachHostile(pages[1]);await observe('released',1,false)}finally{await detachHostile(pages[1])}
 evidence.passed=evidence.failures.length===0;save();
 assert.ok(evidence.passed,evidence.failures.map(value=>value.phase+': '+value.message).join('; '));
}
module.exports={exercisePhysicalMicrophone};
