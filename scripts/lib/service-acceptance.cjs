// Elevated acceptance supervisor. Native product commands own SCM policy;
// this helper only bounds test lifetime and records results.
const fs=require('node:fs'), path=require('node:path');
const {execFileSync}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const [binary,config,directory,ownerArgument]=process.argv.slice(2);
const owner=Number(ownerArgument);
if(process.platform!=='win32'||!binary||!config||!directory||!Number.isSafeInteger(owner)||owner<=0)throw Error('Expected Windows binary, configuration, state directory and owner PID');
const result={passed:false,service_name:'StreamKitOrchestrator'};
const execute=(file,args)=>execFileSync(file,args,{encoding:'utf8',windowsHide:true,timeout:75000});
const powershell=command=>execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; "+command]);
const service=()=>JSON.parse(powershell("$s=Get-CimInstance Win32_Service -Filter \"Name='StreamKitOrchestrator'\"; if($s){$s|Select-Object ProcessId,StartName,State|ConvertTo-Json -Compress}else{'null'}"));
const ownerIdentity=()=>powershell(`(Get-Process -Id ${owner}).StartTime.ToUniversalTime().Ticks`).trim();
const native=operation=>execute(binary,['service',operation,'--config',config]);
const write=(name,value)=>{
  const file=path.join(directory,name),temporary=file+'.new';
  fs.writeFileSync(temporary,JSON.stringify(value));
  fs.renameSync(temporary,file);
};
(async()=>{
  let created=false;
  try {
    if(service())throw Error('Refusing to adopt an existing service');
    const identity=ownerIdentity();
    native('install');created=true;
    // Temporary acceptance must never leave an automatically started test
    // deployment after a reboot. Recovery/ownership remain the native policy.
    execute(path.join(process.env.SystemRoot,'System32','sc.exe'),['config','StreamKitOrchestrator','start=','demand']);
    native('start');
    const actual=service();
    if(!actual||actual.StartName!=='LocalSystem'||actual.State!=='Running')throw Error('Service did not start as LocalSystem');
    write('ready.json',{pid:actual.ProcessId,identity:actual.StartName,state:actual.State});
    const deadline=Date.now()+20*60*1000;
    let nextInspection=0;
    while(!fs.existsSync(path.join(directory,'stop'))){
      if(Date.now()>=deadline)throw Error('Service acceptance deadline exceeded');
      if(Date.now()>=nextInspection){
        if(ownerIdentity()!==identity)throw Error('Acceptance owner exited or changed');
        if(service()?.State!=='Running')throw Error('Service stopped unexpectedly');
        nextInspection=Date.now()+5000;
      }
      await delay(500);
    }
    result.passed=true;
  } catch(error) {
    // Do not serialize child stdout/stderr, which may contain runtime details.
    result.error=error.message;
  } finally {
    if(created){
      try {native('remove');result.removed=true;}
      catch(error){result.passed=false;result.cleanup_error=error.message;}
    }
    write('result.json',result);
  }
  process.exitCode=result.passed?0:1;
})().catch(error=>{console.error(error.message);process.exitCode=1;});
