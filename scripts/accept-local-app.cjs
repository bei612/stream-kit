// Real control process + production browser. The registered example is never launched.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{setTimeout:delay}=require('node:timers/promises'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..');
const binary=path.resolve(process.argv[2]||'.local/validation/orchestrator-local.exe');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const output=path.join(root,'artifacts/local-app',stamp);fs.mkdirSync(output,{recursive:true});
const scratch=fs.mkdtempSync(path.join(root,'.local/local-app-'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function main(){
 const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 const origin=`http://127.0.0.1:${port}`,credentials={username:'admin',password:crypto.randomBytes(32).toString('base64url')};
 const config={server:{bind_address:`127.0.0.1:${port}`,...credentials,jwt_secret:crypto.randomBytes(32).toString('hex')},components:{},sunshine_api:{base_url:''},moonlight_web:{base_url:''},storage:{apps_dir:'apps',temp_dir:'temp',db_path:'control.db',max_upload_size_bytes:10485760,max_extract_size_bytes:10485760,max_file_count:1000},process:{monitor_interval_seconds:2,graceful_shutdown_timeout_seconds:2},log:{level:'info',file:{enabled:false},access_log:{enabled:false}}};
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
  for(const width of [1440,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(output,`local-form-${width}.png`),fullPage:true});}
  const savedResponse=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/apps/local');await page.getByRole('button',{name:'注册本机程序',exact:true}).click();const response=await savedResponse;assert.equal(response.status(),200);const record=(await response.json()).data;
  assert.equal(record.source,'local');assert.equal(record.exe_path,executable);assert.equal(record.working_dir,originalDirectory);assert.notEqual(record.app_dir,originalDirectory);
  assert.equal(path.relative(path.join(scratch,'apps'),record.app_dir),record.id);await page.getByText('本机程序（外部管理文件）',{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(output,'local-detail-narrow.png'),fullPage:true});
  const token=await page.evaluate(()=>localStorage.getItem('auth_token'));
  const rejected=await fetch(origin+'/api/v1/apps/local',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({name:'malformed',exe_path:executable,app_dir:originalDirectory})});assert.equal(rejected.status,400);
  await stop();await start();await page.reload();await page.getByText('本机程序（外部管理文件）',{exact:true}).waitFor();
  const persisted=await fetch(origin+`/api/v1/apps/${record.id}`,{headers:{Authorization:`Bearer ${token}`}});assert.equal(persisted.status,200);assert.equal((await persisted.json()).data.exe_path,executable);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'移除平台注册',exact:true}).click();await page.waitForURL(origin+'/apps');
  assert.equal(hash(executable),originalHash);assert.equal(fs.readFileSync(path.join(originalDirectory,'user-data.txt'),'utf8'),'keep original data');assert.equal(fs.existsSync(record.app_dir),false);assert.deepEqual(errors,[]);
  const result={passed:true,scope:'Real authenticated browser registration, durable process restart and removal; referenced example and user data preserved. No rendering app started.',browser:browser.version(),control_sha256:hash(binary),original_sha256:originalHash,checks:['anonymous denied','absolute path with spaces','owned metadata directory','strict request fields','narrow layout','durable restart','delete preserves original files'],finished_at:new Date().toISOString()};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,output}));
 }finally{if(browser)await browser.close();await stop();}
}
main().catch(error=>{fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:error.message}));console.error(error);process.exitCode=1;});
