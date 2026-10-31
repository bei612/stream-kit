// Exercise an immutable control bundle with external configuration and real HTTP/UI.
// No encoder, gateway, installed service, audio device or physical input is started.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const {once}=require('node:events');
const {setTimeout:delay}=require('node:timers/promises');
const {launchBrowser,engine}=require('./lib/test-browser.cjs');
const root=path.resolve(__dirname,'..');
const bundle=path.resolve(process.argv[2]||'');
const binary=path.join(bundle,process.platform==='win32'?'orchestrator.exe':'orchestrator');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');

async function main(){
  assert.ok(process.argv[2],'Pass a verified native control bundle directory');
  execFileSync(binary,['verify-bundle',bundle],{stdio:'inherit',windowsHide:true});
  const manifest=JSON.parse(fs.readFileSync(path.join(bundle,'bundle-manifest.json'),'utf8'));
  const output=path.join(root,'artifacts/control-bundle',new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(output,{recursive:true});
  const scratch=fs.mkdtempSync(path.join(root,'.local/control-bundle-'));
  const reservation=net.createServer();
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const credentials={username:'admin',password:crypto.randomBytes(32).toString('base64url')};
  const config={
    server:{bind_address:`127.0.0.1:${port}`,...credentials,jwt_secret:crypto.randomBytes(32).toString('hex')},
    components:Object.fromEntries(['sunshine','web_server'].map(name=>[name,{exe_path:binary,auto_start:false}])),
    sunshine_api:{base_url:''},moonlight_web:{base_url:''},
    storage:{apps_dir:'apps',temp_dir:'temp',db_path:'control.db',max_upload_size_bytes:1048576,max_extract_size_bytes:1048576,max_file_count:100},
    process:{monitor_interval_seconds:2,graceful_shutdown_timeout_seconds:2},
    log:{level:'warning',file:{enabled:false},access_log:{enabled:false}},
  };
  const configFile=path.join(scratch,'config.json');
  fs.writeFileSync(configFile,JSON.stringify(config));
  let child,exited,browser;
  async function stop(){
    if(!child)return;
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    await Promise.race([exited,delay(10000,undefined,{ref:false}).then(()=>{throw Error('Owned control process did not exit')})]);
    child=null;
  }
  async function start(){
    const log=fs.openSync(path.join(output,'control.log'),'a');
    child=spawn(binary,['--config',configFile],{cwd:scratch,windowsHide:true,stdio:['ignore',log,log]});
    fs.closeSync(log);exited=once(child,'exit');
    for(let attempt=0;attempt<100;attempt++){
      assert.equal(child.exitCode,null,'Control process exited before readiness');
      let response;
      try{response=await fetch(origin+'/api/v1/health',{signal:AbortSignal.timeout(1000)});}catch{}
      if(response?.ok){
        const health=(await response.json()).data;
        for(const name of ['sunshine','web_server'])assert.equal(health.components[name].pid,0,'Acceptance must not launch managed media components');
        return;
      }
      await delay(100);
    }
    throw Error('Control bundle did not become ready');
  }
  const errors=[];
  try{
    await start();
    assert.equal((await fetch(origin+'/api/v1/configuration')).status,401);
    const pageBytes=Buffer.from(await(await fetch(origin+'/settings')).arrayBuffer());
    assert.equal(hash(pageBytes),hash(fs.readFileSync(path.join(bundle,'dist/index.html'))),'Page must come from executable sibling dist');
    browser=await launchBrowser();
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/settings');
    await page.getByLabel('用户名').fill(credentials.username);
    await page.getByLabel('密码',{exact:true}).fill(credentials.password);
    await page.getByRole('button',{name:'登录控制台'}).click();
    await page.waitForFunction(()=>Boolean(localStorage.getItem('auth_token')));
    await page.goto(origin+'/settings');
    await page.locator('summary').filter({hasText:'服务组件'}).click();
    const token=await page.evaluate(()=>localStorage.getItem('auth_token'));
    const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
    const read=async()=>{const response=await fetch(origin+'/api/v1/configuration',{headers});assert.equal(response.status,200);return(await response.json()).data};
    const initial=await read();
    const initialBytes=fs.readFileSync(configFile);
    const incomplete=await fetch(origin+'/api/v1/configuration',{method:'PATCH',headers,body:JSON.stringify({revision:initial.revision,changes:{'/components/web_server/windows_session_id':3}})});
    assert.equal(incomplete.status,400);
    assert.deepEqual(fs.readFileSync(configFile),initialBytes,'Rejected partial selection must not change disk');
    for(const name of ['sunshine','web_server']){
      await page.locator(`[id="setting/components/${name}/windows_session_id"]`).fill('3');
      await page.locator(`[id="setting/components/${name}/windows_user_sid"]`).fill('S-1-5-21-1-2-3-1001');
    }
    await page.getByRole('button',{name:/^保存配置/}).click();
    await page.getByRole('status').filter({hasText:'存在待生效配置'}).waitFor();
    const saved=await read();assert.equal(saved.restart_required,true);assert.equal(saved.apply_policy,'service_restart');
    const persisted=JSON.parse(fs.readFileSync(configFile,'utf8'));
    for(const name of ['sunshine','web_server']){
      assert.equal(persisted.components[name].windows_session_id,3);
      assert.equal(persisted.components[name].windows_user_sid,'S-1-5-21-1-2-3-1001');
    }
    const stale=await fetch(origin+'/api/v1/configuration',{method:'PATCH',headers,body:JSON.stringify({revision:initial.revision,changes:{'/components/web_server/windows_session_id':0,'/components/web_server/windows_user_sid':''}})});
    assert.equal(stale.status,409);
    for(const name of ['sunshine','web_server']){
      await page.locator(`[id="setting/components/${name}/windows_session_id"]`).fill('0');
      await page.locator(`[id="setting/components/${name}/windows_user_sid"]`).fill('');
    }
    await page.getByRole('button',{name:/^保存配置/}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='保存配置'&&button.disabled));
    await stop();await start();
    const restarted=await read();assert.equal(restarted.restart_required,false);
    assert.equal(restarted.values.components.web_server.windows_session_id,0);
    assert.deepEqual(errors,[]);
    execFileSync(binary,['verify-bundle',bundle],{stdio:'inherit',windowsHide:true});
  }finally{try{if(browser)await browser.close();}finally{await stop();}}
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,commit:manifest.commit,engine,browser:browser.version(),scope:'Native immutable control bundle, sibling assets, real administrator login, atomic user-session configuration, stale update rejection and isolated control-process restart. No SCM, audio devices, encoder/gateway launch or media acceptance.',errors},null,2));
  console.log('Control bundle runtime acceptance passed: '+output);
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
