const fs=require('node:fs'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');

function interactiveIdentity(){
  if(process.platform!=='win32')throw Error('Windows SCM acceptance requires Windows');
  return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`@{sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;session=(Get-Process -Id ${process.pid}).SessionId}|ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true}));
}
async function startService(binary,config,scratch){
  const directory=fs.mkdtempSync(path.join(scratch,'service-'));
  const helper=path.join(__dirname,'service-acceptance.cjs');
  const values=[helper,binary,config,directory,String(process.pid)];
  if(values.some(value=>value.includes('"')||/[\r\n]/.test(value)))throw Error('Invalid service helper argument');
  const argumentList=values.map(value=>'"'+value+'"').join(' ').replaceAll("'","''");
  const executable=process.execPath.replaceAll("'","''");
  const command=`$ErrorActionPreference='Stop'; $p=Start-Process -FilePath '${executable}' -ArgumentList '${argumentList}' -Verb RunAs -WindowStyle Hidden -PassThru -Wait; exit $p.ExitCode`;
  const log=fs.openSync(path.join(directory,'helper.log'),'w');
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['ignore',log,log]});fs.closeSync(log);
  let exit=null;const ended=new Promise(resolve=>{child.once('error',e=>{exit={error:e.message};resolve(exit)});child.once('exit',code=>{exit={code};resolve(exit)})});
  const read=name=>fs.existsSync(path.join(directory,name))?JSON.parse(fs.readFileSync(path.join(directory,name),'utf8')):null;
  const close=async()=>{
    fs.writeFileSync(path.join(directory,'stop'),'');
    const outcome=await Promise.race([ended,delay(75000,undefined,{ref:false}).then(()=>({error:'Service cleanup timed out'}))]);
    const result=read('result.json');
    if(outcome.error||outcome.code!==0||!result?.passed||!result.removed)throw Error('Service acceptance cleanup failed: '+JSON.stringify({outcome,result}));
    return result;
  };
  // Native start bounds SCM transition and media readiness separately.
  for(let attempt=0;attempt<360;attempt++){
    const ready=read('ready.json');if(ready)return {ready,close};
    const result=read('result.json');if(result||exit)throw Error('Service startup failed: '+JSON.stringify({result,exit}));
    await delay(500);
  }
  fs.writeFileSync(path.join(directory,'stop'),'');
  throw Error('Service startup timed out; cleanup requested');
}
module.exports={interactiveIdentity,startService};
