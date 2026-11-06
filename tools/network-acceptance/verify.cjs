// Real native listeners and remote WebRTC across a fixture-NIC address change.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync,spawn}=require('node:child_process');
const {once}=require('node:events');
const {setTimeout:delay}=require('node:timers/promises');
const crypto=require('node:crypto');
assert.equal(process.platform,'linux');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.notEqual(process.getuid(),0);
const scratch=process.env.STREAM_KIT_NETWORK_FIXTURE;
assert.ok(scratch&&scratch.startsWith(process.env.RUNNER_TEMP+'/stream-kit-network.'));
const root=path.resolve('artifacts/network-runtime/opt/stream-kit'),data=path.join(scratch,'runtime'),tls=path.join(scratch,'tls');
const control=path.join(root,'orchestrator/orchestrator'),host='stream-kit-server.local';
const clientPID=fs.readFileSync(path.join(scratch,'client.pid'),'utf8').trim();assert.match(clientPID,/^[1-9][0-9]*$/);
const report={schema_version:1,passed:false,scope:'Separate client network and Avahi/DBus namespaces; exact native runtime HTTPS, renderer discovery and browser WebRTC recovery across an actual test-NIC IP change. No local Windows deployment, physical LAN, Android migration or new audio-quality acceptance.',acceptance_commit:process.env.GITHUB_SHA,observations:[]};
const save=()=>fs.writeFileSync('artifacts/network-address-evidence/result.json',JSON.stringify(report,null,2));
function run(file,args){return execFileSync(file,args,{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']}).trim();}
const client=(...args)=>run('sudo',['nsenter','-t',clientPID,'-m','-n','--',...args]);
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function until(fn,label,ms=30000){const end=Date.now()+ms;do{try{const value=await fn();if(value)return value;}catch{}await delay(300);}while(Date.now()<end);throw Error('Timeout: '+label);}
const get=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(3000)});assert.ok(r.ok);return r;};
let child,exit,login,media;
async function main(){
  report.stage='initialize_native_deployment';save();
  run(control,['init-platform','--root',root,'--data-dir',data,'--control-port','19000','--gateway-port','18080']);
  const cp=path.join(data,'orchestrator.json'),gp=path.join(data,'gateway/config.json');
  const c=JSON.parse(fs.readFileSync(cp)),g=JSON.parse(fs.readFileSync(gp));
  c.server.bind_address='0.0.0.0:19000';c.server.tls_cert=path.join(tls,'server.crt');c.server.tls_key=path.join(tls,'server.key');c.server.cors_origins=['https://{host}:18080'];
  c.moonlight_web.base_url='https://127.0.0.1:18080';c.moonlight_web.public_url='';c.components.web_server.health_check.url='https://127.0.0.1:18080/stream.html';
  g.web_server.bind_address='0.0.0.0:18080';g.web_server.certificate={certificate_pem:c.server.tls_cert,private_key_pem:c.server.tls_key};g.web_server.session_cookie_secure=true;g.web_server.control_plane_url='https://127.0.0.1:19000';
  c.components.web_server.env={...c.components.web_server.env,WEBRTC_ICE_SERVER_COUNT:'0'};
  fs.writeFileSync(cp,JSON.stringify(c));fs.writeFileSync(gp,JSON.stringify(g));
  // Use the same trusted CI leaf for the renderer's internal management API;
  // the operator's pairing requests also perform normal TLS verification.
  const sp=path.join(data,'sunshine/sunshine.conf');
  fs.writeFileSync(sp,fs.readFileSync(sp,'utf8').replace(/^pkey = .*$/m,'pkey = '+c.server.tls_key).replace(/^cert = .*$/m,'cert = '+c.server.tls_cert));
  run(control,['check-config','--config',cp]);run(c.components.web_server.exe_path,['--config-path',gp,'config','check']);
  report.runtime_commit=JSON.parse(fs.readFileSync(path.join(root,'platform-manifest.json'))).commit;
  report.configuration_hashes={control:hash(cp),gateway:hash(gp),renderer:hash(sp)};report.certificate_sha256=hash(c.server.tls_cert);
  const fd=fs.openSync(path.join(scratch,'control.log'),'w');
  child=spawn(control,['--config',cp],{cwd:data,stdio:['ignore',fd,fd]});fs.closeSync(fd);exit=once(child,'exit');
  await until(()=>get('https://127.0.0.1:19000/api/v1/health'),'control readiness');
  await until(()=>get('https://127.0.0.1:18080/config.js'),'gateway readiness');
  const auth=await fetch('https://127.0.0.1:19000/api/v1/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:c.server.username,password:c.server.password})});assert.ok(auth.ok);login=(await auth.json()).data.token;
  const api=async(resource,method='GET',body)=>{const r=await fetch('https://127.0.0.1:19000/api/v1'+resource,{method,headers:{Authorization:'Bearer '+login,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});assert.ok(r.ok,'Management operation failed: '+method+' '+resource+' '+r.status);return (await r.json()).data;};
  const components=async()=>{const r=await fetch('https://127.0.0.1:19000/api/v1/components',{headers:{Authorization:'Bearer '+login},signal:AbortSignal.timeout(3000)});assert.ok(r.ok);return (await r.json()).data;};
  const before=await until(async()=>{const list=await components();return list.length===2&&list.every(x=>x.pid>0&&x.status==='running')?list:false;},'native component readiness');
  const nativeInfo=async()=>await(await get('http://127.0.0.1:47989/serverinfo')).text();
  const identity=(await until(nativeInfo,'renderer readiness')).match(/<uniqueid>([^<]+)<\/uniqueid>/)?.[1];assert.ok(identity);
  const pids=list=>list.map(x=>({name:x.name,pid:x.pid})).sort((a,b)=>a.name.localeCompare(b.name));
  report.initial_pids=pids(before);
  async function observe(address){
    report.stage='resolve_'+address;save();
    const resolved=await until(()=>{const text=client('avahi-resolve-host-name','-4',host);return text.endsWith('\t'+address)?text:false;},'remote multicast resolution',60000);
    const records=await until(()=>{const text=client('avahi-browse','-rpt','_nvstream._tcp');return text.split('\n').find(x=>x.startsWith('=;')&&x.includes(';'+host+';'+address+';47989;'));},'renderer service discovery',60000);
    const curl=(port,resource,...options)=>client('curl','--noproxy','*','--fail','--silent','--show-error','--max-time','5','--cacert',path.join(tls,'ca.crt'),...options,`https://${host}:${port}${resource}`);
    const health=JSON.parse(curl(19000,'/api/v1/health'));assert.ok(health);
    const configs=[];
    for(const mode of [[],['--http1.1']]){
      const text=curl(18080,'/config.js',...mode,'--write-out','\nSK_HTTP:%{http_version}');
      const index=text.lastIndexOf('\nSK_HTTP:');assert.ok(index>0);
      const body=text.slice(0,index),prefix='window.__CONFIG_JS__ = ';assert.ok(body.startsWith(prefix));
      const config=JSON.parse(body.slice(prefix.length));
      configs.push({requested:mode.length?'http1.1':'default',http_version:text.slice(index+9),control_plane_url:config.control_plane_url});
    }
    const observation={address,resolved,renderer_service:records,control_https:true,gateway_https:true,configs,public_control_host_correct:false};
    report.observations.push(observation);save();
    assert.ok(configs.every(x=>x.control_plane_url===`https://${host}:19000`||x.control_plane_url===`https://${host}:19000/`),'Gateway leaked or retained the wrong control hostname');
    observation.public_control_host_correct=true;save();
  }
  await observe('198.18.31.1');
  report.stage='start_remote_media';save();
  media=await require('./media.cjs')({config:c,api,clientPID,report,save});
  report.stage='change_owned_nic';save();
  const addresses=JSON.parse(run('ip',['-j','address','show','dev','sknet-server']))[0].addr_info.filter(x=>x.family==='inet');
  assert.deepEqual(addresses.map(x=>[x.local,x.prefixlen]),[['198.18.31.1',24]]);
  run('sudo',['ip','address','del','198.18.31.1/24','dev','sknet-server']);
  run('sudo',['ip','address','add','198.18.31.2/24','dev','sknet-server']);
  await observe('198.18.31.2');
  report.stage='recover_remote_media';save();
  await media.recover();
  let oldReachable=true;
  try{client('curl','--noproxy','*','--fail','--silent','--max-time','3','--cacert',path.join(tls,'ca.crt'),'--resolve',`${host}:19000:198.18.31.1`,`https://${host}:19000/api/v1/health`);}catch{oldReachable=false;}
  assert.equal(oldReachable,false,'Old numeric address still reachable');
  assert.equal((await nativeInfo()).match(/<uniqueid>([^<]+)<\/uniqueid>/)?.[1],identity);
  assert.deepEqual(pids(await components()),report.initial_pids,'Components restarted during address change');
  assert.deepEqual({control:hash(cp),gateway:hash(gp),renderer:hash(sp)},report.configuration_hashes);assert.equal(hash(c.server.tls_cert),report.certificate_sha256);
  report.old_address_unreachable=true;report.renderer_identity_preserved=true;report.components_not_restarted=true;report.configuration_and_certificate_unchanged=true;report.passed=true;report.stage='complete';save();
}
main().catch(error=>{report.error=error.message.replaceAll(login||'__no_token__','[redacted]');process.exitCode=1;}).finally(async()=>{
  if(media)try{await media.close();report.target_stopped=true;}catch{report.passed=false;report.cleanup_failed=true;process.exitCode=1;}
  if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([exit,delay(15000,undefined,{ref:false}).then(()=>{if(child.exitCode===null){child.kill('SIGKILL');report.cleanup_forced=true;report.passed=false;process.exitCode=1;}})]);}
  report.finished_at=new Date().toISOString();save();console.log(JSON.stringify({passed:report.passed,stage:report.stage,error:report.error}));
});
