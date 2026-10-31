// Production management UI with controlled API responses; no service is restarted.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {engine,launchBrowser,evidenceDirectory}=require('./lib/test-browser.cjs');
(async()=>{
  const root=path.resolve('orchestrator/web/dist');
  const browser=await launchBrowser();
  const revision='"'+'a'.repeat(64)+'"';
  const networkField={key:'port',label:'Renderer base port',description:'Related listeners use fixed offsets; update gateway connections after restart.',type:'integer',minimum:1019,maximum:65514};
  let desiredRevision=revision,loadedRevision=revision,instance='c'.repeat(64),applyCalls=0;
  let failure=true,readFailure=false;const writes=[],errors=[];
  try {
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>localStorage.setItem('auth_token','test.'+btoa(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')+'.test'));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.hostname!=='admin.test')return route.abort();
      if(url.pathname.startsWith('/api/')) {
        if(url.pathname.endsWith('/components/sunshine'))return route.fulfill({json:{status:'ok',data:{pid:700}}});
        if(url.pathname.endsWith('/encoder-configuration/apply')) {
          assert.deepEqual(route.request().postDataJSON(),{revision:desiredRevision,instance_id:instance});
          applyCalls++;loadedRevision=desiredRevision;instance='e'.repeat(64);
          return route.fulfill({json:{status:'ok',data:{revision:desiredRevision,loaded_revision:loadedRevision,instance_id:instance,process_id:701,managed_instance_id:'f'.repeat(32),restart_required:false,overridden_keys:['sunshine_name']}}});
        }
        if(url.pathname.endsWith('/encoder-configuration')) {
          if(route.request().method()==='PATCH') {
            writes.push(route.request().postDataJSON());
            if(!failure)desiredRevision='"'+'b'.repeat(64)+'"';
            return route.fulfill({status:failure?409:200,json:failure?{status:'error',message:'配置已变化，请重新读取'}:{status:'ok',data:{revision:'"'+'b'.repeat(64)+'"',apply_policy:'encoder_restart',runtime_verified:false}}});
          }
          return route.fulfill({status:readFailure?503:200,json:readFailure?{status:'error',message:'编码器读取失败'}:{status:'ok',data:{revision:desiredRevision,loaded_revision:loadedRevision,instance_id:instance,process_id:700,managed_instance_id:'d'.repeat(32),restart_required:desiredRevision!==loadedRevision,overridden_keys:['sunshine_name'],apply_policy:'encoder_restart',runtime_verified:false,fields:[networkField,{key:'packetsize',label:'Packet size (0 or 200-65535)',type:'integer',minimum:0,maximum:65535},{key:'gamepad_driver',label:'Windows gamepad driver',type:'string',choices:['all','virtualhid','vigembus']},{key:'virtualhid_randomize_mac',label:'Randomize virtual gamepad MAC',type:'boolean'},{key:'min_threads',label:'CPU 编码最少线程数',type:'integer',minimum:1,maximum:2147483647},{key:'sw_preset',label:'软件编码预设',type:'string',choices:['ultrafast','superfast','veryslow']},{key:'sw_tune',label:'软件编码调优',type:'string',choices:['film','zerolatency']},{key:'nvenc_twopass',label:'NVIDIA multipass',type:'string',choices:['disabled','quarter_res','full_res']},{key:'minimum_fps_target',label:'Minimum FPS',type:'number',minimum:0,maximum:1000},{key:'ping_timeout',label:'心跳超时',type:'integer',minimum:-1,maximum:2147483647},{key:'min_log_level',label:'日志级别',type:'string',choices:['debug','info','warning']},{key:'sunshine_name',label:'渲染节点名称',type:'string'},{key:'stream_audio',label:'传输主机声音',type:'boolean'},{key:'max_bitrate',label:'最大码率',type:'integer',minimum:0,maximum:2147483647}],values:{sunshine_name:'Renderer',pkey:null},redacted_keys:['pkey']}}});
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
    await page.getByRole('status').filter({hasText:'当前进程启动时已读取此配置文件版本'}).waitFor();
    assert.equal(await page.locator('#encoder-setting-pkey').inputValue(),'');
    const save=page.getByRole('button',{name:'保存编码器配置',exact:true});
    await page.getByLabel('搜索编码器参数',{exact:true}).fill('fixed offsets');
    await page.getByRole('combobox',{name:'选择常用编码参数',exact:true}).selectOption('port');
    const port=page.locator('#encoder-setting-port');
    assert.equal(await port.getAttribute('min'),'1019');
    assert.equal(await port.getAttribute('max'),'65514');
    await page.getByText(networkField.description,{exact:true}).waitFor();
    await port.locator('..').getByRole('button',{name:'撤销此项修改',exact:true}).click();
    await page.getByLabel('搜索编码器参数',{exact:true}).fill('');
    await name.fill('Draft');
    const search=page.getByLabel('搜索编码器参数',{exact:true});
    await search.fill('pkey');
    assert.equal(await name.count(),0,'Filtering must hide unmatched settings');
    assert.equal(await page.locator('#encoder-setting-pkey').count(),1);
    await save.click();
    await search.fill('渲染节点');
    await page.getByRole('alert').filter({hasText:'配置已变化，请重新读取'}).waitFor();
    assert.equal(await name.inputValue(),'Draft');assert.equal(await save.isDisabled(),true);
    assert.deepEqual(writes[0],{revision,changes:{sunshine_name:'Draft'}});
    await search.fill('NVIDIA');
    assert.equal(await page.getByRole('combobox',{name:'选择常用编码参数',exact:true}).locator('option[value="nvenc_twopass"]').count(),1);
    assert.equal(await page.getByRole('combobox',{name:'选择常用编码参数',exact:true}).locator('option[value="stream_audio"]').count(),0);
    await search.fill('');
    await page.getByRole('button',{name:'放弃编码器修改并重新读取',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#encoder-setting-sunshine_name')?.value==='Renderer');
    failure=false;
    await page.getByRole('combobox',{name:'pkey 编辑方式',exact:true}).selectOption('reset');
    await save.click();
    await page.getByRole('status').filter({hasText:'配置已保存'}).waitFor();
    await page.getByRole('status').filter({hasText:'配置文件已变化，需重启编码器加载'}).waitFor();
    assert.deepEqual(writes[1],{revision,changes:{pkey:null}});
    assert.equal(await save.isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'重启编码器并加载配置',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'重新读取编码器配置',exact:true}).click();
    await page.getByRole('button',{name:'重启编码器并加载配置',exact:true}).click();
    await page.getByRole('status').filter({hasText:'编码器已重启，新实例已读取目标配置文件'}).waitFor();
    assert.equal(applyCalls,1);
    await page.getByRole('combobox',{name:'选择常用编码参数',exact:true}).selectOption('stream_audio');
    await page.locator('#encoder-setting-stream_audio').selectOption('true');
    await page.getByRole('combobox',{name:'选择常用编码参数',exact:true}).selectOption('max_bitrate');
    assert.equal(await page.locator('#encoder-setting-max_bitrate').getAttribute('type'),'number');
    const bitrate=page.locator('#encoder-setting-max_bitrate');
    assert.equal(await bitrate.getAttribute('max'),'2147483647');
    for(const invalid of ['-1','1.5','2147483648']) {
      await bitrate.fill(invalid);await save.click();
      await page.getByRole('alert').filter({hasText:'最大码率必须为'}).waitFor();
      assert.equal(writes.length,2,'Invalid numeric override must not reach the API');
      assert.equal(await save.isDisabled(),false,'Local error must allow correcting the draft');
      assert.equal(await bitrate.inputValue(),invalid);
    }
    await bitrate.fill('20000');
    await page.getByRole('combobox',{name:'选择常用编码参数',exact:true}).selectOption('ping_timeout');
    const timeout=page.locator('#encoder-setting-ping_timeout');
    assert.equal(await timeout.getAttribute('min'),'-1');
    await timeout.fill('-2');await save.click();
    await page.getByRole('alert').filter({hasText:'心跳超时必须为'}).waitFor();
    assert.equal(writes.length,2,'Out-of-range negative must not reach the API');
    await timeout.fill('-1');
    await page.locator('select').filter({has:page.locator('option[value=nvenc_twopass]')}).selectOption('nvenc_twopass');
    await page.locator('#encoder-setting-nvenc_twopass').selectOption('full_res');
    const fpsKey='minimum_fps_target';
    await page.locator('select').filter({has:page.locator('option[value="minimum_fps_target"]')}).selectOption(fpsKey);
    const fps=page.locator('#encoder-setting-minimum_fps_target');
    assert.equal(await fps.getAttribute('type'),'number');
    assert.equal(await fps.getAttribute('step'),'any');
    for(const invalid of ['-0.01','1000.01']) {
      await fps.fill(invalid);await save.click();
      await page.getByRole('alert').filter({hasText:'Minimum FPS'}).waitFor();
      assert.equal(writes.length,2,'Invalid decimal must not reach the API');
      assert.equal(await fps.inputValue(),invalid);
    }
    await fps.fill('59.94');
    await page.getByRole('combobox',{name:'选择常用编码参数',exact:true}).selectOption('min_log_level');
    await page.locator('#encoder-setting-min_log_level').selectOption('warning');
    await page.getByRole('combobox',{name:'选择常用编码参数',exact:true}).selectOption('min_threads');
    const threads=page.locator('#encoder-setting-min_threads');
    await threads.fill('0');await save.click();
    await page.getByRole('alert').filter({hasText:'CPU 编码最少线程数必须为'}).waitFor();
    assert.equal(writes.length,2,'Zero encoding threads must not reach the API');
    await threads.fill('4');
    for(const [key,value] of [['sw_preset','superfast'],['sw_tune','zerolatency']]) {
      await page.getByRole('combobox',{name:'选择常用编码参数',exact:true}).selectOption(key);
      await page.locator('#encoder-setting-'+key).selectOption(value);
    }
    await page.getByRole('combobox',{name:'选择常用编码参数',exact:true}).selectOption('packetsize');
    const packetSize=page.locator('#encoder-setting-packetsize');
    assert.equal(await packetSize.getAttribute('max'),'65535');
    await packetSize.fill('1200');
    for(const [key,value] of [['gamepad_driver','virtualhid'],['virtualhid_randomize_mac','false']]) {
      await page.getByRole('combobox',{name:'选择常用编码参数',exact:true}).selectOption(key);
      await page.locator('#encoder-setting-'+key).selectOption(value);
    }
    await save.click();
    await page.getByRole('status').filter({hasText:'配置已保存'}).waitFor();
    assert.deepEqual(writes[2],{revision:desiredRevision,changes:{packetsize:'1200',gamepad_driver:'virtualhid',virtualhid_randomize_mac:false,nvenc_twopass:'full_res',stream_audio:true,max_bitrate:'20000',ping_timeout:'-1',minimum_fps_target:'59.94',min_log_level:'warning',min_threads:'4',sw_preset:'superfast',sw_tune:'zerolatency'}});
    readFailure=true;
    await page.getByRole('button',{name:'重新读取编码器配置',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'编码器读取失败'}).waitFor();
    assert.equal(await name.isDisabled(),true);
    assert.deepEqual(errors,[]);
    const out=path.resolve(evidenceDirectory('artifacts/encoder-configuration'));fs.mkdirSync(out,{recursive:true});
    await page.screenshot({path:path.join(out,'admin-configuration.png'),fullPage:true});
    fs.writeFileSync(path.join(out,'admin-browser-result.json'),JSON.stringify({passed:true,engine,browser_version:browser.version(),patches:writes.length,cases:['search-preserves-hidden-drafts-on-save','search-native-key-and-label','search-catalog','preserve-hidden','conflict-preserves-draft','explicit-reset','save-not-runtime','read-failure-locks-editor','catalog-selection','boolean-typed-value','integer-input','invalid-range-preserves-edit','signed-integer-sentinel','decimal-range-and-fraction','native-enum-selection'],errors},null,2));
    console.log('Admin encoder configuration browser checks passed');
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
