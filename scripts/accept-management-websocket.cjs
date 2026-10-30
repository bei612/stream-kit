// Actual Windows/Linux control process + production management UI. Isolated
// configuration and database; no media services or application processes.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {setTimeout:delay}=require('node:timers/promises');
const {createRequire}=require('node:module');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
assert.ok(process.argv[2],'Pass a newly built Orchestrator executable');
const binary=path.resolve(process.argv[2]);
const output=path.join(root,'artifacts/management-websocket',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const scratch=fs.mkdtempSync(path.join(root,'.local/ws-acceptance-'));
const result={passed:false,scope:'Real isolated control process and production browser UI; authentication, events, process restart, logout. No media acceptance.'};
let owned,browser;
async function stop(){if(owned){if(owned.child.exitCode===null)owned.child.kill();await owned.exited;owned=null}}
function launch(config,name){const log=fs.openSync(path.join(output,name+'.log'),'w');const child=spawn(binary,['--config',config],{cwd:scratch,windowsHide:true,stdio:['ignore',log,log]});fs.closeSync(log);owned={child,exited:once(child,'exit')};}
async function main(){
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const credentials={username:'admin',password:crypto.randomBytes(32).toString('base64url')};
  const config={server:{bind_address:`127.0.0.1:${port}`,...credentials,jwt_secret:crypto.randomBytes(32).toString('hex')},components:{},sunshine_api:{base_url:''},moonlight_web:{base_url:''},
    storage:{apps_dir:'apps',temp_dir:'temp',db_path:'control.db',max_upload_size_bytes:10485760},process:{monitor_interval_seconds:2,graceful_shutdown_timeout_seconds:2},log:{level:'info',file:{enabled:false},access_log:{enabled:false}}};
  const configFile=path.join(scratch,'config.json');fs.writeFileSync(configFile,JSON.stringify(config));
  fs.cpSync(path.join(root,'orchestrator/web/dist'),path.join(scratch,'dist'),{recursive:true});
  async function ready(){for(let i=0;i<100;i++){assert.equal(owned.child.exitCode,null);try{if((await fetch(origin+'/api/v1/health')).ok)return}catch{}await delay(100)}throw new Error('Control process did not become ready')}
  launch(configFile,'initial');await ready();
  const {chromium}=createRequire(path.join(root,'third_party/moonlight-web-stream/package.json'))('playwright');
  browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});
  const page=await browser.newPage();const errors=[],socketURLs=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('websocket',socket=>socketURLs.push(socket.url()));
  await page.addInitScript(()=>{
    window.__wsEvents=[];window.__wsInstances=[];
    window.addEventListener('ws-event',e=>window.__wsEvents.push(e.detail.type));
    const Original=window.WebSocket;
    window.WebSocket=class extends Original{constructor(...args){super(...args);window.__wsInstances.push(this)}};
  });
  await page.goto(origin+'/login');await page.getByLabel('用户名').fill(credentials.username);await page.getByLabel('密码',{exact:true}).fill(credentials.password);
  await page.getByRole('button',{name:'登录控制台'}).click();
  await page.locator('.connection-indicator[data-connected="true"]').waitFor();
  const state=()=>page.evaluate(()=>window.__wsInstances.map(socket=>({url:socket.url,protocol:socket.protocol,state:socket.readyState})));
  assert.equal((await state()).filter(socket=>socket.state===1).length,1);
  assert.equal((await state()).at(-1).protocol,'stream-kit.events.v1');
  const token=await page.evaluate(()=>localStorage.getItem('auth_token'));
  const api=async app=>{const response=await fetch(origin+'/api/v1/stream-sessions',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({host_id:1,app_id:app})});assert.equal(response.status,200)};
  await api(1);await page.waitForFunction(()=>window.__wsEvents.includes('stream_session_created'));
  const received=await page.evaluate(()=>window.__wsEvents.length);
  const before=await page.evaluate(()=>window.__wsInstances.length);
  await stop();launch(configFile,'restarted');await ready();
  await page.waitForFunction(count=>window.__wsInstances.length>count&&window.__wsInstances.at(-1).readyState===1,before,{timeout:15000});
  await api(2);await page.waitForFunction(count=>window.__wsEvents.length>count,received);
  await page.locator('nav a[href="/settings"]').click();await page.getByRole('button',{name:'退出登录'}).click();await page.waitForURL(origin+'/login');
  await page.waitForFunction(()=>window.__wsInstances.every(socket=>socket.readyState===3));
  const afterLogout=await page.evaluate(()=>window.__wsInstances.length);await delay(1500);
  assert.equal(await page.evaluate(()=>window.__wsInstances.length),afterLogout,'Logout restarted a connection');
  assert.ok(socketURLs.every(url=>new URL(url).search===''),'Credential appeared in WebSocket URL');
  assert.deepEqual(errors,[]);
  result.passed=true;result.browser=browser.version();result.checks=['single active socket','version-only negotiated protocol','no URL credentials','real session events','process restart and event delivery','logout releases sockets without retry'];
  result.binary_sha256=crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  result.web_assets_sha256=Object.fromEntries(fs.readdirSync(path.join(scratch,'dist/assets')).map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(scratch,'dist/assets',name))).digest('hex')]));
}
main().catch(error=>{result.error=error.message;process.exitCode=1}).finally(async()=>{if(browser)await browser.close();await stop();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,output}));});
