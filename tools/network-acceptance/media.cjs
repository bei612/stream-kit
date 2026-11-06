// Fixture operator: provision an ordinary managed app and permanent entry,
// then supervise the independent browser through inherited stdio (not LAN).
const path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const {setTimeout:delay}=require('node:timers/promises');
module.exports=async function startMedia({config,api,clientPID,report,save}){
  const base='https://127.0.0.1:18080';
  const auth=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:config.moonlight_web.username,password:config.moonlight_web.password})});
  assert.ok(auth.ok);const cookie=auth.headers.get('set-cookie').split(';')[0];
  const native=(resource,method='GET',body)=>fetch(base+'/api'+resource,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  const json=async response=>{assert.ok(response.ok);return response.json();};
  const sun=async(resource,body,csrf)=>json(await fetch(config.sunshine_api.base_url+resource,{method:body===undefined?'GET':'POST',headers:{Authorization:'Basic '+Buffer.from(config.sunshine_api.username+':'+config.sunshine_api.password).toString('base64'),'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)}));
  const host=(await json(await native('/host','POST',{address:'127.0.0.1',http_port:47989}))).host;
  const previous=new Set(((await sun('/api/pin')).pairings||[]).map(p=>p.id));
  const csrf=(await sun('/api/csrf-token')).csrf_token;
  const response=await native('/pair','POST',{host_id:host.host_id});assert.ok(response.ok);
  let pending='',paired=false;const decoder=new TextDecoder();
  for await(const chunk of response.body){
    pending+=decoder.decode(chunk,{stream:true});let index;
    while((index=pending.indexOf('\n'))>=0){
      const line=pending.slice(0,index);pending=pending.slice(index+1);if(!line.trim())continue;
      const event=JSON.parse(line);
      if(event.Pin){
        let candidates=[];
        for(let i=0;i<100;i++){candidates=((await sun('/api/pin')).pairings||[]).filter(p=>!previous.has(p.id));if(candidates.length)break;await delay(100);}
        assert.equal(candidates.length,1);
        await sun('/api/pin',{pairing_id:candidates[0].id,pin:event.Pin,name:'Isolated network acceptance'},csrf);
      }
      if(event.Paired)paired=true;
      assert.ok(event!=='PairError'&&!event.PairError);
    }
  }
  assert.ok(paired);
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
    report.media_before=await send({action:'start',url:new URL(watch.path,'https://stream-kit-server.local:19000').href});save();
    return {recover:async()=>{report.media_after=await send({action:'recover'});report.media_reconnected_without_reload=true;save();},close};
  }catch(error){await close().catch(()=>{});throw error;}
};
