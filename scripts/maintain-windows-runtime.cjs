// Operator maintenance tool. Not an installer, background updater or runtime
// dependency. Run with the development Node runtime in an elevated terminal.
// Replaces complete, verified components; keeps the installed service and data.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const https = require('node:https');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {setTimeout: delay} = require('node:timers/promises');

const components = ['orchestrator', 'media-gateway', 'sunshine'];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function hash(file) {
  const digest=crypto.createHash('sha256'),buffer=Buffer.alloc(65536),fd=fs.openSync(file,'r');
  try{let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,count));}
  finally{fs.closeSync(fd);}
  return digest.digest('hex');
}
const quote = value => "'" + value.replaceAll("'", "''") + "'";
// Existing absolute Windows filenames cannot contain quotes or end with a
// separator. For this restricted input, this matches Go ComposeCommandLine.
function commandPath(file) {
  assert.ok(path.isAbsolute(file) && !/["\r\n]/.test(file) && !/[\\/]$/.test(file),'Invalid service file path');
  return /[ \t]/.test(file) ? '"'+file+'"' : file;
}
function inside(base, target) {
  const full = path.resolve(target), relative = path.relative(base, full);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('Path outside maintenance boundary');
  return full;
}
function ordinary(target) {
  const full = path.resolve(target), stat = fs.lstatSync(full);
  if (stat.isSymbolicLink() || fs.realpathSync(full).toLowerCase() !== full.toLowerCase()) throw Error('Linked maintenance path');
  return full;
}
function inventory(directory, limit) {
  const entries = new Map(); let bytes = 0;
  function visit(folder) {
    ordinary(folder);
    for (const item of fs.readdirSync(folder, {withFileTypes:true})) {
      const file = ordinary(inside(directory, path.join(folder,item.name)));
      if (item.isDirectory()) visit(file);
      else if (item.isFile()) {
        bytes += fs.statSync(file).size;
        if (bytes > limit || entries.size >= 20000) throw Error('Maintenance inventory budget exceeded');
        entries.set(path.relative(directory,file), hash(file));
      } else throw Error('Special maintenance entry');
    }
  }
  visit(directory); return entries;
}
function execute(executable, args, cwd) {
  try { return cp.execFileSync(executable,args,{cwd,encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:4<<20}); }
  catch (error) { throw Error(`${path.basename(executable)} command failed (exit ${error.status ?? 'unknown'})`); }
}
const shell = script => execute(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
  ['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';"+script]);
function copyTree(source, target, limit) {
  const original = inventory(source,limit);
  assert.ok(!fs.existsSync(target),'Backup/staging destination already exists');
  fs.cpSync(source,target,{recursive:true,force:false,errorOnExist:true});
  assert.deepEqual(inventory(target,limit),original,'Copied files differ');
}

class RuntimeMaintenance {
  constructor(options) {
    assert.equal(process.platform,'win32','Windows runtime maintenance only');
    this.options = options;
    this.root = ordinary(options['--program-dir']);
    this.data = ordinary(options['--data-dir']);
    this.source = ordinary(options['--platform']);
    for (const [a,b] of [[this.root,this.data],[this.source,this.root],[this.source,this.data]]) {
      const relative=path.relative(a,b), reverse=path.relative(b,a);
      const external=value=>value==='..'||value.startsWith('..'+path.sep)||path.isAbsolute(value);
      assert.ok(relative && reverse && external(relative) && external(reverse),'Maintenance roots overlap');
    }
    this.origin = new URL(options['--origin']);
    assert.ok(this.origin.protocol==='https:' && ['127.0.0.1','localhost','[::1]'].includes(this.origin.hostname)
      && this.origin.pathname==='/' && !this.origin.username && !this.origin.password && !this.origin.search && !this.origin.hash,'Expected local HTTPS origin');
    assert.match(options['--expected-commit'],/^[a-f0-9]{40}$/);
    this.resultFile = path.resolve(options['--result']);
    ordinary(path.dirname(this.resultFile));
    assert.ok(!fs.existsSync(this.resultFile),'Result must be a new file');
    for(const base of [this.root,this.data,this.source]){
      const relative=path.relative(base,this.resultFile);
      assert.ok(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative),'Result must be outside deployment and candidate directories');
    }
    this.binary = path.join(this.root,'orchestrator/orchestrator.exe');
    this.configFile = inside(this.data,path.join(this.data,'orchestrator.json'));
    this.moved = [];
    this.report = {schema_version:1,success:false,apply:!!options['--apply'],source:options['--expected-commit'],started_at:new Date().toISOString(),trust_changed:false,network_changed:false};
  }
  save(step) { this.report.step=step; fs.writeFileSync(this.resultFile,JSON.stringify(this.report,null,2)+'\n'); }
  move(from,to,base) {
    inside(base,from); inside(base,to); ordinary(from); ordinary(path.dirname(to));
    assert.ok(!fs.existsSync(to),'Move destination already exists');
    fs.renameSync(from,to);
  }
  service() {
    const value=JSON.parse(shell('Get-CimInstance Win32_Service -Filter "Name=\'StreamKitOrchestrator\'" | Select-Object PathName,StartMode,StartName,State,ProcessId | ConvertTo-Json -Compress'));
    assert.equal(value.PathName.toLowerCase(),(commandPath(this.binary)+' --config '+commandPath(this.configFile)).toLowerCase(),'Service does not belong to selected deployment');
    assert.equal(value.StartMode,'Auto'); assert.equal(value.StartName,'LocalSystem');
    return value;
  }
  api(route, method='GET', body, authenticate=true) {
    return new Promise((resolve,reject)=>{
      const request=https.request(new URL('/api/v1'+route,this.origin),{ca:this.ca,method,timeout:10000,
        headers:{'Content-Type':'application/json',...(authenticate?{Authorization:'Bearer '+this.token}:{})}},response=>{
        let text='';
        response.on('error',reject);
        response.on('data',part=>{text+=part;if(text.length>4<<20)request.destroy(Error('Management response exceeded budget'));});
        response.on('end',()=>{try{assert.equal(response.statusCode,200,'Management request failed');const value=JSON.parse(text);assert.equal(value.status,'ok');resolve(value.data);}catch{reject(Error('Management request failed: '+route));}});
      });
      request.on('error',()=>reject(Error('Local HTTPS request failed')));
      request.on('timeout',()=>request.destroy(Error('Management timeout')));
      if(body)request.write(JSON.stringify(body));request.end();
    });
  }
  async requireIdle() {
    const [apps,media]=await Promise.all([this.api('/apps'),this.api('/media-control')]);
    assert.ok(apps.every(app=>!['running','starting','stopping'].includes(app.status)),'Stop active applications before maintenance');
    assert.ok(media.reachable && media.observations_valid && !Object.values(media.observations||{}).some(value=>value.upstream_active),'Media is active or unavailable');
    return apps.map(app=>app.id).sort();
  }
  verifyCandidate(directory) {
    inventory(directory,2*1024**3);
    assert.deepEqual(fs.readdirSync(directory).sort(),[...components,'README.md','platform-manifest.json'].sort(),'Candidate must contain only the runtime payload');
    const manifest=read(path.join(directory,'platform-manifest.json'));
    assert.equal(manifest.schema_version,1);
    assert.equal(manifest.commit,this.report.source);assert.equal(manifest.platform,'windows');assert.equal(manifest.architecture,'amd64');
    for(const component of components)assert.equal(read(path.join(directory,component,'bundle-manifest.json')).commit,this.report.source);
    // Reuse the production verifier and its authoritative component layouts.
    execute(path.join(directory,'orchestrator/orchestrator.exe'),['verify-platform',directory]);
    return manifest;
  }
  async validate() {
    this.save('validating');
    assert.equal(shell('[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)').trim(),'True','Use an elevated maintenance terminal');
    this.verifyCandidate(this.source);
    this.service();
    this.configBytes=fs.readFileSync(this.configFile);this.config=JSON.parse(this.configBytes.toString('utf8').replace(/^\uFEFF/,''));
    for(const [key,folder,file] of [['sunshine','sunshine','sunshine.exe'],['web_server','media-gateway','web-server.exe']]){
      assert.equal(path.resolve(this.config.components[key].exe_path).toLowerCase(),path.join(this.root,folder,file).toLowerCase(),'External component paths require separate deployment maintenance');
    }
    this.db=ordinary(inside(this.data,this.config.storage.db_path));
    this.trust=new Map();
    for(const file of [this.config.server.tls_cert,this.config.server.tls_key,this.config.server.lan_tls?.ca_cert,this.config.server.lan_tls?.ca_key].filter(Boolean)){
      ordinary(inside(this.data,file));this.trust.set(file,hash(file));
    }
    if(this.config.server.lan_tls?.ca_cert)this.ca=fs.readFileSync(this.config.server.lan_tls.ca_cert);
    const login=await this.api('/login','POST',{username:this.config.server.username,password:this.config.server.password},false);
    assert.ok(login.token);this.token=login.token;
    this.apps=await this.requireIdle();
    const health=await this.api('/health');this.report.previous_source=health.commit;
    this.report.previous_components=Object.fromEntries(components.map(component=>[component,read(path.join(this.root,component,'bundle-manifest.json')).commit]));
    execute(this.binary,['verify-bundle',path.join(this.root,'orchestrator')]);
    execute(path.join(this.source,'orchestrator/orchestrator.exe'),['check-config','--config',this.configFile]);
    execute(path.join(this.source,'media-gateway/web-server.exe'),['--config-path',path.join(this.data,'gateway/config.json'),'config','check']);
    this.health=health;
    for(const folder of ['gateway','sunshine'])inventory(path.join(this.data,folder),512<<20);
  }
  async waitReady(commit) {
    const until=Date.now()+90000;
    while(Date.now()<until){
      try{const health=await this.api('/health');if(health.commit===commit&&['sunshine','web_server'].every(key=>health.components?.[key]?.status==='running')){assert.equal(this.service().State,'Running');return health;}}catch{}
      await delay(1000);
    }
    throw Error('Control, desktop worker and native components did not recover');
  }
  stop() {
    // SCM owns process teardown. Never terminate other sessions by process name.
    this.service();
    // Capture process objects before stop, so PID reuse cannot cause us to
    // wait on an unrelated replacement. This works during partial replacement
    // too, when orchestrator.exe may temporarily be in the rollback directory.
    const ownedRoots=components.map(component=>quote(path.join(this.root,component)+path.sep)).join(',');
    shell("$prefixes=@("+ownedRoots+");$owned=@(Get-Process | Where-Object {$candidate=$_.Path;$candidate -and @($prefixes | Where-Object {$candidate.StartsWith($_,[StringComparison]::OrdinalIgnoreCase)}).Count});"+
      "if((Get-Service StreamKitOrchestrator).Status -ne 'Stopped'){Stop-Service StreamKitOrchestrator};"+
      "(Get-Service StreamKitOrchestrator).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(45));if($owned.Count){$owned|Wait-Process -Timeout 45}");
  }
  async apply() {
    const stamp=Date.now()+'-'+crypto.randomBytes(3).toString('hex');
    this.stage=inside(this.root,path.join(this.root,'.maintenance-incoming-'+stamp));
    this.backup=inside(this.root,path.join(this.root,'.maintenance-previous-'+stamp));
    this.state=inside(this.data,path.join(this.data,'runtime-maintenance-'+stamp));
    copyTree(this.source,this.stage,2*1024**3);this.verifyCandidate(this.stage);
    // Verify that native preflight released its files before stopping the
    // installed service. Antivirus/file locks must fail while it still runs.
    const moveCheck=this.stage+'-move-check';
    this.move(this.stage,moveCheck,this.root);this.move(moveCheck,this.stage,this.root);
    fs.mkdirSync(this.backup);fs.mkdirSync(this.state);
    execute('icacls.exe',[this.state,'/inheritance:r','/grant:r','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F']);
    this.report.runtime_backup=this.backup;this.report.state_backup=this.state;
    assert.deepEqual(await this.requireIdle(),this.apps);
    assert.ok(fs.readFileSync(this.configFile).equals(this.configBytes),'Configuration changed during preflight');
    this.save('stopping_service');this.stopped=true;this.stop();
    // Cold state snapshot after all owners exited. Keep app archives/external
    // application directories in place; no unbounded deployment-wide copy.
    fs.copyFileSync(this.configFile,path.join(this.state,'orchestrator.json'));
    let trustIndex=0;
    for(const file of this.trust.keys())fs.copyFileSync(file,path.join(this.state,'trust-'+trustIndex++));
    for(const suffix of ['', '-wal','-shm'])if(fs.existsSync(this.db+suffix))fs.copyFileSync(this.db+suffix,path.join(this.state,'database'+suffix));
    for(const folder of ['gateway','sunshine']){
      execute('icacls.exe',[folder,'/save',path.join(this.state,folder+'-acl.txt'),'/t','/q'],this.data);
      copyTree(path.join(this.data,folder),path.join(this.state,folder),512<<20);
    }
    this.save('replacing_runtime');
    for(const name of [...components,'platform-manifest.json','README.md']){
      const current=path.join(this.root,name);
      this.move(current,path.join(this.backup,name),this.root);this.moved.push(name);
      this.move(path.join(this.stage,name),current,this.root);
    }
    execute(this.binary,['verify-platform',this.root]);
    this.save('starting_service');this.started=true;
    execute(this.binary,['service','start','--config',this.configFile]);
    await this.waitReady(this.report.source);
    assert.deepEqual((await this.api('/apps')).map(app=>app.id).sort(),this.apps,'Application identities changed');
    assert.ok(fs.readFileSync(this.configFile).equals(this.configBytes),'Maintenance must preserve configuration');
    for(const [file,digest]of this.trust)assert.equal(hash(file),digest,'Deployment trust changed');
    this.report.scope='Complete runtime maintenance; original installer/uninstaller and signed drivers retained. Not a fresh installer acceptance.';
    const oldRecord=path.join(this.root,'control-maintenance.json');
    if(fs.existsSync(oldRecord))this.move(oldRecord,path.join(this.backup,'control-maintenance.json'),this.root);
    this.report.success=true;this.report.finished_at=new Date().toISOString();
    this.save('complete');
  }
  async rollback() {
    if(!this.stopped)return;
    this.save('rolling_back');
    this.stop();
    for(const name of [...this.moved].reverse()){
      const current=path.join(this.root,name);
      if(fs.existsSync(current))this.move(current,path.join(this.backup,'failed-'+name),this.root);
      this.move(path.join(this.backup,name),current,this.root);
    }
    if(this.started){
      fs.copyFileSync(path.join(this.state,'orchestrator.json'),this.configFile);
      let trustIndex=0;
      for(const file of this.trust.keys())fs.copyFileSync(path.join(this.state,'trust-'+trustIndex++),file);
      for(const suffix of ['', '-wal','-shm']){
        const current=this.db+suffix,saved=path.join(this.state,'database'+suffix);
        if(fs.existsSync(current))this.move(current,path.join(this.state,'failed-database'+suffix),this.data);
        if(fs.existsSync(saved))fs.copyFileSync(saved,current);
      }
      for(const folder of ['gateway','sunshine']){
        this.move(path.join(this.data,folder),path.join(this.state,'failed-'+folder),this.data);
        copyTree(path.join(this.state,folder),path.join(this.data,folder),512<<20);
        execute('icacls.exe',[this.data,'/restore',path.join(this.state,folder+'-acl.txt'),'/q']);
      }
    }
    const oldRecord=path.join(this.backup,'control-maintenance.json');
    if(fs.existsSync(oldRecord))this.move(oldRecord,path.join(this.root,'control-maintenance.json'),this.root);
    execute(this.binary,['service','start','--config',this.configFile]);
    await this.waitReady(this.report.previous_source);this.report.rollback=true;
  }
  async run() {
    try{
      await this.validate();
      if(this.options['--apply'])await this.apply();
      else{this.report.success=true;this.save('preflight_complete');}
    }catch(error){
      this.report.success=false;
      this.report.error=error.message;
      try{await this.rollback();}catch(rollbackError){this.report.rollback=false;this.report.rollback_error=rollbackError.message;}
      this.save('failed');throw Error('Runtime maintenance failed; inspect the result file');
    }
  }
}

async function main() {
  const options={};
  for(let index=2;index<process.argv.length;index++){
    const key=process.argv[index];
    assert.ok(['--platform','--program-dir','--data-dir','--origin','--expected-commit','--result','--apply'].includes(key)&&!options[key],'Invalid or duplicate maintenance option');
    options[key]=key==='--apply'?true:process.argv[++index];
    assert.ok(options[key],'Missing maintenance option value');
  }
  for(const key of ['--platform','--program-dir','--data-dir','--origin','--expected-commit','--result'])assert.ok(options[key],'Missing '+key);
  await new RuntimeMaintenance(options).run();
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={inside,ordinary,inventory,copyTree,commandPath};
