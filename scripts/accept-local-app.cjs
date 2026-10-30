// Real control process + production browser, with an isolated encoder API fixture.
// Validates persisted capture configuration, not native media delivery. No renderer is launched.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{setTimeout:delay}=require('node:timers/promises'),{createRequire}=require('node:module');
const http=require('node:http');
const root=path.resolve(__dirname,'..');
const binary=path.resolve(process.argv[2]||'.local/validation/orchestrator-local.exe');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const output=path.join(root,'artifacts/local-app',stamp);fs.mkdirSync(output,{recursive:true});
const scratch=fs.mkdtempSync(path.join(root,'.local/local-app-'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function main(){
 const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 const origin=`http://127.0.0.1:${port}`,credentials={username:'admin',password:crypto.randomBytes(32).toString('base64url')};
 let encoderApps=[],legacyEncoder=false;const encoderWrites=[];
 const encoder=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');res.setHeader('Content-Type','application/json');
  if(url.pathname==='/api/stream-kit/capabilities'){
   if(legacyEncoder){res.writeHead(404);return res.end('{}');}
   return res.end(JSON.stringify({schema_version:1,capture_modes:['desktop','application'],capture_mode_apply:'application_restart'}));
  }
  if(url.pathname==='/api/csrf-token')return res.end(JSON.stringify({csrf_token:'isolated-test'}));
  if(url.pathname==='/api/configLocale')return res.end('{}');
  if(url.pathname==='/serverinfo')return res.end('<root status_code="200"><currentgame>0</currentgame><state>SUNSHINE_SERVER_FREE</state></root>');
  if(url.pathname==='/api/apps'&&req.method==='GET')return res.end(JSON.stringify({apps:encoderApps}));
  if(url.pathname==='/api/apps'&&req.method==='POST'){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));encoderWrites.push(body);
   if(body.index===-1)encoderApps.push(body);else encoderApps[body.index]=body;
   return res.end('{}');
  }
  if(/^\/api\/apps\/\d+$/.test(url.pathname)&&req.method==='DELETE'){encoderApps.splice(Number(url.pathname.split('/').pop()),1);return res.end('{}');}
  res.writeHead(404);res.end('{}');
 });
 await new Promise(resolve=>encoder.listen(0,'127.0.0.1',resolve));const encoderOrigin=`http://127.0.0.1:${encoder.address().port}`;
 const config={server:{bind_address:`127.0.0.1:${port}`,...credentials,jwt_secret:crypto.randomBytes(32).toString('hex')},components:{},sunshine_api:{base_url:''},moonlight_web:{base_url:''},storage:{apps_dir:'apps',temp_dir:'temp',db_path:'control.db',max_upload_size_bytes:10485760,max_extract_size_bytes:10485760,max_file_count:1000},process:{monitor_interval_seconds:2,graceful_shutdown_timeout_seconds:2},log:{level:'info',file:{enabled:false},access_log:{enabled:false}}};
 config.sunshine_api={base_url:encoderOrigin,server_info_url:encoderOrigin+'/serverinfo'};
 const configFile=path.join(scratch,'config.json');fs.writeFileSync(configFile,JSON.stringify(config));fs.cpSync(path.join(root,'orchestrator/web/dist'),path.join(scratch,'dist'),{recursive:true});
 const originalDirectory=path.join(scratch,'Original program');fs.mkdirSync(originalDirectory);
 const executable=path.join(originalDirectory,'Example app.exe');fs.copyFileSync(path.join(root,'artifacts/example/checkerboard.exe'),executable);
 const originalHash=hash(executable);fs.writeFileSync(path.join(originalDirectory,'user-data.txt'),'keep original data');
 let processOwner,browser;const errors=[];
 async function start(){
  const log=fs.openSync(path.join(output,'control.log'),'a');const child=spawn(binary,['--config',configFile],{cwd:scratch,windowsHide:true,stdio:['ignore',log,log]});fs.closeSync(log);const exited=once(child,'exit');processOwner={child,exited};
  for(let i=0;i<100;i++){assert.equal(child.exitCode,null,'Control process exited');try{if((await fetch(origin+'/api/v1/health')).ok)return;}catch{}await delay(100)}throw Error('Control process did not become ready');
 }
 async function stop(){if(processOwner){if(processOwner.child.exitCode===null)processOwner.child.kill();await processOwner.exited;processOwner=null;}}
 try{
  await start();assert.equal((await fetch(origin+'/api/v1/apps/local',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const {chromium}=createRequire(path.join(root,'third_party/moonlight-web-stream/package.json'))('playwright');browser=await chromium.launch({headless:true,channel:'chrome'});
  const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/login');await page.getByLabel('用户名').fill(credentials.username);await page.getByLabel('密码',{exact:true}).fill(credentials.password);await page.getByRole('button',{name:'登录控制台'}).click();
  await page.locator('nav a[href="/upload"]').click();await page.getByRole('button',{name:'本机已有程序',exact:true}).click();
  await page.getByLabel('应用名称',{exact:true}).fill('本机 Example 验证');await page.getByLabel('程序绝对路径',{exact:true}).fill(executable);
  await page.getByLabel('画面与声音范围',{exact:true}).selectOption('application');
  for(const width of [1440,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(output,`local-form-${width}.png`),fullPage:true});}
  const savedResponse=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/apps/local');await page.getByRole('button',{name:'注册本机程序',exact:true}).click();const response=await savedResponse;assert.equal(response.status(),200);const record=(await response.json()).data;
  assert.equal(record.source,'local');assert.equal(record.exe_path,executable);assert.equal(record.working_dir,originalDirectory);assert.notEqual(record.app_dir,originalDirectory);
  assert.equal(record.capture_mode,'application');assert.equal(encoderWrites.at(-1)['capture-mode'],'application');assert.equal(encoderWrites.at(-1)['auto-detach'],false);assert.equal(encoderWrites.at(-1)['wait-all'],true);
  assert.equal(path.relative(path.join(scratch,'apps'),record.app_dir),record.id);await page.getByText('本机程序（外部管理文件）',{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(output,'local-detail-narrow.png'),fullPage:true});
  const token=await page.evaluate(()=>localStorage.getItem('auth_token'));
  await page.getByLabel('画面与声音范围',{exact:true}).selectOption('desktop');
  const changed=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname===`/api/v1/apps/${record.id}`);
  await page.getByRole('button',{name:'保存',exact:true}).click();assert.equal((await changed).status(),200);assert.equal(encoderWrites.at(-1)['capture-mode'],'desktop');
  const rejected=await fetch(origin+'/api/v1/apps/local',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({name:'malformed',exe_path:executable,app_dir:originalDirectory})});assert.equal(rejected.status,400);
  await stop();await start();await page.reload();await page.getByText('本机程序（外部管理文件）',{exact:true}).waitFor();
  const persisted=await fetch(origin+`/api/v1/apps/${record.id}`,{headers:{Authorization:`Bearer ${token}`}});assert.equal(persisted.status,200);const saved=(await persisted.json()).data;assert.equal(saved.exe_path,executable);assert.equal(saved.capture_mode,'desktop');
  legacyEncoder=true;const writesBefore=encoderWrites.length;
  const unsupported=await fetch(origin+`/api/v1/apps/${record.id}`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({capture_mode:'application'})});assert.equal(unsupported.status,400);assert.equal(encoderWrites.length,writesBefore);
  await page.reload();await page.getByLabel('画面与声音范围',{exact:true}).waitFor();await page.getByText('当前编码器版本或服务器平台尚未提供指定程序采集。',{exact:true}).waitFor();assert.equal(await page.locator('#capture-mode option[value="application"]').isDisabled(),true);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'移除平台注册',exact:true}).click();await page.waitForURL(origin+'/apps');
  assert.equal(hash(executable),originalHash);assert.equal(fs.readFileSync(path.join(originalDirectory,'user-data.txt'),'utf8'),'keep original data');assert.equal(fs.existsSync(record.app_dir),false);assert.deepEqual(errors,[]);
  const result={passed:true,scope:'Real authenticated browser and control process; encoder metadata API is a test fixture. Registration, capture scope update/restart persistence, legacy encoder rejection and removal verified. No renderer launched and no media-delivery claim.',browser:browser.version(),control_sha256:hash(binary),original_sha256:originalHash,checks:['anonymous denied','absolute path with spaces','owned metadata directory','strict request fields','narrow layout','application capture projection','capture scope update','durable restart','legacy encoder fails closed','delete preserves original files'],finished_at:new Date().toISOString()};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,output}));
 }finally{if(browser)await browser.close();await stop();await new Promise(resolve=>encoder.close(resolve));}
}
main().catch(error=>{fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:error.message}));console.error(error);process.exitCode=1;});
