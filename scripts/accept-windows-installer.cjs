// CI-only acceptance of a released installer. Never a runtime component.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const crypto=require('node:crypto'),assert=require('node:assert/strict');
const {isDeepStrictEqual}=require('node:util');
const {setTimeout:delay}=require('node:timers/promises');
const manifestFile=path.resolve(process.argv[2]||'');
const output=path.resolve(process.argv[3]||'');
assert.equal(process.platform,'win32');
assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
assert.equal(process.env.RUNNER_OS,'Windows');
assert.equal(process.argv.length,4,'Expected installer manifest and a new result directory');
assert.ok(!fs.existsSync(output),'Result directory must be new');
const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
assert.equal(manifest.payload_profile,'runtime');
assert.ok(manifest.audio_driver?.kernel_signature_verified && manifest.audio_driver.identity);
assert.match(manifest.commit,/^[a-f0-9]{40}$/);
assert.equal(path.basename(manifest.file.name),manifest.file.name);
const installer=path.join(path.dirname(manifestFile),manifest.file.name);
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(hash(installer),manifest.file.sha256,'Installer must match its manifest');
const ps=(script,input)=>cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
  {input:input===undefined?undefined:JSON.stringify(input),encoding:'utf8',windowsHide:true,timeout:30000});
assert.equal(ps('[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)').trim(),'True','Run the single installer acceptance helper elevated');
const service=()=>JSON.parse(ps('$s=Get-CimInstance Win32_Service -Filter "Name=\'StreamKitOrchestrator\'";if($s){$s|Select-Object Name,State,StartName,ProcessId,PathName|ConvertTo-Json -Compress}else{"null"}'));
const defaults=()=>JSON.parse(ps(`$ErrorActionPreference='Stop';$m=[Windows.Media.Devices.MediaDevice,Windows.Media.Devices,ContentType=WindowsRuntime];$r=[Windows.Media.Devices.AudioDeviceRole,Windows.Media.Devices,ContentType=WindowsRuntime];@{render=$m::GetDefaultAudioRenderId($r::Default);capture=$m::GetDefaultAudioCaptureId($r::Default);communication_render=$m::GetDefaultAudioRenderId($r::Communications);communication_capture=$m::GetDefaultAudioCaptureId($r::Communications)}|ConvertTo-Json -Compress`));
// Keep the array through -InputObject on Windows PowerShell 5.1.
const controllerInventory=()=>JSON.parse(ps(String.raw`ConvertTo-Json -InputObject @(Get-CimInstance Win32_PnPEntity | Where-Object {$_.HardwareID -contains 'ROOT\USBIP_WIN2\UDE'} | Select-Object PNPDeviceID,ConfigManagerErrorCode) -Compress`));
const name='StreamKit-Audio-Acceptance-'+manifest.commit.slice(0,8)+'-'+crypto.randomBytes(3).toString('hex');
const program=path.join(process.env.ProgramFiles,name),data=path.join(process.env.ProgramData,name);
assert.equal(service(),null,'An existing SCM deployment must not be changed');
assert.ok(!fs.existsSync(program)&&!fs.existsSync(data),'Install destinations must be new');
fs.mkdirSync(output,{recursive:true});
const result={passed:false,scope:'One private unified installer with its configured virtual audio device; native PCM, service lifecycle and reuse checks. No browser, human speech or public release claim.',commit:manifest.commit,installer_source_commit:manifest.installer_source_commit,installer_sha256:manifest.file.sha256,identity:manifest.audio_driver.identity,program,data,started_at:new Date().toISOString()};
const save=()=>fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n');
const execute=(file,args)=>cp.spawnSync(file,args,{windowsHide:true,encoding:'utf8',timeout:240000});
// Installing the first input can supply a previously absent recording default.
// Preserve every pre-existing input default and both output roles.
const defaultsPreserved=(before,after)=>['render','communication_render','capture','communication_capture'].every(key=>((key==='capture'||key==='communication_capture')&&!before[key])||before[key]===after[key]);
let installed=false,token;
const control='http://127.0.0.1:19000';
async function request(route,method='GET',body){
 const response=await fetch(control+'/api/v1'+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 if(response.status!==200)throw Object.assign(Error(`Control ${method} ${route}: ${response.status}`),{status:response.status});
 return (await response.json()).data;
}
async function endpoints(){
 for(let attempt=0;attempt<100;attempt++){
  let inventory;
  try{inventory=await request('/audio-devices')}
  catch(error){if(![502,503].includes(error.status))throw error;await delay(100);continue}
  const devices=inventory.devices.filter(d=>d.name.includes('Stream Kit Virtual Audio'));
  const render=devices.filter(d=>d.output),capture=devices.filter(d=>d.input);
  assert.ok(render.length<=1&&capture.length<=1,'Ambiguous existing Stream Kit audio endpoints');
  if(render.length===1&&capture.length===1)return {render_device_id:render[0].id,capture_device_id:capture[0].id};
  await delay(100);
 }
 throw Error('Installed gateway did not expose its virtual endpoint pair');
}
(async()=>{
 try{
  result.defaults_before=defaults();result.controllers_before=controllerInventory();save();
  const installation=execute(installer,['/VERYSILENT','/SUPPRESSMSGBOXES','/SP-','/NORESTART','/DIR='+program,'/DATADIR='+data,'/CONTROLPORT=19000','/GATEWAYPORT=18080','/RENDERERPORT=48989','/LOG='+path.join(output,'install.log')]);
  result.install_exit=installation.status;
  installed=fs.existsSync(path.join(program,'unins000.exe'));
  assert.equal(installation.status,0,'Installer did not complete without reboot');
  const cfg=JSON.parse(fs.readFileSync(path.join(data,'orchestrator.json'),'utf8'));
  assert.equal(cfg.server.bind_address,'127.0.0.1:19000');
  const gateway=JSON.parse(fs.readFileSync(path.join(data,'gateway/config.json'),'utf8'));
  assert.equal(gateway.virtual_audio.vendor_id,result.identity.vendor_id);
  assert.equal(gateway.virtual_audio.product_id,result.identity.product_id);
  const prefix=result.identity.serial_prefix||'';
  assert.ok(gateway.virtual_audio.serial.startsWith(prefix));
  assert.match(gateway.virtual_audio.serial.slice(prefix.length),/^[A-Za-z0-9]{15}$/);
  result.virtual_audio_serial=gateway.virtual_audio.serial;
  const health=await request('/health');assert.equal(health.commit,manifest.commit);
  for(const key of ['sunshine','web_server'])assert.equal(health.components[key].status,'running');
  const login=await request('/login','POST',{username:cfg.server.username,password:cfg.server.password});token=login.token;
  assert.ok(token);result.admin_login=true;result.service=service();assert.equal(result.service.StartName,'LocalSystem');
  result.endpoints=await endpoints();
  result.pair=await request('/audio-devices/check-pair','POST',result.endpoints);
  assert.equal(result.pair.passed,true,'Installed native pair failed PCM verification');
  // Retain a failed invariant without aborting unrelated owned lifecycle checks.
  // This never upgrades a default-selection failure to an overall pass.
  result.defaults_during=defaults();
  result.defaults_preserved=defaultsPreserved(result.defaults_before,result.defaults_during);
  const state=await request('/components/web_server');
  // Retain the exact owned process handle before asking its manager to stop it.
  // The token is passed through stdin, never through a command line or log.
  const stopped=JSON.parse(ps(`$ErrorActionPreference='Stop';$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;$p=[Diagnostics.Process]::GetProcessById($v.pid);try{$null=$p.Handle;if(-not [String]::Equals($p.MainModule.FileName,$v.exe,[StringComparison]::OrdinalIgnoreCase)){throw 'Gateway process ownership mismatch'};$null=Invoke-RestMethod -Uri ($v.control+'/api/v1/components/web_server/stop') -Method Post -Headers @{Authorization=('Bearer '+$v.token)} -TimeoutSec 15;if(-not $p.WaitForExit(8000)){throw 'Gateway did not exit'};@{pid=$p.Id;exit_code=$p.ExitCode}|ConvertTo-Json -Compress}finally{$p.Dispose()}`,
    {pid:state.pid,exe:path.join(program,'media-gateway/web-server.exe'),control,token}));
  result.gateway_stop=stopped;assert.equal(stopped.exit_code,0,'Gateway required forced termination');
  await request('/components/web_server/start','POST');
  assert.deepEqual(await endpoints(),result.endpoints,'Persistent install identity changed across gateway restart');
  result.gateway_restarted=true;
  result.controllers_after=controllerInventory();
  if(result.controllers_before.length)assert.deepEqual(result.controllers_after,result.controllers_before,'Existing controller was replaced');
  result.defaults_after_restart=defaults();
  assert.ok(result.defaults_preserved&&defaultsPreserved(result.defaults_before,result.defaults_after_restart),'Installation or gateway restart changed Windows default audio endpoints');
  result.passed=true;
 }catch(error){result.error=error.message}
 finally{
  if(installed){
   const removal=execute(path.join(program,'unins000.exe'),['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/LOG='+path.join(output,'uninstall.log')]);
   result.uninstall_exit=removal.status;result.service_removed=service()===null;
   result.data_preserved=fs.existsSync(path.join(data,'orchestrator.json'));
   result.defaults_after=defaults();
   if(removal.status!==0||!result.service_removed||!result.data_preserved||!isDeepStrictEqual(result.defaults_after,result.defaults_before))result.passed=false;
  }
  // Preserve only runtime logs while already elevated; never copy configuration
  // or credentials and never require another elevation just to diagnose a failure.
  if(fs.existsSync(data)){
   try{
    const copyLogs=directory=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
     const file=path.join(directory,entry.name);
     if(entry.isDirectory())copyLogs(file);
     else if(entry.isFile()&&/\.log(?:\.\d+)?$/.test(entry.name)&&fs.statSync(file).size<=10*1024*1024){
      const dest=path.join(output,'runtime-logs',path.relative(data,file));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(file,dest);
     }
    }};copyLogs(data);
   }catch(error){result.log_collection_error=error.message}
  }
  result.finished_at=new Date().toISOString();save();
 }
 process.exitCode=result.passed?0:1;
})().catch(error=>{result.passed=false;result.error=error.message;save();process.exitCode=1});
