const fs = require('node:fs');
const https = require('node:https');
const runtime = require('node:path').resolve(__dirname, '../.local/runtime');
const credentials = JSON.parse(fs.readFileSync(runtime + '/credentials.json', 'utf8'));
const basic = 'Basic ' + Buffer.from(credentials.username + ':' + credentials.password).toString('base64');
function sunshine(path, body, csrf, method) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request('https://127.0.0.1:47990' + path, {
      rejectUnauthorized: false, method: method || (data ? 'POST' : 'GET'),
      headers: { Authorization: basic, ...(data ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)} : {}), ...(csrf ? {'X-CSRF-Token':csrf} : {}) }
    }, res => { let text=''; res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:text})); });
    req.on('error',reject);if(data)req.write(data);req.end();
  });
}
(async()=>{
  const auth = await fetch('http://127.0.0.1:8080/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:credentials.username,password:credentials.password})});
  if(auth.status!==200)throw new Error('Moonlight login: '+auth.status+' '+await auth.text());
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const headers = {'Content-Type':'application/json',Cookie:cookie};
  const existing = await (await fetch('http://127.0.0.1:8080/api/hosts',{headers})).text();
  const hosts=JSON.parse(existing.split('\n')[0]).hosts;
  let host=hosts[0];
  if(!host){const res=await fetch('http://127.0.0.1:8080/api/host',{method:'POST',headers,body:JSON.stringify({address:'127.0.0.1',http_port:47989})});if(!res.ok)throw new Error(await res.text());host=(await res.json()).host;}
  console.log('Host ID:',host.host_id,'Pair status:',host.paired);
  const info=await sunshine('/api/csrf-token');
  if(info.status!==200)throw new Error('Sunshine login: '+info.status);
  const csrf=JSON.parse(info.body).csrf_token;
  if(host.paired!=='Paired'){
    const stale=JSON.parse((await sunshine('/api/pin')).body).pairings || [];
    for(const item of stale) await sunshine('/api/pin',{pairing_id:item.id},csrf,'DELETE');
    const pair=await fetch('http://127.0.0.1:8080/api/pair',{method:'POST',headers,body:JSON.stringify({host_id:host.host_id})});
    if(!pair.ok)throw new Error(await pair.text());
    const reader=pair.body.getReader();const decoder=new TextDecoder();let pending='';let submitted=false;let completed=false;
    for(;;){const {done,value}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});let newline;while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(!line.trim())continue;const event=JSON.parse(line);
      if(event.Pin && !submitted){
        let requests=[];
        for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,200));requests=JSON.parse((await sunshine('/api/pin')).body).pairings || [];if(requests.length)break;}
        if(!requests.length)throw new Error('Sunshine pairing request not found');
        const pinResult=await sunshine('/api/pin',{pairing_id:requests[requests.length-1].id,pin:event.Pin,name:'StreamKit browser gateway'},csrf);if(pinResult.status!==200)throw new Error('PIN rejected: '+pinResult.body);submitted=true;console.log('PIN submitted');}
      if(event.Paired){completed=true;console.log('Pairing completed');}
      if(event==='PairError'||event.PairError)throw new Error('Pairing failed');
    }}
    if(!completed)throw new Error('Pair response ended without success: '+pending);
  }
  const apps=await (await fetch('http://127.0.0.1:8080/api/apps?host_id='+host.host_id,{headers})).json();
  console.log('Available apps:',apps.apps.map(a=>a.title));
  fs.writeFileSync(runtime+'/paired-host.json',JSON.stringify({host_id:host.host_id,paired:true},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
