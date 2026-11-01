// Disposable CI experiment. No physical inputs, product configuration or default
// selection APIs are used. This file and both helpers are excluded from products.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const {isDeepStrictEqual}=require('node:util');
const {startAudioProbe}=require('./lib/audio-probe.cjs');
assert.equal(process.platform,'win32');
assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
assert.equal(process.env.RUNNER_OS,'Windows');
assert.equal(process.argv.length,4,'Expected audio-target debug directory and policy helper');
const native=path.resolve(process.argv[2]),policy=path.resolve(process.argv[3]);
const output=path.resolve('artifacts/audio-playback/endpoint-policy');
fs.mkdirSync(output,{recursive:true});
const report={passed:false,scope:'Documented render-only endpoint policy on two owned synthetic devices in a disposable Windows runner. No customer installation or human speech claim.'};
const owners=[];
let probe;
const defaults=()=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
 `$ErrorActionPreference='Stop';$m=[Windows.Media.Devices.MediaDevice,Windows.Media.Devices,ContentType=WindowsRuntime];$r=[Windows.Media.Devices.AudioDeviceRole,Windows.Media.Devices,ContentType=WindowsRuntime];@{render=$m::GetDefaultAudioRenderId($r::Default);communications=$m::GetDefaultAudioRenderId($r::Communications)}|ConvertTo-Json -Compress`
],{encoding:'utf8',windowsHide:true,timeout:20000}));
async function inventory(){
 const reply=await probe.command('devices');
 assert.ok(Array.isArray(reply.data?.devices)&&!reply.error,'Device inventory failed');
 return reply.data.devices;
}
async function close(owner){
 if(owner.closed)return;
 owner.child.stdin.end();
 const timer=new AbortController();
 const result=await Promise.race([owner.ended,delay(10000,{timeout:true},{signal:timer.signal})]);
 timer.abort();
 if(result.timeout){owner.child.kill();await owner.ended;owner.closed=true;throw Error('Owned fixture did not close gracefully');}
 owner.closed=true;assert.equal(result.code,0,result.error||'Fixture exit failed');assert.equal(result.signal,null);
}
async function start(serial,round){
 const before=new Set((await inventory()).map(d=>d.id));
 const log=fs.openSync(path.join(output,serial+'-'+round+'.log'),'w');
 const child=spawn(path.join(native,'examples/virtual_device.exe'),['65534','1',serial,'stdin'],{windowsHide:true,stdio:['pipe',log,log]});
 fs.closeSync(log);child.stdin.on('error',()=>{});
 const owner={child,closed:false};
 owner.ended=new Promise(resolve=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',error=>resolve({error:error.message}));});
 owners.push(owner);
 for(let i=0;i<200;i++){
  assert.equal(child.exitCode,null,'Provider exited before enumeration');
  const added=(await inventory()).filter(d=>!before.has(d.id));
  if(added.length===2&&added.some(d=>d.input)&&added.some(d=>d.output)){
   assert.ok(added.every(d=>d.name.includes('Stream Kit Virtual Audio')));
   owner.pair={render:added.find(d=>d.output).id,capture:added.find(d=>d.input).id};
   return owner;
  }
  await delay(100);
 }
 throw Error('Exact fixture pair did not enumerate');
}
async function waitRemoved(pair){
 for(let i=0;i<100;i++){
  if((await inventory()).every(d=>d.id!==pair.render&&d.id!==pair.capture))return;
  await delay(100);
 }
 throw Error('Closed fixture endpoints remained active');
}
(async()=>{
 try{
  probe=startAudioProbe(path.join(native,'audio-probe.exe'));
  assert.equal((await inventory()).length,0,'Refuse an existing audio environment');
  const reference=await start('CIPolicyReference',0);
  report.reference=reference.pair;
  report.defaults_before=defaults();
  assert.ok(report.defaults_before.render.toLowerCase().includes(reference.pair.render.slice('wasapi:'.length).toLowerCase()),'Reference must be the current Windows default output');
  const seed=await start('CIPolicyTarget',0);
  report.target=seed.pair;
  report.defaults_without_policy=defaults();
  report.selection_regression_reproduced=!isDeepStrictEqual(report.defaults_without_policy,report.defaults_before);
  report.policy=JSON.parse(execFileSync(policy,[],{encoding:'utf8',windowsHide:true,timeout:30000}));
  assert.equal(report.policy.length,2);
  assert.ok(report.policy.every(row=>row.render_never_default_mask===0x107&&row.inbox_driver_refreshed));
  await close(seed);
  for(let i=0;i<100;i++){
   if((await inventory()).every(d=>d.id===reference.pair.render||d.id===reference.pair.capture))break;
   await delay(100);
  }
  assert.equal((await inventory()).length,2,'Seed refresh left additional active endpoints');
  assert.deepEqual(defaults(),report.defaults_before,'Closing the seed did not restore reference defaults');
  const target=await start('CIPolicyTarget',1);
  // An in-place driver update can migrate endpoint IDs. Persist and compare
  // the post-install identity, not the temporary enumeration used during setup.
  report.target_after_refresh=target.pair;
  report.pair=JSON.parse(execFileSync(path.join(native,'examples/verify_pair.exe'),[target.pair.render,target.pair.capture],{encoding:'utf8',windowsHide:true,timeout:30000}));
  assert.equal(report.pair.passed,true,'Explicit PCM route failed after render policy');
  report.defaults_with_policy=defaults();
  assert.deepEqual(report.defaults_with_policy,report.defaults_before,'Prepared virtual output still displaced reference defaults');
  await close(target);await waitRemoved(target.pair);
  const restarted=await start('CIPolicyTarget',2);
  assert.deepEqual(restarted.pair,target.pair,'Prepared endpoint identity changed across restart');
  assert.deepEqual(defaults(),report.defaults_before,'Restarted prepared output displaced reference defaults');
  await close(restarted);await waitRemoved(restarted.pair);
  report.prepared_restart_passed=true;
  await close(reference);await waitRemoved(reference.pair);
  report.passed=true;
 }catch(error){report.error=error.message;process.exitCode=1;}
 finally{
  for(const owner of owners.toReversed())try{await close(owner);}catch(error){report.cleanup_error=error.message;report.passed=false;process.exitCode=1;}
  if(probe)await probe.close();
  report.finished_at=new Date().toISOString();
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
