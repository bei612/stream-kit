// Uses the published native APK through its ordinary Activity/HTTPS APIs.
// No instrumentation APK, alternate transport, input mocks or product hooks.
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const {targetInputObserver,untilInput:until}=require('./target-input-observer.cjs');

function androidParticipant({adb,serial}) {
  assert.match(serial,/^emulator-[0-9]+$/);
  const run=(...args)=>{
    try{return execFileSync(adb,['-s',serial,...args],{encoding:'utf8',windowsHide:true,timeout:20000,stdio:['ignore','pipe','pipe']});}
    catch{throw Error('Android acceptance command failed: '+args.slice(0,2).join(' '));}
  };
  const hierarchy=()=>{
    run('shell','uiautomator','dump','/sdcard/stream-kit-input.xml');
    return run('shell','cat','/sdcard/stream-kit-input.xml');
  };
  const role=controller=>until(()=>hierarchy().includes(controller?'已连接 · 控制中':'已连接 · 观看中'),'Android role update',30000);
  return {
    async connect(link){
      const parsed=new URL(link);assert.equal(parsed.protocol,'https:');assert.equal(parsed.hostname,'10.0.2.2');
      run('shell','am','start','-n','io.github.bei612.streamkit/com.limelight.streamkit.ManagedActivity','-a','android.intent.action.VIEW','-d',link);
      await role(false);
    },
    role,
    key(){run('shell','input','keyevent','KEYCODE_A');},
    tap(){
      const node=(hierarchy().match(/<node\b[^>]*>/g)||[]).find(n=>n.includes('class="android.view.SurfaceView"'));
      assert.ok(node,'Native Android video surface missing');
      const bounds=node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);assert.ok(bounds);
      run('shell','input','tap',String(Math.floor((+bounds[1]+ +bounds[3])/2)),String(Math.floor((+bounds[2]+ +bounds[4])/2)));
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
    android.tap();
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
