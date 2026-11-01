const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const {createHash}=require('node:crypto');

function verifiedUE5Build(project){
 const root=fs.realpathSync(path.dirname(project));
 const build=JSON.parse(fs.readFileSync(path.join(root,'build-result.json'),'utf8').replace(/^\uFEFF/,''));
 const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 if(build.schema_version!==1||build.project!==project||path.dirname(path.dirname(path.dirname(build.module)))!==root||hash(build.module)!==build.module_sha256)throw Error('UE5 compiled probe identity does not match its build record');
 for(const file of build.source_files){
  const name=path.resolve(root,file.path);
  if(!name.startsWith(root+path.sep)||fs.lstatSync(name).isSymbolicLink()||hash(name)!==file.sha256)throw Error('UE5 probe source snapshot changed since compilation');
 }
 return build;
}

// Optional UE SDK acceptance process, never a platform runtime dependency.
// Its selected recording endpoint and JSON evidence are explicit. No business
// project, system defaults, physical input, editor UI or PCM file is involved.
function launch({editor,project,deviceId,durationMs=3000,resultFile,logFile,listOnly=false}){
 for(const file of [editor,project,resultFile,logFile])if(!path.isAbsolute(file)||/[\r\n\x00"]/.test(file))throw Error('UE5 probe paths must be explicit absolute paths');
 for(const file of [editor,project])if(!fs.statSync(file).isFile())throw Error('UE5 probe input is not a file');
 if(fs.existsSync(resultFile)||fs.existsSync(logFile))throw Error('UE5 evidence files must be new');
 if(!listOnly&&(!deviceId||/[\r\n\x00"]/.test(deviceId)||deviceId.length>4096))throw Error('An explicit UE5 capture device ID is required');
 if(!Number.isInteger(durationMs)||durationMs<100||durationMs>10000)throw Error('UE5 capture duration is outside its bound');
 const args=[project,'-run=StreamKitCapture',`-ResultFile=${resultFile}`,'-NullRHI','-nosound','-NoShaderCompile','-unattended','-nop4','-nosplash','-stdout','-UTF8Output',...(listOnly?['-ListDevices']:[`-CaptureDeviceId=${deviceId}`,`-DurationMs=${durationMs}`])];
 const fd=fs.openSync(logFile,'wx');
 const child=spawn(editor,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let resolveReady,rejectReady;
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject});ready.catch(()=>{});
 let expired=false,logBytes=0,recordingSeen=false;
 const log=bytes=>{const keep=Buffer.from(bytes).subarray(0,Math.max(0,1024*1024-logBytes));if(keep.length){fs.writeSync(fd,keep);logBytes+=keep.length}};
 const lines=readline.createInterface({input:child.stdout});
 lines.on('line',line=>{
  log(line+'\n');
  const marker=line.indexOf('STREAM_KIT_AUDIO:');
  if(marker<0)return;
  try{
   const event=JSON.parse(line.slice(marker+'STREAM_KIT_AUDIO:'.length));
   if(event.event==='recording'){
    if(event.device_id!==deviceId)throw Error('UE5 opened a different capture endpoint');
    recordingSeen=true;resolveReady(event);
   }
  }catch(error){rejectReady(error);child.kill()}
 });
 child.stderr.on('data',log);
 const timer=setTimeout(()=>{expired=true;child.kill()},120000);
 const done=new Promise((resolve,reject)=>{
  child.once('error',reject);
  child.once('close',(code,signal)=>{
   try{
    if(expired||signal||code!==0)throw Error(`UE5 capture failed (${expired?'timeout':signal||code}); inspect ${logFile}`);
    if(fs.statSync(resultFile).size>1024*1024)throw Error('UE5 result exceeded its size limit');
    const result=JSON.parse(fs.readFileSync(resultFile,'utf8'));
    if(result.schema_version!==1||result.error)throw Error(result.error||'Unsupported UE5 capture result');
    if(!listOnly&&(!recordingSeen||!result.capture_success||!result.stream_closed||result.selected_device?.id!==deviceId))throw Error('UE5 did not confirm and complete the requested endpoint recording');
    if(listOnly)resolveReady();
    resolve(result);
   }catch(error){reject(error)}
  });
 }).finally(()=>{clearTimeout(timer);lines.close();fs.closeSync(fd)});
 done.catch(error=>rejectReady(error));
 return {ready,done,cancel:()=>child.kill()};
}

async function listUE5Devices(options){return launch({...options,listOnly:true}).done}
async function startUE5Capture(options){const recording=launch(options);await recording.ready;return recording}
module.exports={verifiedUE5Build,listUE5Devices,startUE5Capture};
