// Uses the published native APK through its ordinary Activity/HTTPS APIs.
// A separate testOnly UI observer reads roles/bounds through public Android
// instrumentation APIs. No product hooks, alternate transport or input mocks.
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const {targetInputObserver,untilInput:until}=require('./target-input-observer.cjs');

function androidParticipant({adb,serial,report,save=()=>{}}) {
  assert.match(serial,/^emulator-[0-9]+$/);
  const state=report?(report.android_participant={role_waits:[],scope:'Test-only accessibility root and exact fixed-state classifications; no UI content, links or permission bypass'}):null;
  const allowedStates=new Set(['unknown','entry_ready','waiting','starting','connecting','reconnecting','ready','audio_output_failed','initialize_failed','admission_failed','authority_failed','link_expired','disconnected','link_invalid','bookmark_unreadable']);
  const terminalStates=new Set(['audio_output_failed','initialize_failed','admission_failed','authority_failed','link_expired','link_invalid']);
  const run=(...args)=>{
    try{return execFileSync(adb,['-s',serial,...args],{encoding:'utf8',windowsHide:true,timeout:20000,stdio:['ignore','pipe','pipe']});}
    catch(error){
      // Never include command arguments or general adb output: an Activity
      // launch contains the durable watching capability. UI dump diagnostics
      // are restricted to known, non-content-bearing failure classifications.
      const stderr=String(error.stderr||'');
      const reason=/could not get idle state/i.test(stderr)?'accessibility_not_idle'
        :/null root node/i.test(stderr)?'accessibility_root_unavailable'
        :/device offline/i.test(stderr)?'device_offline':'command_failed';
      throw Error(`Android acceptance command failed: ${args.slice(0,2).join(' ')}; reason=${reason}; code=${error.code||'none'}; exit=${error.status}; signal=${error.signal||'none'}`);
    }
  };
  const snapshot=()=>{
    const output=run('shell','am','instrument','-w','io.github.bei612.streamkit.inputobserver/.Observer');
    assert.ok(/INSTRUMENTATION_CODE: -1/.test(output),'Android UI observer failed');
    assert.ok(/INSTRUMENTATION_RESULT: snapshot=complete/.test(output),'Android UI snapshot failed');
    const role=output.match(/INSTRUMENTATION_RESULT: role=(controller|viewer|other)\b/);
    const bounds=output.match(/INSTRUMENTATION_RESULT: window=(\d+),(\d+),(\d+),(\d+)/);
    const status=output.match(/INSTRUMENTATION_RESULT: state=([a-z_]+)\b/),root=output.match(/INSTRUMENTATION_RESULT: root=(client|no_root|other_app)\b/),opened=output.match(/INSTRUMENTATION_RESULT: toolbar_opened=(true|false)\b/);
    assert.ok(role&&bounds&&status&&root&&opened&&allowedStates.has(status[1]),'Incomplete Android UI snapshot');
    return {role:role[1],bounds:bounds.slice(1).map(Number),state:status[1],root:root[1],toolbar_opened:opened[1]==='true'};
  };
  const playoutErrors=()=>{
    // These message prefixes and start-error enums are from the actual pinned
    // 150.7871.01 AAR. Only classified events and explicit integer codes leave
    // memory; no raw log message, stack, intent or UI content is retained.
    const diagnostics={started_at_ms:Date.now(),events:[]};
    try {
      const pids=run('shell','pidof','io.github.bei612.streamkit').trim().split(/\s+/);
      assert.ok(pids.length>0&&pids.every(pid=>/^[1-9][0-9]*$/.test(pid)),'Native client PID unavailable');
      diagnostics.application_pids=pids.map(Number);diagnostics.observed_error_count=0;
      for(const pid of pids){
        const output=run('logcat','-d','--pid',pid,'-v','brief','-s','WebRtcAudioTrackExternal:E','WebRtcAudioTrack:E','org.webrtc.Logging:E','*:S');
        for(const line of output.split(/\r?\n/)){
          const tagged=line.match(/^E\/(WebRtcAudioTrackExternal|WebRtcAudioTrack|org\.webrtc\.Logging)\s*\(\s*[0-9]+\):\s*(.*)$/);if(!tagged)continue;
          let message=tagged[2];
          if(tagged[1]==='org.webrtc.Logging'){
            // The SDK's default JUL logger wraps its real component tag here.
            const wrapped=message.match(/^(?:WebRtcAudioTrackExternal|WebRtcAudioTrack): (.*)$/);if(!wrapped)continue;message=wrapped[1];
          }
          let event;
          const write=message.match(/^(?:Run-time playback error: )?AudioTrack\.write failed: (-?[0-9]+)$/);
          const count=message.match(/^AudioTrack\.write played invalid number of bytes: (-?[0-9]+)$/);
          const start=message.match(/^Start playout error: (AUDIO_TRACK_START_EXCEPTION|AUDIO_TRACK_START_STATE_MISMATCH)\./);
          if(write)event={kind:'write_failed',error_code:Number(write[1])};
          else if(count)event={kind:'invalid_write_count',byte_count:Number(count[1])};
          else if(/^Init playout error: /.test(message))event={kind:'init_failed'};
          else if(start){event={kind:'start_failed',sdk_code:start[1]};const mismatch=message.match(/AudioTrack\.play failed - incorrect state :(-?[0-9]+)$/);if(mismatch)event.play_state=Number(mismatch[1]);}
          else if(/^Run-time playback error: /.test(message))event={kind:'runtime_failed'};
          else if(message==='Invalid audio state')event={kind:'invalid_state'};
          if(event){diagnostics.observed_error_count++;if(diagnostics.events.length<32)diagnostics.events.push({process_id:Number(pid),...event});}
        }
      }
      diagnostics.available=true;
    }catch{diagnostics.available=false;diagnostics.unavailable_reason='sdk_error_metadata_unavailable';}
    diagnostics.finished_at_ms=Date.now();return diagnostics;
  };
  const role=async controller=>{
    const wait={expected_role:controller?'controller':'viewer',started_at_ms:Date.now(),timeout_ms:30000,samples:[]};
    if(state){state.role_waits.push(wait);save();}
    try {
      const result=await until(()=>{
        const view=snapshot(),[left,top,right,bottom]=view.bounds,sample={at_ms:Date.now(),...view};wait.samples.push(sample);
        if(!wait.first_terminal&&terminalStates.has(view.state))wait.first_terminal=sample;
        if(state)save();
        return view.role===wait.expected_role&&right>left&&bottom>top?view:false;
      },'Android role update',30000);
      wait.completed_at_ms=Date.now();if(state)save();return result;
    } catch(error){
      wait.failed_at_ms=Date.now();wait.failure='role_wait_failed';if(state)save();
      wait.playout_errors=playoutErrors();if(state)save();throw error;
    }
  };
  return {
    async connect(link){
      const parsed=new URL(link);assert.equal(parsed.protocol,'https:');assert.equal(parsed.hostname,'10.0.2.2');
      run('shell','am','start','-n','io.github.bei612.streamkit/com.limelight.streamkit.ManagedActivity','-a','android.intent.action.VIEW','-d',link);
      await role(false);
    },
    role,
    key(){run('shell','input','keyevent','KEYCODE_A');},
    async tap(controller){
      // Connecting accessibility can briefly return no active root. Wait for
      // the expected visible role just as connection/transfer checks already do.
      const {bounds:[left,top,right,bottom]}=await role(controller);
      // The published Activity centers the video in its main area. Exercise an
      // ordinary center-window tap, independent of SurfaceView accessibility.
      // Success still requires an actual pointer-down event at the remote target.
      run('shell','input','tap',String(Math.floor((left+right)/2)),String(Math.floor((top+bottom)/2)));
    },
    close(){run('shell','input','keyevent','KEYCODE_HOME');},
  };
}

