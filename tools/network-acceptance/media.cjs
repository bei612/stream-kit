// Fixture operator: provision an ordinary managed app and permanent entry,
// then supervise the independent browser through inherited stdio (not LAN).
const path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
module.exports=async function startMedia({config,api,clientPID,report,save}){
  const base='https://127.0.0.1:18080';
  const auth=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:config.moonlight_web.username,password:config.moonlight_web.password})});
  assert.ok(auth.ok);const cookie=auth.headers.get('set-cookie').split(';')[0];
  const native=(resource,method='GET',body)=>fetch(base+'/api'+resource,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  // Read-only observation: product LaunchApp must create and pair the renderer.
  // The fixture never POSTs /host, /pair or the renderer's /api/pin.
  const hosts=async()=>{
    const response=await native('/hosts');assert.ok(response.ok);
    const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
    try{for(;;){const {done,value}=await reader.read();assert.ok(!done,'Missing host snapshot');pending+=decoder.decode(value,{stream:true});const end=pending.indexOf('\n');if(end>=0)return JSON.parse(pending.slice(0,end)).hosts;}}
    finally{await reader.cancel();}
  };
  assert.deepEqual(await hosts(),[],'Fresh deployment must have no pre-paired renderer');
  report.fresh_gateway_before_launch=true;save();
  const app=await api('/apps/local','POST',{name:'Isolated LAN target',exe_path:'/usr/bin/xmessage',args:'-geometry 640x360 Stream-Kit-LAN',capture_mode:'desktop'});
  assert.equal(app.status,'ready');
  const watch=await api(`/apps/${app.id}/watch-link`,'POST');assert.ok(watch.enabled);
  const child=spawn('sudo',['--preserve-env=HOME,PATH,NODE_EXTRA_CA_CERTS,GITHUB_ACTIONS,RUNNER_ENVIRONMENT','nsenter','-t',clientPID,'-m','-n','--setuid='+process.getuid(),'--setgid='+process.getgid(),'--',process.execPath,path.resolve('tools/network-acceptance/browser.cjs')],{stdio:['pipe','pipe','ignore']});
  const requests=new Map();let sequence=0;
  readline.createInterface({input:child.stdout}).on('line',line=>{
    let message;try{message=JSON.parse(line);}catch{return;}
    const request=requests.get(message.id);if(!request)return;
    requests.delete(message.id);clearTimeout(request.timer);
    if(message.error){report.media_failure=message.state;save();request.reject(Error(message.error));}
    else request.resolve(message.result);
  });
  const fail=()=>{for(const request of requests.values()){clearTimeout(request.timer);request.reject(Error('Independent browser exited'));}requests.clear();};
  child.on('error',fail);child.on('exit',fail);
  const send=(message,timeout=140000)=>new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{requests.delete(id);reject(Error('Independent browser response timeout'));},timeout);
    requests.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({...message,id})+'\n');
  });
  const close=async()=>{
    try{if(child.exitCode===null&&child.signalCode===null)await send({action:'close'},10000);}finally{child.stdin.end();}
    await api(`/apps/${app.id}/stop`,'POST');
  };
  try{
    report.media_before=await send({action:'start',url:new URL(watch.path,'https://stream-kit-server.local:19000').href});
    const registered=await hosts();assert.equal(registered.length,1);assert.equal(registered[0].paired,'Paired');
    report.renderer_enrollment={automatic:true,host_count:registered.length,host_id:registered[0].host_id,paired:true,fixture_pairing_mutations:0};save();
    return {recover:async()=>{report.media_after=await send({action:'recover'});report.media_reconnected_without_reload=true;save();},close};
  }catch(error){await close().catch(()=>{});throw error;}
};
