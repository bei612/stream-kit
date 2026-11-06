// Development acceptance only. Observe actual target-window events, not sender
// success or UI role text. No production hooks, fixtures or protocol changes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');

async function verifyBrowserInput({pages, api, sessionId, app, example, report, save}) {
  assert.equal(process.platform, 'win32');
  assert.equal(pages.length, 2);
  const log = path.join(app.app_dir, 'output.log');
  const state = report.target_input = {passed:false, phases:[], scope:'Two real Web viewers, native target key/click delivery and server rejection of replayed input after transfer/revocation. Not Android or local ToDesk coexistence acceptance.'};
  save();
  function events() {
    if (!fs.existsSync(log)) return [];
    return fs.readFileSync(log, 'utf8').split(/\r?\n/).flatMap(line => {
      try { const item=JSON.parse(line); return item.type==='stream-kit-example-input' && item.schema_version===1 ? [item] : []; }
      catch { return []; }
    });
  }
  async function until(fn, description) {
    for (let i=0; i<50; i++) { const value=await fn(); if(value)return value; await delay(100); }
    throw Error('Target input timeout: '+description);
  }
  const ready = await until(()=>events().find(e=>e.event==='ready'), 'observer ready');
  assert.ok(Number.isInteger(ready.process_id) && ready.process_id>0);
  const snapshot = () => {
    const all=events(); assert.ok(all.every(e=>e.process_id===ready.process_id), 'Target restarted or log contains another process');
    const last=all.at(-1); assert.ok(last); return {keys:last.keys, clicks:last.clicks};
  };
  const focus = () => {
    const result=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
      '-File',path.join(__dirname,'../focus-input-example.ps1'),'-ProcessId',String(ready.process_id),'-ExamplePath',example],
    {encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','pipe']}));
    assert.equal(result.process_id,ready.process_id); assert.equal(result.foreground,true);
  };
  const ids=await Promise.all(pages.map(p=>p.evaluate(()=>window.app.getStream().mediaAccess.connectionId)));
  assert.equal(new Set(ids).size,2);
  const route='/stream-sessions/'+sessionId;
  async function roles(controller) {
    for(let i=0;i<pages.length;i++)await pages[i].waitForFunction(role=>window.app.getStream().mediaAccess.role===role,
      ids[i]===controller?'controller':'viewer',{timeout:15000});
  }
  async function replay(index) {
    return pages[index].evaluate(async()=>{
      const records=window.__inputReplay;
      if(!records?.length || records.some(r=>r.length!==38))throw Error('Missing known WebState test packets');
      const down=records.find(r=>r.slice(6).some(x=>x!==0)),up=records.find(r=>r.slice(6).every(x=>x===0));
      if(!down || !up)throw Error('Both real key down and released snapshots are required');
      const before=window.__inputReplaySent;
      window.__inputReplayQueue=[down,down,down,up,up,up].map(r=>r.slice(6));
      const deadline=Date.now()+5000;
      try {
        while(window.__inputReplaySent-before<6) {
          if(Date.now()>deadline)throw Error('No fresh transport frames; denial is inconclusive');
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        return window.__inputReplaySent-before;
      } finally { window.__inputReplayQueue=[]; }
    });
  }
  async function positive(index,label) {
    await roles(ids[index]); focus(); const before=snapshot(), page=pages[index];
    // Retain the real encoded keyboard messages only during this known test
    // key. Replaying them later challenges the server, bypassing the browser's
    // cooperative role check without changing the product transport.
    await page.evaluate(()=>{window.__inputReplay=[];window.__recordInputReplay=true;window.app.focusInput();});
    await page.keyboard.down('a'); await delay(120); await page.keyboard.up('a'); await delay(80);
    await page.evaluate(()=>{window.__recordInputReplay=false;});
    await until(()=>snapshot().keys>before.keys,'controller key received');
    const video=page.locator('video'), box=await video.boundingBox(); assert.ok(box);
    await video.click({position:{x:box.width/2,y:box.height/2},delay:100});
    await until(()=>snapshot().clicks>before.clicks,'controller canvas click received');
    const after=snapshot();
    assert.equal(after.keys,before.keys+1,'Unexpected extra key input');
    assert.equal(after.clicks,before.clicks+1,'Unexpected extra pointer input');
    const recorded=await page.evaluate(()=>window.__inputReplay.length);
    assert.ok(recorded>=2 && recorded<=200,'Expected bounded actual key down/up transport messages');
    const replayed=await replay(index);
    await until(()=>snapshot().keys>after.keys,'known replay accepted while authorized');
    const afterReplay=snapshot(); assert.equal(afterReplay.keys,after.keys+1); assert.equal(afterReplay.clicks,after.clicks);
    state.phases.push({label,connection_id:ids[index],before,after,after_replay:afterReplay,recorded_messages:recorded,replayed_messages:replayed}); save();
  }
  async function denied(index,label) {
    focus(); const before=snapshot();
    const sent=await replay(index);
    await delay(1000); focus(); const after=snapshot(); assert.deepEqual(after,before,'Revoked client reached the target');
    state.phases.push({label,connection_id:ids[index],sent_messages:sent,before,after}); save();
  }
  try {
    const claimed=await api(route+'/controller/'+ids[0],'POST');
    await positive(0,'first_controller');
    const transferred=await api(route+'/controller/'+ids[1],'PUT',{
      expected_controller_connection_id:ids[0],expected_control_epoch:claimed.control_epoch});
    assert.equal(transferred.controller_connection_id,ids[1]);
    await roles(ids[1]); await denied(0,'previous_controller_rejected');
    await positive(1,'second_controller');
    await api(route+'/controller','DELETE'); await roles(null);
    await denied(1,'revoked_controller_rejected');
    // Regrant proves that the negative result was not a silently broken input
    // pipeline; it also exercises returning to a former controller.
    await api(route+'/controller/'+ids[0],'POST'); await positive(0,'regranted_controller');
    state.passed=true; save();
  } finally {
    await api(route+'/controller','DELETE');
    await Promise.all(pages.map(p=>p.evaluate(()=>{window.__recordInputReplay=false;window.__inputReplay=[];window.__inputReplayQueue=[];})));
  }
}
module.exports={verifyBrowserInput};
