const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(__dirname,'..');
const runtime=path.join(root,'.local/runtime');
const creds=JSON.parse(fs.readFileSync(runtime+'/credentials.json','utf8'));
const base='http://127.0.0.1:9000',gateway='http://127.0.0.1:8080';
const output=path.join(root,'artifacts/streaming');fs.mkdirSync(output,{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const run={startedAt:new Date().toISOString(),status:'running',direct:process.argv.includes('--direct'),videoOnly:process.argv.includes('--video-only')};
const saveRun=()=>fs.writeFileSync(output+'/latest-run.json',JSON.stringify(run,null,2));
async function main(){
  saveRun();
  const anonymousUser=await fetch(gateway+'/api/user');
  assert.equal(anonymousUser.status,200,'Fresh gateway requests should not require a password');
  const viewer=await anonymousUser.json();
  assert.equal(viewer.is_default_user,true);
  assert.equal(viewer.role,'User');
  assert.ok([401,403].includes((await fetch(gateway+'/api/users')).status));
  const login=await fetch(base+'/api/v1/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:creds.username,password:creds.password})});
  assert.equal(login.status,200);const token=(await login.json()).data.token;
  const headers={Authorization:'Bearer '+token};
  async function api(endpoint,options={}){const r=await fetch(base+'/api/v1'+endpoint,{...options,headers:{...headers,...options.headers}});const json=await r.json();if(!r.ok)throw new Error(JSON.stringify(json));return json.data;}
  let app=(await api('/apps')).find(a=>a.name==='Checkerboard Example');
  if(!app){const form=new FormData();form.set('name','Checkerboard Example');form.set('args','-fullscreen 8');form.set('file',new Blob([fs.readFileSync(path.join(root,'artifacts/example/example.zip'))]),'example.zip');const result=await api('/apps/upload',{method:'POST',body:form});app={id:result.app_id};}
  for(let i=0;i<100;i++){app=await api('/apps/'+app.id);if(['ready','stopped','running','register_failed','error'].includes(app.status))break;await delay(200);}
  assert.ok(['ready','stopped','running'].includes(app.status),JSON.stringify(app));
  const launch=await api('/apps/'+app.id+'/launch',{method:'POST'});
  console.log('Launch URL:',launch.stream_url);
  fs.writeFileSync(runtime+'/example-app.json',JSON.stringify({app_id:app.id,stream_url:'http://127.0.0.1:'+launch.stream_url},null,2));
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({viewport:{width:1280,height:720}});
  await context.addInitScript(()=>{
    window.__pcs=[];const Original=window.RTCPeerConnection;window.RTCPeerConnection=class extends Original{constructor(...args){super(...args);window.__pcs.push(this)}};
    localStorage.setItem('mlSettings',JSON.stringify({videoSize:'720p',fps:30,bitrate:8000,videoCodec:'h264',dataTransport:'webrtc',forceVideoElementRenderer:true,canvasRenderer:false,playAudioLocal:true,language:'en'}));
  });
  let page;
  if(process.argv.includes('--direct')){
    page=await context.newPage();
    await page.goto(gateway+'/stream.html'+new URL('http://127.0.0.1:'+launch.stream_url).search);
  }else{
    const management=await context.newPage();
    await management.goto(base+'/login');
    await management.locator('#username').fill(creds.username);
    await management.locator('#password').fill(creds.password);
    await management.locator('button[type="submit"]').click();
    await management.waitForURL(base+'/');
    await management.goto(base+'/apps/'+app.id);
    await management.getByText('checkerboard.exe',{exact:true}).waitFor();
    const popup=context.waitForEvent('page');
    await management.getByRole('button',{name:'启动串流',exact:true}).click();
    page=await popup;
  }
  const logs=[];
  page.on('console',m=>logs.push(m.type()+': '+m.text()));page.on('pageerror',e=>logs.push('PAGEERROR: '+e.message));
  try{
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(()=>{const v=document.querySelector('video');return v&&v.videoWidth>0&&v.readyState>=2&&v.getVideoPlaybackQuality().totalVideoFrames>10},{},{timeout:60000});
    assert.equal(await page.locator('#ml-api-name').isVisible(),false,'Passwordless stream displayed a login form');
    console.log('Video frames received');
    await delay(3000);
    const evidence=await page.evaluate(async()=>{
      const v=document.querySelector('video');const canvas=document.createElement('canvas');canvas.width=v.videoWidth;canvas.height=v.videoHeight;const ctx=canvas.getContext('2d');ctx.drawImage(v,0,0);
      const peers=[];for(const pc of window.__pcs){const stats=await pc.getStats();peers.push({state:pc.connectionState,stats:[...stats.values()].filter(s=>s.type==='inbound-rtp'||s.type==='codec'||s.type==='candidate-pair'&&s.state==='succeeded')});}
      return{width:v.videoWidth,height:v.videoHeight,frames:v.getVideoPlaybackQuality().totalVideoFrames,peers,image:canvas.toDataURL('image/png'),sample1:[...ctx.getImageData(80,126,1,1).data],sample2:[...ctx.getImageData(240,126,1,1).data]};
    });
    fs.writeFileSync(output+'/received-frame.png',Buffer.from(evidence.image.split(',')[1],'base64'));delete evidence.image;
    await page.screenshot({path:output+'/browser-stream.png'});
    assert.ok(evidence.peers.some(p=>p.state==='connected'),'WebRTC was not connected');
    assert.ok(evidence.frames>10,'No decoded frames');
    for(let i=0;i<40;i++){app=await api('/apps/'+app.id);if(app.status==='running')break;await delay(250);}
    evidence.orchestratorState=app.status;assert.equal(app.status,'running');
    evidence.passwordlessUser=viewer.name;
    run.evidence=evidence;
    if(process.argv.includes('--video-only')){
      evidence.uiWorkflow='fresh browser -> passwordless gateway -> decoded video';
      evidence.inputVerification='not performed (--video-only); Windows may be locked';
      fs.writeFileSync(output+'/passwordless-results.json',JSON.stringify(evidence,null,2));
      console.log(JSON.stringify({width:evidence.width,height:evidence.height,frames:evidence.frames,passwordlessUser:viewer.name}));
      return;
    }
    // Letterboxing can move these samples into the next checkerboard row.
    // Check both tile colors without assuming which sample is the lighter tile.
    const samples=[evidence.sample1,evidence.sample2].sort((a,b)=>a[2]-b[2]);
    const expected=[[15,23,42],[30,41,59]];
    assert.ok(samples.every((color,index)=>expected[index].every((channel,c)=>Math.abs(color[c]-channel)<10)) && samples[1][2]-samples[0][2]>10,'Decoded image is not the checkerboard; inspect the captured frame and Windows lock state before testing input');
    const videoRect=await page.locator('video').boundingBox();
    await page.mouse.move(videoRect.x+320,videoRect.y+260);await delay(500);
    const probe=()=>JSON.parse(require('node:child_process').execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/probe-example.ps1')],{encoding:'utf8',windowsHide:true}));
    const firstPosition=probe();
    await page.mouse.move(videoRect.x+880,videoRect.y+460);await delay(500);
    // A background-launched Windows application cannot always claim keyboard
    // focus. Clicking its visible fullscreen surface is the user activation.
    await page.mouse.click(videoRect.x+880,videoRect.y+460);await delay(200);
    const secondPosition=probe();
    evidence.mouseMovement={before:firstPosition.cursor,after:secondPosition.cursor};
    console.log('Input probes:',JSON.stringify({before:firstPosition,after:secondPosition}));
    assert.notDeepEqual(firstPosition.cursor,secondPosition.cursor,'Mouse input did not reach Windows');
    evidence.foregroundIsExample=secondPosition.foregroundIsExample;
    assert.equal(secondPosition.responding,true,'Example window is unresponsive');
    console.log('Foreground is example:',evidence.foregroundIsExample);
    assert.equal(evidence.foregroundIsExample,true,'Refusing keyboard test when example is not foreground');
    await page.keyboard.press('Escape');
    let stopped=false;for(let i=0;i<50;i++){app=await api('/apps/'+app.id);if(app.status==='stopped'){stopped=true;break;}await delay(250);}
    evidence.keyboardEscapeStoppedApp=stopped;
    evidence.uiWorkflow=(process.argv.includes('--direct')?'fresh browser direct URL':'management login -> launch popup')+' -> passwordless gateway -> decoded video -> mouse movement -> Escape exit';
    fs.writeFileSync(output+'/live-results.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({width:evidence.width,height:evidence.height,frames:evidence.frames,state:evidence.orchestratorState,keyboardEscapeStoppedApp:stopped,mouseMovement:evidence.mouseMovement}));
    assert.equal(stopped,true,'Remote Escape did not stop the example');
  }finally{
    fs.writeFileSync(output+'/browser.log',logs.join('\n'));
    await page.screenshot({path:output+'/last-screen.png'}).catch(()=>{});
    await browser.close();
    const current=await api('/apps/'+app.id);
    if(current.status==='running')await api('/apps/'+app.id+'/stop',{method:'POST'});
  }
}
main().then(()=>{run.status='passed';}).catch(e=>{run.status='failed';run.error=e.message;console.error(e);process.exitCode=1;}).finally(()=>{run.finishedAt=new Date().toISOString();saveRun();});
