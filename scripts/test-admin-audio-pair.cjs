// Production management assets, controlled API only. Opens no audio devices.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {launchBrowser,engine}=require('./lib/test-browser.cjs');
(async()=>{
 const root=path.resolve('orchestrator/web/dist'),browser=await launchBrowser();
 const errors=[],writes=[]; let finish;
 const result={passed:false,scope:'Production UI with simulated signed-backend outcome; no native devices, recording or target-program acceptance',engine};
 const out=path.resolve('artifacts/audio-pair-ui',engine);fs.mkdirSync(out,{recursive:true});
 try {
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('auth_token','test.'+btoa(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600}))+'.test'));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.hostname!=='admin.test')return route.abort();
   if(url.pathname.endsWith('/audio-devices/check-pair')){
    writes.push(route.request().postDataJSON());
    const data=await new Promise(resolve=>{finish=resolve});
    return route.fulfill(data);
   }
   if(url.pathname.endsWith('/audio-devices'))return route.fulfill({json:{status:'ok',data:{schema_version:1,observed_at_ms:Date.now(),configured_routes:[],devices:[{id:'out',name:'Test output',output:true,input:false},{id:'in',name:'Test input',output:false,input:true}]}}});
   if(url.pathname.startsWith('/api/'))return route.fulfill({status:503,json:{status:'error',message:'测试中未连接此服务'}});
   const file=url.pathname.startsWith('/assets/')?path.resolve(root,'.'+url.pathname):path.join(root,'index.html');if(!file.startsWith(root+path.sep))return route.abort();
   return route.fulfill({path:file,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('http://admin.test/settings');
  await page.getByRole('button',{name:'读取设备',exact:true}).click();
  const button=page.getByRole('button',{name:'播放测试音并检查',exact:true});await button.waitFor();
  assert.equal(writes.length,0);assert.ok(await button.isDisabled());
  await page.getByLabel('测试音输出',{exact:true}).selectOption('out');await page.getByLabel('配对录音输入',{exact:true}).selectOption('in');
  await button.click();await page.waitForFunction(()=>document.querySelector('#pair-check-input')?.matches(':disabled'));
  assert.equal(writes.length,1);assert.deepEqual(writes[0],{render_device_id:'out',capture_device_id:'in'});
  finish({json:{status:'ok',data:{passed:true,captured_frames:144000,tone_amplitude:0.1,submitted_packets:150,closed_after_drop:true,baseline:{quiet:true,rms:0,peak:0},after_clear:{quiet:true,rms:0,peak:0}}}});
  await page.getByRole('status').filter({hasText:'本次端点配对检查通过'}).waitFor();
  await page.getByLabel('配对录音输入',{exact:true}).selectOption('');assert.equal(await page.getByRole('status').filter({hasText:'本次端点配对检查通过'}).count(),0);
  await page.getByLabel('配对录音输入',{exact:true}).selectOption('in');await button.click();await page.waitForFunction(()=>document.querySelector('#pair-check-input')?.matches(':disabled'));
  finish({status:503,json:{status:'error',message:'设备正在使用'}});await page.getByRole('alert').filter({hasText:'设备正在使用'}).waitFor();
  assert.equal(writes.length,2);assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.locator('#pair-check-output').scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,'mobile.png')});
  result.passed=true;result.requests=writes.length;result.browser_errors=errors;
 } finally {fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
