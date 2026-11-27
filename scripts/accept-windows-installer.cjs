// Acceptance of a released installer on a disposable Windows machine.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const crypto=require('node:crypto'),assert=require('node:assert/strict');
const {isDeepStrictEqual}=require('node:util');
const {setTimeout:delay}=require('node:timers/promises');
const {commandPath,ordinary}=require('./maintain-windows-runtime.cjs');
const manifestFile=path.resolve(process.argv[2]||'');
const output=path.resolve(process.argv[3]||'');
const mode=process.argv[4];
const stage=mode==='--win11-stage',resume=mode==='--win11-resume';
assert.equal(process.platform,'win32');
assert.ok(process.argv.length===4||((stage||resume)&&process.argv.length===5),
 'Expected installer manifest, result directory and optional --win11-stage or --win11-resume');
if(!stage&&!resume){
 assert.equal(process.env.GITHUB_ACTIONS,'true');
 assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
 assert.equal(process.env.RUNNER_OS,'Windows');
}
if(resume)ordinary(output);
else assert.ok(!fs.existsSync(output),'Result directory must be new');
const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
assert.equal(manifest.payload_profile,'runtime');
assert.ok(manifest.audio_driver?.kernel_signature_verified && manifest.audio_driver.identity);
assert.match(manifest.commit,/^[a-f0-9]{40}$/);
assert.equal(path.basename(manifest.file.name),manifest.file.name);
const installer=path.join(path.dirname(manifestFile),manifest.file.name);
function hash(file){
 const digest=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1<<20),handle=fs.openSync(file,'r');
 try{
  let count;
  while((count=fs.readSync(handle,buffer))>0)digest.update(buffer.subarray(0,count));
  return digest.digest('hex');
 }finally{fs.closeSync(handle)}
}
assert.equal(hash(installer),manifest.file.sha256,'Installer must match its manifest');
const ps=(script,input)=>cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
  {input:input===undefined?undefined:JSON.stringify(input),encoding:'utf8',windowsHide:true,timeout:30000});
