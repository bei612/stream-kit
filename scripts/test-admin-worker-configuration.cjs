// Built management page; API writes are captured, no installed service changes.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {launchBrowser,engine,evidenceDirectory}=require('./lib/test-browser.cjs');
(async()=>{
  const root=path.resolve('orchestrator/web/dist'),browser=await launchBrowser();
  const writes=[],errors=[];
  let revision='initial',restart=false;
  const values={components:{sunshine:{exe_path:'renderer.exe',windows_session_id:0,windows_user_sid:''},web_server:{exe_path:'web-server.exe',windows_session_id:0,windows_user_sid:''},gateway:{windows_session_id:0,windows_user_sid:''}}};
  try {
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>localStorage.setItem('auth_token','test.'+btoa(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')+'.test'));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.hostname!=='admin.test')return route.abort();
      if(url.pathname.startsWith('/api/')){
        if(url.pathname.endsWith('/configuration')){
          if(route.request().method()==='PATCH'){
            const body=route.request().postDataJSON();writes.push(body);
            assert.equal(body.revision,revision);
            for(const component of ['sunshine','web_server'])for(const field of ['windows_session_id','windows_user_sid']) {
              const pointer=`/components/${component}/${field}`;
              if(Object.hasOwn(body.changes,pointer))values.components[component][field]=body.changes[pointer];
            }
            revision='revision-'+writes.length;restart=true;
          }
          return route.fulfill({json:{status:'ok',data:{revision,restart_required:restart,apply_policy:'service_restart',values,redacted_paths:[],environment_overrides:[]}}});
        }
        assert.equal(route.request().method(),'GET','configuration editing must not restart a service');
        return route.fulfill({status:503,json:{status:'error',message:'测试未连接此服务'}});
      }
      const file=url.pathname.startsWith('/assets/')?path.resolve(root,'.'+url.pathname):path.join(root,'index.html');
      if(!file.startsWith(root+path.sep))return route.abort();
      return route.fulfill({path:file,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
    });
    await page.goto('http://admin.test/settings');
    await page.locator('summary').filter({hasText:'服务组件'}).click();
    const session=page.locator('[id="setting/components/sunshine/windows_session_id"]');
    const sid=page.locator('[id="setting/components/sunshine/windows_user_sid"]');
    await session.fill('3');await sid.fill('S-1-5-21-1-2-3-1001');
    const gatewaySession=page.locator('[id="setting/components/web_server/windows_session_id"]');
    const gatewaySID=page.locator('[id="setting/components/web_server/windows_user_sid"]');
    await gatewaySession.fill('3');await gatewaySID.fill('S-1-5-21-1-2-3-1001');
    assert.equal(await page.locator('[id="setting/components/gateway/windows_session_id"]').count(),0);
    await page.getByRole('button',{name:/^保存配置/}).click();
    await page.getByRole('status').filter({hasText:'存在待生效配置'}).waitFor();
    assert.deepEqual(writes[0],{revision:'initial',changes:{'/components/sunshine/windows_session_id':3,'/components/sunshine/windows_user_sid':'S-1-5-21-1-2-3-1001','/components/web_server/windows_session_id':3,'/components/web_server/windows_user_sid':'S-1-5-21-1-2-3-1001'}});
    await session.fill('0');await sid.fill('');
    await gatewaySession.fill('0');await gatewaySID.fill('');
    await page.getByRole('button',{name:/^保存配置/}).click();
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='保存配置'&&button.disabled));
    assert.deepEqual(writes[1],{revision:'revision-1',changes:{'/components/sunshine/windows_session_id':0,'/components/sunshine/windows_user_sid':'','/components/web_server/windows_session_id':0,'/components/web_server/windows_user_sid':''}});
    assert.deepEqual(errors,[]);
    const output=evidenceDirectory('artifacts/admin-worker-configuration');fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,engine,writes,scope:'Built settings UI with mocked API; no SCM or cross-session acceptance'},null,2));
    console.log('Worker session configuration UI passed: '+engine);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