async function verifyAndroidInput({android,page,api,sessionId,app,example,report,save}) {
  const state=report.target_input={passed:false,phases:[],scope:'Published Android APK and real Web viewer share one native renderer; actual target key/touch delivery and cooperative transfer/revocation. Hostile Web packet rejection has separate Windows evidence. No physical-device, audio-quality or local ToDesk coexistence claim.'};save();
  const {snapshot,focus}=await targetInputObserver(app,example);
  const route='/stream-sessions/'+sessionId;
  const web=await page.evaluate(()=>window.app.getStream().mediaAccess.connectionId);
  const joined=await api(route);const ids=Object.keys(joined.connections);
  assert.equal(ids.length,2);assert.ok(ids.includes(web));const native=ids.find(id=>id!==web);
  state.android_connection_id=native;state.web_connection_id=web;
  const webRole=controller=>page.waitForFunction(r=>window.app.getStream().mediaAccess.role===r,controller?'controller':'viewer',{timeout:15000});
  async function nativeInput(label,allowed) {
    await android.role(allowed);focus();const before=snapshot();android.key();
    if(allowed)await until(()=>snapshot().keys>before.keys,'Android key delivered');
    await android.tap(allowed);
    if(allowed)await until(()=>snapshot().clicks>before.clicks,'Android touch delivered');
    else await delay(1000);
    focus();const after=snapshot();
    if(!allowed)assert.deepEqual(after,before,'Viewer Android reached the target');
    state.phases.push({label,before,after});save();
  }
  try {
    const first=await api(route+'/controller/'+native,'POST');await nativeInput('android_controller',true);
    const transferred=await api(route+'/controller/'+web,'PUT',{expected_controller_connection_id:native,expected_control_epoch:first.control_epoch});
    assert.equal(transferred.controller_connection_id,web);await webRole(true);await nativeInput('old_android_denied',false);
    focus();const before=snapshot();await page.evaluate(()=>window.app.focusInput());
    await page.keyboard.down('c');await delay(120);await page.keyboard.up('c');
    await until(()=>snapshot().keys>before.keys,'Web key after transfer');
    const video=page.locator('video'),box=await video.boundingBox();assert.ok(box);
    await video.click({position:{x:box.width/2,y:box.height/2},delay:100});await until(()=>snapshot().clicks>before.clicks,'Web click after transfer');
    state.phases.push({label:'web_controller',before,after:snapshot()});save();
    await api(route+'/controller','DELETE');await webRole(false);
    focus();const revoked=snapshot();await page.evaluate(()=>window.app.focusInput());await page.keyboard.press('d');await delay(1000);
    assert.deepEqual(snapshot(),revoked,'Revoked Web reached target');
    state.phases.push({label:'web_revoked',before:revoked,after:snapshot()});save();
    await api(route+'/controller/'+native,'POST');await nativeInput('android_regranted',true);
    await api(route+'/controller','DELETE');await nativeInput('android_revoked',false);
    state.passed=true;save();
  } finally {await api(route+'/controller','DELETE');}
}
module.exports={androidParticipant,verifyAndroidInput};
