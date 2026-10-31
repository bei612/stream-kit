// Built management UI with captured API writes; no deployment is modified.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {launchBrowser,engine,evidenceDirectory}=require('./lib/test-browser.cjs');
(async()=>{
  const root=path.resolve('orchestrator/web/dist'),browser=await launchBrowser();
  const errors=[],writes=[];let revision='initial',restart=false;
  const values={render_nodes:{existing:{name:'现有节点',base_url:'https://existing.example',control_secret:null}}};
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>localStorage.setItem('auth_token','test.'+btoa(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600}))+'.test'));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.hostname!=='admin.test')return route.abort();
      if(url.pathname.startsWith('/api/')){
        if(url.pathname==='/api/v1/configuration'){
          if(route.request().method()==='PATCH'){
            const body=route.request().postDataJSON();writes.push(body);
            if(body.revision!==revision)return route.fulfill({status:409,json:{status:'error',message:'配置已变化，请重新读取'}});
            assert.deepEqual(Object.keys(body.changes),['/render_nodes/node-a']);
            if(body.changes['/render_nodes/node-a']===null)delete values.render_nodes['node-a'];
            else values.render_nodes['node-a']={...body.changes['/render_nodes/node-a'],control_secret:null};revision='saved';restart=true;
          }
          return route.fulfill({json:{status:'ok',data:{revision,restart_required:restart,apply_policy:'service_restart',values,redacted_paths:Object.keys(values.render_nodes).map(id=>`/render_nodes/${id}/control_secret`),environment_overrides:[]}}});
        }
        if(url.pathname==='/api/v1/render-nodes')return route.fulfill({json:{status:'ok',data:{apply_policy:'service_restart',nodes:[{id:'existing',name:'现有节点',base_url:'https://existing.example'}]}}});
        if(url.pathname==='/api/v1/render-nodes/existing/audio-devices')return route.fulfill({json:{status:'ok',data:{node_id:'existing',inventory:{schema_version:1,request_id:'fixture',request_issued_at_ms:1,observed_at_ms:1,devices:[{id:'remote-output',name:'远端播放端点',input:false,output:true}],configured_routes:[]}}}});
        assert.equal(route.request().method(),'GET','node editing must not restart services');
        return route.fulfill({status:503,json:{status:'error',message:'测试未连接此服务'}});
      }
      const file=url.pathname.startsWith('/assets/')?path.resolve(root,'.'+url.pathname):path.join(root,'index.html');
      if(!file.startsWith(root+path.sep))return route.abort();
      return route.fulfill({path:file,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
    });
    await page.goto('http://admin.test/settings');
    await page.locator('summary').filter({hasText:'渲染节点连接'}).click();
    await page.getByLabel('渲染节点连接新名称').fill('node-a');
    await page.getByRole('button',{name:'添加条目',exact:true}).click();
    const field=name=>page.locator(`[id="setting/render_nodes/node-a/${name}"]`);
    await field('name').fill('新增渲染节点');await field('base_url').fill('https://node-a.example/gateway');
    assert.equal(await field('control_secret').getAttribute('type'),'password');
    await field('control_secret').fill('public-fixture-secret-for-node-a-32');
    await page.getByRole('button',{name:/^保存配置/}).click();
    await page.getByRole('status').filter({hasText:'存在待生效配置'}).waitFor();
    await page.waitForFunction(()=>document.getElementById('setting/render_nodes/node-a/control_secret').value==='');
    assert.equal(writes[0].changes['/render_nodes/node-a'].name,'新增渲染节点');
    assert.equal(await page.locator('#render-node-selection option').count(),1,'saved node must not appear as running before restart');
    await page.getByRole('button',{name:'读取节点设备',exact:true}).click();
    await page.getByLabel('节点音频设备').getByText('远端播放端点',{exact:true}).waitFor();
    revision='external-update';await field('name').fill('待保存名称');await page.getByRole('button',{name:/^保存配置/}).click();
    await page.getByRole('alert').filter({hasText:'配置已变化'}).waitFor();
    assert.deepEqual(writes[1].changes,{'/render_nodes/node-a/name':'待保存名称'},'unchanged secret must not be resubmitted');
    assert.equal(await field('name').inputValue(),'待保存名称');
    await page.getByRole('button',{name:'放弃修改并重新读取',exact:true}).click();
    await page.getByRole('button',{name:'移除节点 node-a',exact:true}).click();
    await page.getByRole('button',{name:'撤销移除',exact:true}).click();
    await page.getByRole('button',{name:'移除节点 node-a',exact:true}).click();
    await page.getByRole('button',{name:/^保存配置/}).click();
    await page.waitForFunction(()=>!document.getElementById('setting/render_nodes/node-a/name'));
    assert.deepEqual(writes[2].changes,{'/render_nodes/node-a':null});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'node management must fit narrow screens');
    assert.deepEqual(errors,[]);
    const output=evidenceDirectory('artifacts/admin-render-nodes');fs.mkdirSync(output,{recursive:true});
    await page.screenshot({path:path.join(output,'nodes-mobile.png'),fullPage:true});
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,engine,writes:writes.length,scope:'Built UI with mocked API: add/edit, secret hiding, restart distinction, stale save, node inventory and narrow layout; not real node routing'},null,2));
    console.log('Render node management UI passed: '+engine);
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
