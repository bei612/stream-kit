// Production management UI with controlled API responses; no service is restarted.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const {chromium}=createRequire(path.resolve('third_party/moonlight-web-stream/package.json'))('playwright');
(async()=>{
  const root=path.resolve('orchestrator/web/dist');
  const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});
  const revision='"'+'a'.repeat(64)+'"';
  let failure=true,readFailure=false;const writes=[],errors=[];
  try {
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>localStorage.setItem('auth_token','test.'+btoa(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600}))+'.test'));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.hostname!=='admin.test')return route.abort();
      if(url.pathname.startsWith('/api/')) {
        if(url.pathname.endsWith('/encoder-configuration')) {
          if(route.request().method()==='PATCH') {
            writes.push(route.request().postDataJSON());
            return route.fulfill({status:failure?409:200,json:failure?{status:'error',message:'配置已变化，请重新读取'}:{status:'ok',data:{revision:'"'+'b'.repeat(64)+'"',apply_policy:'encoder_restart',runtime_verified:false}}});
          }
          return route.fulfill({status:readFailure?503:200,json:readFailure?{status:'error',message:'编码器读取失败'}:{status:'ok',data:{revision,apply_policy:'encoder_restart',runtime_verified:false,values:{sunshine_name:'Renderer',pkey:null},redacted_keys:['pkey']}}});
        }
        return route.fulfill({status:503,json:{status:'error',message:'测试中未连接此服务'}});
      }
      const file=url.pathname.startsWith('/assets/')?path.resolve(root,'.'+url.pathname):path.join(root,'index.html');
      if(!file.startsWith(root+path.sep))return route.abort();
      return route.fulfill({path:file,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
    });
    await page.goto('http://admin.test/settings');
    const name=page.locator('#encoder-setting-sunshine_name');
    await name.waitFor();
    assert.equal(await page.locator('#encoder-setting-pkey').inputValue(),'');
    const save=page.getByRole('button',{name:'保存编码器配置',exact:true});
    await name.fill('Draft');await save.click();
    await page.getByRole('alert').filter({hasText:'配置已变化，请重新读取'}).waitFor();
    assert.equal(await name.inputValue(),'Draft');assert.equal(await save.isDisabled(),true);
    assert.deepEqual(writes[0],{revision,changes:{sunshine_name:'Draft'}});
    await page.getByRole('button',{name:'放弃编码器修改并重新读取',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#encoder-setting-sunshine_name')?.value==='Renderer');
    failure=false;
    await page.getByRole('combobox',{name:'pkey 编辑方式',exact:true}).selectOption('reset');
    await save.click();
    await page.getByRole('status').filter({hasText:'配置已保存'}).waitFor();
    assert.deepEqual(writes[1],{revision,changes:{pkey:null}});
    assert.equal(await save.isDisabled(),true);
    readFailure=true;
    await page.getByRole('button',{name:'重新读取编码器配置',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'编码器读取失败'}).waitFor();
    assert.equal(await name.isDisabled(),true);
    assert.deepEqual(errors,[]);
    const out=path.resolve('artifacts/encoder-configuration');fs.mkdirSync(out,{recursive:true});
    await page.screenshot({path:path.join(out,'admin-configuration.png'),fullPage:true});
    fs.writeFileSync(path.join(out,'admin-browser-result.json'),JSON.stringify({passed:true,patches:writes.length,cases:['preserve-hidden','conflict-preserves-draft','explicit-reset','save-not-runtime','read-failure-locks-editor'],errors},null,2));
    console.log('Admin encoder configuration browser checks passed');
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
