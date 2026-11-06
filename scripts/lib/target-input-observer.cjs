const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');

async function untilInput(fn, description, timeout=5000) {
  const deadline=Date.now()+timeout;
  do { const value=await fn(); if(value)return value; await delay(100); } while(Date.now()<deadline);
  throw Error('Target input timeout: '+description);
}
async function targetInputObserver(app, example) {
  const log=path.join(app.app_dir,'output.log');
  const events=()=>!fs.existsSync(log)?[]:fs.readFileSync(log,'utf8').split(/\r?\n/).flatMap(line=>{
    try {const value=JSON.parse(line);return value.type==='stream-kit-example-input'&&value.schema_version===1?[value]:[];} catch {return [];}
  });
  const ready=await untilInput(()=>events().find(e=>e.event==='ready'),'observer ready');
  assert.ok(Number.isInteger(ready.process_id)&&ready.process_id>0);
  const snapshot=()=>{
    const all=events(); assert.ok(all.every(e=>e.process_id===ready.process_id),'Target restarted or log contains another process');
    const last=all.at(-1); assert.ok(last);return {keys:last.keys,clicks:last.clicks};
  };
  const exec=(file,args)=>execFileSync(file,args,{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','pipe']}).trim();
  const focus=()=>{
    if(process.platform==='win32') {
      const result=JSON.parse(exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
        '-File',path.join(__dirname,'../focus-input-example.ps1'),'-ProcessId',String(ready.process_id),'-ExamplePath',example]));
      assert.equal(result.process_id,ready.process_id);assert.equal(result.foreground,true);
    } else if(process.platform==='linux') {
      assert.equal(fs.realpathSync('/proc/'+ready.process_id+'/exe'),fs.realpathSync(example),'Example process ownership mismatch');
      const windows=exec('xdotool',['search','--all','--onlyvisible','--pid',String(ready.process_id),'--class','StreamKitInputAcceptance']).split(/\r?\n/);
      assert.equal(windows.length,1,'Expected exactly one owned fixture window');assert.match(windows[0],/^\d+$/);
      exec('xdotool',['windowactivate','--sync',windows[0]]);
      assert.equal(exec('xdotool',['getactivewindow']),windows[0],'Window manager did not activate the owned target');
      const focused=exec('xdotool',['getwindowfocus']);assert.match(focused,/^\d+$/);
      assert.equal(exec('xdotool',['getwindowpid',focused]),String(ready.process_id),'Keyboard focus is outside the owned target');
    } else throw Error('Unsupported native input acceptance platform');
  };
  return {snapshot,focus,processId:ready.process_id};
}
module.exports={targetInputObserver,untilInput};