assert.equal(ps('[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)').trim(),'True','Run the single installer acceptance helper elevated');
const service=()=>JSON.parse(ps('$s=Get-CimInstance Win32_Service -Filter "Name=\'StreamKitOrchestrator\'";if($s){$s|Select-Object Name,State,StartMode,StartName,ProcessId,PathName|ConvertTo-Json -Compress}else{"null"}'));
const windowsBoot=(stage||resume)&&JSON.parse(ps(String.raw`
$ErrorActionPreference='Stop';$os=Get-CimInstance Win32_OperatingSystem
@{boot_utc=$os.LastBootUpTime.ToUniversalTime().ToString('o');build=[int]$os.BuildNumber;product_type=[int]$os.ProductType;architecture=[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()} | ConvertTo-Json -Compress`));
if(windowsBoot){
 assert.equal(windowsBoot.product_type,1,'Reboot acceptance requires a Windows client OS');
 assert.ok(windowsBoot.build>=22000 && windowsBoot.architecture==='X64','Expected Windows 11 x64');
 assert.ok(Number.isFinite(Date.parse(windowsBoot.boot_utc)),'Windows did not report its OS boot time');
}
const defaults=()=>JSON.parse(ps(`$ErrorActionPreference='Stop';$m=[Windows.Media.Devices.MediaDevice,Windows.Media.Devices,ContentType=WindowsRuntime];$r=[Windows.Media.Devices.AudioDeviceRole,Windows.Media.Devices,ContentType=WindowsRuntime];@{render=$m::GetDefaultAudioRenderId($r::Default);capture=$m::GetDefaultAudioCaptureId($r::Default);communication_render=$m::GetDefaultAudioRenderId($r::Communications);communication_capture=$m::GetDefaultAudioCaptureId($r::Communications)}|ConvertTo-Json -Compress`));
// Keep the array through -InputObject on Windows PowerShell 5.1.
const controllerInventory=()=>JSON.parse(ps(String.raw`ConvertTo-Json -InputObject @(Get-CimInstance Win32_PnPEntity | Where-Object {$_.HardwareID -contains 'ROOT\USBIP_WIN2\UDE'} | Select-Object PNPDeviceID,ConfigManagerErrorCode) -Compress`));
const resultFile=path.join(output,'result.json');
const checkpoint=resume?JSON.parse(fs.readFileSync(ordinary(resultFile),'utf8')):null;
const prefix='StreamKit-Audio-Acceptance-'+manifest.commit.slice(0,8)+'-';
const name=resume?path.basename(checkpoint.program):prefix+crypto.randomBytes(3).toString('hex');
const program=path.join(process.env.ProgramFiles,name),data=path.join(process.env.ProgramData,name);
const executablePaths={orchestrator:'orchestrator/orchestrator.exe',sunshine:'sunshine/sunshine.exe',web_server:'media-gateway/web-server.exe'};
const orchestrator=path.join(program,executablePaths.orchestrator);
const config=path.join(data,'orchestrator.json');
const expectedServicePath=`${commandPath(orchestrator)} --config ${commandPath(config)}`;
function installedService(){
 const current=service();
 assert.equal(current?.PathName?.toLowerCase(),expectedServicePath.toLowerCase(),'SCM service does not belong to this installation');
 assert.equal(current.StartMode,'Auto');assert.equal(current.StartName,'LocalSystem');
 return current;
}
function verifyInstalledManifest(){
 ordinary(program);ordinary(data);ordinary(orchestrator);ordinary(config);
 const bytes=fs.readFileSync(ordinary(path.join(program,'platform-manifest.json')));
 assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),manifest.payload_manifest_sha256);
 const payload=JSON.parse(bytes);
 assert.equal(payload.commit,manifest.commit);
 for(const relative of Object.values(executablePaths)){
  const entry=payload.files.find(item=>item.path===relative);
  assert.ok(entry,`Missing installed executable inventory for ${relative}`);
  const file=ordinary(path.join(program,relative)),stat=fs.statSync(file);
  assert.ok(stat.isFile()&&stat.size===entry.bytes&&hash(file)===entry.sha256,`Installed executable does not match ${relative}`);
 }
}
if(resume){
 assert.match(name,new RegExp(`^${prefix}[a-f0-9]{6}$`));
 assert.equal(checkpoint.program,program);assert.equal(checkpoint.data,data);
 assert.equal(checkpoint.phase,'awaiting_reboot');assert.equal(checkpoint.passed,false);
 assert.equal(checkpoint.commit,manifest.commit);assert.equal(checkpoint.installer_source_commit,manifest.installer_source_commit);
 assert.equal(checkpoint.installer_sha256,manifest.file.sha256);
 assert.ok([0,3010].includes(checkpoint.install_exit),'The installer did not reach its staged state');
 assert.ok(Date.parse(windowsBoot.boot_utc)>Date.parse(checkpoint.pre_reboot.boot_utc) &&
  Date.parse(windowsBoot.boot_utc)>Date.parse(checkpoint.awaiting_reboot_at),'The OS has not rebooted since staging');
 verifyInstalledManifest();
 installedService();
}else{
 assert.equal(service(),null,'An existing SCM deployment must not be changed');
 assert.ok(!fs.existsSync(program)&&!fs.existsSync(data),'Install destinations must be new');
 fs.mkdirSync(output,{recursive:true});
}
const result=checkpoint||{passed:false,scope:'One private unified installer with its configured virtual audio device; native PCM, service lifecycle and reuse checks. No browser, human speech or public release claim.',commit:manifest.commit,installer_source_commit:manifest.installer_source_commit,installer_sha256:manifest.file.sha256,identity:manifest.audio_driver.identity,program,data,started_at:new Date().toISOString()};
const save=()=>fs.writeFileSync(resultFile,JSON.stringify(result,null,2)+'\n');
const execute=(file,args)=>cp.spawnSync(file,args,{windowsHide:true,encoding:'utf8',timeout:240000});
// Bounded, read-only evidence for native restart requests. Diagnostic failures
// never replace the installer result or turn an unexecuted PCM check into a pass.
const diagnosticLimit=4*1024*1024;
const setupApiLog=process.env.SystemRoot?path.join(process.env.SystemRoot,'INF','setupapi.dev.log'):undefined;
let setupApiBaseline,postInstallDiagnostics=false;
function diagnosticFailure(label,error){
 (result.diagnostic_errors??=[]).push({stage:label,message:String(error.message||error).slice(0,2048)});
}
function captureDeviceState(label){
 try{
  const snapshot=JSON.parse(ps(String.raw`
$ErrorActionPreference='Stop';$v=[Console]::In.ReadToEnd()|ConvertFrom-Json
$r=@{recorded_at=[DateTime]::UtcNow.ToString('o')}
try{
 $match='USB\VID_{0:X4}&PID_{1:X4}*' -f [int]$v.vendor_id,[int]$v.product_id
 $all=@(Get-CimInstance Win32_PnPEntity)
 $owned=@($all|Where-Object {($_.HardwareID -contains 'ROOT\USBIP_WIN2\UDE') -or ($_.PNPDeviceID -like $match)})
 $r.devices_total=$owned.Count;$r.devices_truncated=$owned.Count -gt 32
 $r.devices=@($owned|Select-Object -First 32|ForEach-Object {
  $d=@{id=$_.PNPDeviceID;name=$_.Name;service=$_.Service;status=$_.Status;problem_code=$_.ConfigManagerErrorCode;hardware_ids=@($_.HardwareID|Select-Object -First 8)}
  try{$d.properties=@(Get-PnpDeviceProperty -InstanceId $_.PNPDeviceID -KeyName 'DEVPKEY_Device_DevNodeStatus','DEVPKEY_Device_ProblemCode','DEVPKEY_Device_Parent','DEVPKEY_Device_DriverInfPath' -ErrorAction Stop|Select-Object KeyName,Data)}catch{$d.properties_error=$_.Exception.Message.Substring(0,[Math]::Min(512,$_.Exception.Message.Length))}
  $d
 })
 $audio=@($all|Where-Object {$_.PNPClass -in @('MEDIA','AudioEndpoint')})
 $r.audio_total=$audio.Count;$r.audio_truncated=$audio.Count -gt 128
 $r.audio=@($audio|Select-Object -First 128 PNPDeviceID,Name,Service,Status,ConfigManagerErrorCode)
}catch{$r.devices_error=$_.Exception.Message.Substring(0,[Math]::Min(512,$_.Exception.Message.Length))}
try{$r.services=@(Get-CimInstance Win32_Service -Filter "Name='AudioEndpointBuilder' OR Name='Audiosrv' OR Name='StreamKitOrchestrator'"|Select-Object Name,State,StartMode)}catch{$r.services_error=$_.Exception.Message.Substring(0,[Math]::Min(512,$_.Exception.Message.Length))}
try{
 $rename=Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -ErrorAction Stop
 $r.pending_reboot=@{component_servicing=(Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending');windows_update=(Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired');file_rename=([bool]$rename.PendingFileRenameOperations -or [bool]$rename.PendingFileRenameOperations2)}
}catch{$r.pending_reboot_error=$_.Exception.Message.Substring(0,[Math]::Min(512,$_.Exception.Message.Length))}
$r|ConvertTo-Json -Depth 7 -Compress`,result.identity));
  const body=JSON.stringify(snapshot,null,2)+'\n';
  assert.ok(Buffer.byteLength(body)<=diagnosticLimit,'Device diagnostics exceed their size limit');
  const file=`devices-${label}.json`;fs.writeFileSync(path.join(output,file),body);
  (result.diagnostics??={})[label]=file;
 }catch(error){diagnosticFailure(label,error)}
}
function beginSetupApiEvidence(){
 try{const s=fs.statSync(setupApiLog);setupApiBaseline={size:s.size,ino:s.ino,birthtime:s.birthtimeMs}}
 catch(error){if(error.code==='ENOENT')setupApiBaseline={size:0,missing:true};else diagnosticFailure('setupapi_before',error)}
}
function captureSetupApiEvidence(){
 let fd;
 try{
  assert.ok(setupApiBaseline,'SetupAPI baseline unavailable; refusing to copy unrelated historical logs');
  fd=fs.openSync(setupApiLog,'r');const s=fs.fstatSync(fd);
  const replaced=!setupApiBaseline.missing&&(s.ino!==setupApiBaseline.ino||s.birthtimeMs!==setupApiBaseline.birthtime||s.size<setupApiBaseline.size);
  const baseline=replaced?0:setupApiBaseline.size;
  const start=Math.max(baseline,s.size-diagnosticLimit),bytes=Buffer.alloc(s.size-start);
  let read=0;while(read<bytes.length){const count=fs.readSync(fd,bytes,read,bytes.length-read,start+read);if(count===0)break;read+=count}
  const file='setupapi-install-delta.log';fs.writeFileSync(path.join(output,file),bytes.subarray(0,read));
  (result.diagnostics??={}).setupapi={file,baseline_bytes:setupApiBaseline.size,observed_bytes:s.size,start_offset:start,captured_bytes:read,truncated:start>baseline,log_replaced_or_truncated:replaced,baseline_missing:!!setupApiBaseline.missing};
 }catch(error){diagnosticFailure('setupapi_after',error)}
 finally{if(fd!==undefined)try{fs.closeSync(fd)}catch(error){diagnosticFailure('setupapi_close',error)}}
}
function capturePostInstallDiagnostics(){
 if(postInstallDiagnostics)return;
 postInstallDiagnostics=true;
 captureDeviceState('after-install');captureSetupApiEvidence();
}
// Installing the first input can supply a previously absent recording default.
// Preserve every pre-existing input default and both output roles.
const defaultsPreserved=(before,after)=>['render','communication_render','capture','communication_capture'].every(key=>((key==='capture'||key==='communication_capture')&&!before[key])||before[key]===after[key]);
let installed=resume,keepForBoot=false,token;
const control='http://127.0.0.1:19000';
async function request(route,method='GET',body){
 const response=await fetch(control+'/api/v1'+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 if(response.status!==200)throw Object.assign(Error(`Control ${method} ${route}: ${response.status}`),{status:response.status});
 return (await response.json()).data;
}
const componentKeys=['sunshine','web_server'];
async function waitForInstalledHealth(){
 const deadline=Date.now()+90000;
 while(Date.now()<deadline){
  const health=await request('/health').catch(()=>null);
  if(health?.commit===manifest.commit&&componentKeys.every(key=>health.components?.[key]?.status==='running'))return health;
  await delay(200);
 }
 throw Error('SCM service did not recover both native components');
}
function bootProcesses(health){
 const controller=installedService();
 assert.equal(controller.State,'Running');
 const expected=[
  {role:'orchestrator',pid:controller.ProcessId,exe:orchestrator},
  ...componentKeys.map(role=>({role,pid:health.components[role].pid,exe:path.join(program,executablePaths[role])})),
 ];
 assert.ok(expected.every(item=>Number.isSafeInteger(item.pid)&&item.pid>0),'Missing live component PID');
 assert.equal(new Set(expected.map(item=>item.pid)).size,expected.length,'Duplicate runtime PIDs');
 const processes=JSON.parse(ps(String.raw`
$ErrorActionPreference='Stop';$expected=[Console]::In.ReadToEnd()|ConvertFrom-Json
$processes=@(foreach($item in $expected){
 $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[uint32]$item.pid)
 if(!$p -or ![String]::Equals($p.ExecutablePath,$item.exe,[StringComparison]::OrdinalIgnoreCase)){throw ('Unexpected runtime executable for '+$item.role)}
 @{role=$item.role;pid=$p.ProcessId;session=$p.SessionId;created_utc=$p.CreationDate.ToUniversalTime().ToString('o')}
})
ConvertTo-Json -InputObject $processes -Compress`,expected));
 assert.equal(processes.length,expected.length);
 assert.equal(processes[0].session,0,'Controller did not start in the SCM session');
 assert.ok(processes[1].session>0&&processes[1].session===processes[2].session,'Native components are not in the same interactive session');
 for(const [index,process] of processes.entries()){
  assert.equal(process.role,expected[index].role);assert.equal(process.pid,expected[index].pid);
  assert.ok(Date.parse(process.created_utc)>=Date.parse(windowsBoot.boot_utc),'Process creation predates this Windows boot');
 }
 assert.equal(installedService().ProcessId,controller.ProcessId,'SCM process changed during boot observation');
 return {service:controller,processes};
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
  if(!resume){
   result.defaults_before=defaults();result.controllers_before=controllerInventory();save();
   captureDeviceState('before-install');beginSetupApiEvidence();
   const installation=execute(installer,['/VERYSILENT','/SUPPRESSMSGBOXES','/SP-','/NORESTART','/DIR='+program,'/DATADIR='+data,'/CONTROLPORT=19000','/GATEWAYPORT=18080','/RENDERERPORT=48989','/LOG='+path.join(output,'install.log')]);
   result.install_exit=installation.status;
   installed=fs.existsSync(path.join(program,'unins000.exe'));
   capturePostInstallDiagnostics();
   if(stage){
    assert.ok([0,3010].includes(installation.status),'Installer did not return success or a reboot requirement');
    ordinary(path.join(program,'unins000.exe'));
    verifyInstalledManifest();
    result.pre_reboot={...windowsBoot,service:installedService()};
    result.awaiting_reboot_at=new Date().toISOString();
    result.phase='awaiting_reboot';
    save();keepForBoot=true;
    console.log('Windows 11 installer staged. Reboot the acceptance machine, sign in to the render desktop and run --win11-resume.');
    return;
   }
   assert.equal(installation.status,0,'Installer did not complete without reboot');
  }
  const cfg=JSON.parse(fs.readFileSync(config,'utf8'));
  for(const key of componentKeys)assert.equal(cfg.components[key].auto_start,true,`${key} must start with the installed controller`);
  assert.equal(cfg.server.bind_address,'127.0.0.1:19000');
  const gateway=JSON.parse(fs.readFileSync(path.join(data,'gateway/config.json'),'utf8'));
  assert.equal(gateway.virtual_audio.vendor_id,result.identity.vendor_id);
  assert.equal(gateway.virtual_audio.product_id,result.identity.product_id);
  const prefix=result.identity.serial_prefix||'';
  assert.ok(gateway.virtual_audio.serial.startsWith(prefix));
  assert.match(gateway.virtual_audio.serial.slice(prefix.length),/^[A-Za-z0-9]{15}$/);
  result.virtual_audio_serial=gateway.virtual_audio.serial;
  const health=resume?await waitForInstalledHealth():await request('/health');assert.equal(health.commit,manifest.commit);
  for(const key of componentKeys)assert.equal(health.components[key].status,'running');
  if(resume){
   result.post_reboot={...windowsBoot,observed_at:new Date().toISOString(),...bootProcesses(health)};
   captureDeviceState('after-reboot');save();
  }
  const login=await request('/login','POST',{username:cfg.server.username,password:cfg.server.password});token=login.token;
  assert.ok(token);result.admin_login=true;result.service=resume?installedService():service();assert.equal(result.service.StartName,'LocalSystem');
  assert.equal(result.service.StartMode,'Auto','Installer must persist automatic SCM startup');
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
  // Exercise the complete SCM owner as well as its interactive gateway worker.
  const previousServicePID=result.service.ProcessId;
  ps("$ErrorActionPreference='Stop';Restart-Service -Name StreamKitOrchestrator -ErrorAction Stop");
  await waitForInstalledHealth();
  result.service_after_restart=service();
  assert.equal(result.service_after_restart.StartName,'LocalSystem');
  assert.equal(result.service_after_restart.StartMode,'Auto');
  assert.ok(result.service_after_restart.ProcessId>0&&result.service_after_restart.ProcessId!==previousServicePID,'SCM restart must create a new controller process');
  assert.deepEqual(await endpoints(),result.endpoints,'SCM restart changed persistent audio endpoint identities');
  result.defaults_after_service_restart=defaults();
  assert.ok(defaultsPreserved(result.defaults_before,result.defaults_after_service_restart),'SCM restart changed existing audio defaults');
  result.scm_restarted=true;
  if(!resume&&process.env.STREAM_KIT_ROLLBACK_CANDIDATE){
   const {verifyWindowsMaintenance}=require('./lib/windows-maintenance-acceptance.cjs');
   result.maintenance_rollback=await verifyWindowsMaintenance({program,data,output,control,request,baselineCommit:manifest.commit,
    candidate:path.resolve('artifacts/maintenance-platform'),candidateCommit:process.env.STREAM_KIT_ROLLBACK_CANDIDATE,
    openssl:process.env.STREAM_KIT_ROLLBACK_OPENSSL,example:path.resolve('artifacts/maintenance-example/checkerboard.exe')});
  }
  result.passed=true;
 }catch(error){result.error=error.message}
 finally{
  if(!keepForBoot){
   if(setupApiBaseline)capturePostInstallDiagnostics();
   if(installed){
    const uninstaller=path.join(program,'unins000.exe');
    if(stage||resume){
     if(service())installedService();
     ordinary(uninstaller);
    }
    const removal=execute(uninstaller,['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/LOG='+path.join(output,'uninstall.log')]);
    result.uninstall_exit=removal.status;result.service_removed=service()===null;
    result.data_preserved=fs.existsSync(config);
    result.defaults_after=defaults();
    if(removal.status!==0||!result.service_removed||!result.data_preserved||!isDeepStrictEqual(result.defaults_after,result.defaults_before))result.passed=false;
   }
   collectRuntimeLogs();
   if(stage||resume)result.phase=result.passed?'completed':'failed';
   result.finished_at=new Date().toISOString();save();
  }
 }
 process.exitCode=result.passed?0:1;
})().catch(error=>{
 result.passed=false;result.error=error.message;
 if(stage||resume)result.phase='failed';
 save();process.exitCode=1;
});

// Collect runtime logs under the existing elevation. Leave configuration and
// credentials in their protected data directory.
function collectRuntimeLogs(){
 if(!fs.existsSync(data))return;
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
