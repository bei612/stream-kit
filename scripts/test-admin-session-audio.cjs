// Exercise production page drafts against concurrent administrator changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {engine, launchBrowser, evidenceDirectory} = require('./lib/test-browser.cjs');
(async () => {
  const root = path.resolve('orchestrator/web/dist');
  const browser = await launchBrowser();
  const session = {session_id:'audio-test', revision:1, control_epoch:1, host_id:1, app_id:2, state:'running', connections:{},
    audio:{program_gain_db:0, microphone_gain_db:0, microphone_enabled:true, broadcast_controller_microphone:true, controller_monitor:false, target:{mode:'upstream',epoch:1,render_device_id:'',capture_device_id:''}},
    policy:{max_viewers:20, controller_disconnect_policy:'release', allow_viewer_microphone:false}};
  const writes = [], policyWrites = [], targetWrites = [], errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('auth_token', 'test.'+btoa(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')+'.test'));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'admin.test') return route.abort();
      if (url.pathname.endsWith('/stream-sessions/audio-test/audio-target')) {
        const body = route.request().postDataJSON(); targetWrites.push(body);
        assert.equal(body.expected_epoch, session.audio.target.epoch);
        session.audio.target = {...body.target, epoch:session.audio.target.epoch+1}; session.revision++;
        return route.fulfill({json:{status:'ok',data:session}});
      }
      if (url.pathname.endsWith('/stream-sessions/audio-test/policy')) {
        const body = route.request().postDataJSON(); policyWrites.push(body);
        assert.deepEqual(body.expected_policy, session.policy);
        const {expected_policy, ...next} = body;
        session.policy = next; session.revision++;
        return route.fulfill({json:{status:'ok',data:session}});
      }
      if (url.pathname.endsWith('/stream-sessions/audio-test/audio')) {
        const body = route.request().postDataJSON(); writes.push(body);
        assert.deepEqual(body.expected_audio, session.audio);
        const {expected_audio, ...next} = body;
        session.audio = next; session.revision++;
        return route.fulfill({json:{status:'ok',data:session}});
      }
      if (url.pathname.endsWith('/render-nodes')) return route.fulfill({json:{status:'ok',data:{nodes:[{id:'primary',name:'主网关'},{id:'renderer-a',name:'渲染服务器 A'}]}}});
      if (url.pathname.endsWith('/render-nodes/renderer-a/audio-devices')) return route.fulfill({json:{status:'ok',data:{node_id:'renderer-a',inventory:{schema_version:2,instance_id:'0123456789abcdef0123456789abcdef',devices:[{id:'remote-out',name:'虚拟音频输出',output:true,input:false},{id:'remote-in',name:'目标程序录音输入',input:true,output:false}],configured_routes:[]}}}});
      if (url.pathname.startsWith('/api/') && url.pathname.endsWith('/stream-sessions')) return route.fulfill({json:{status:'ok',data:[session]}});
      if (url.pathname.endsWith('/media-control')) return route.fulfill({json:{status:'ok',data:{reachable:false,lease_valid:false,observations_valid:false,applied_revisions:{},observations:{}}}});
      if (url.pathname.startsWith('/api/')) return route.fulfill({json:{status:'ok',data:{}}});
      const file = url.pathname.startsWith('/assets/') ? path.resolve(root,'.'+url.pathname) : path.join(root,'index.html');
      if (!file.startsWith(root+path.sep)) return route.abort();
      return route.fulfill({path:file,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
    });
    await page.goto('http://admin.test/stream-sessions');
    const gain = page.getByRole('spinbutton',{name:'程序音量（dB）'});
    const microphone = page.getByRole('checkbox',{name:'允许控制者麦克风'});
    const save = page.getByRole('button',{name:'应用音频设置',exact:true});
    await gain.fill('-6');
    session.audio.microphone_enabled = false; session.revision++;
    await page.getByRole('button',{name:'刷新',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'当前草稿未覆盖服务器设置'}).waitFor();
    assert.equal(await gain.inputValue(),'-6');
    assert.equal(await save.isDisabled(),true);
    assert.equal(writes.length,0);
    await page.getByRole('button',{name:'载入最新音频配置',exact:true}).click();
    assert.equal(await microphone.isChecked(),false);
    await gain.fill('-3');
    const saved = page.waitForResponse(response => response.url().endsWith('/stream-sessions/audio-test/audio'));
    await save.click(); await saved;
    await page.waitForFunction(() => document.querySelector('input[type=number]')?.value === '-3');
    assert.equal(writes.length,1);
    assert.equal(writes[0].microphone_enabled,false);
    assert.equal(writes[0].expected_audio.program_gain_db,0);
    // Untouched form follows a later server change without forcing a remount.
    session.audio.program_gain_db = -9; session.revision++;
    await page.getByRole('button',{name:'刷新',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('input[type=number]')?.value === '-9');
    const capacity = page.getByRole('spinbutton',{name:'最大客户端数'});
    const savePolicy = page.getByRole('button',{name:'应用连接容量',exact:true});
    await capacity.fill('10');
    session.policy.max_viewers = 5; session.revision++;
    await page.getByRole('button',{name:'刷新',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'当前容量草稿已保留'}).waitFor();
    assert.equal(await capacity.inputValue(),'10');
    assert.equal(await savePolicy.isDisabled(),true);
    assert.equal(policyWrites.length,0);
    await page.getByRole('button',{name:'载入最新连接配置',exact:true}).click();
    assert.equal(await capacity.inputValue(),'5');
    await capacity.fill('8');
    const policySaved = page.waitForResponse(response => response.url().endsWith('/stream-sessions/audio-test/policy'));
    await savePolicy.click(); await policySaved;
    assert.equal(policyWrites.length,1);
    assert.equal(policyWrites[0].expected_policy.max_viewers,5);
    assert.equal(policyWrites[0].controller_disconnect_policy,'release');
    const targetMode = page.getByRole('combobox',{name:'发送方式',exact:true});
    await targetMode.selectOption('disabled');
    session.audio.target = {mode:'local',epoch:2,render_device_id:'render-fixture',capture_device_id:'capture-fixture'}; session.revision++;
    await page.getByRole('button',{name:'刷新',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'配置已在其他页面更新'}).waitFor();
    assert.equal(await targetMode.inputValue(),'disabled');
    assert.equal(await page.getByRole('button',{name:'保存并应用目标',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'载入最新配置',exact:true}).click();
    assert.equal(await targetMode.inputValue(),'local');
    await targetMode.selectOption('disabled');
    const targetSaved = page.waitForResponse(response => response.url().endsWith('/stream-sessions/audio-test/audio-target'));
    await page.getByRole('button',{name:'保存并应用目标',exact:true}).click(); await targetSaved;
    assert.deepEqual(targetWrites,[{expected_epoch:2,target:{mode:'disabled',render_device_id:'',capture_device_id:''}}]);
    await targetMode.selectOption('remote');
    await page.getByRole('combobox',{name:'目标渲染节点',exact:true}).selectOption('renderer-a');
    await page.getByRole('button',{name:'刷新音频设备',exact:true}).click();
    await page.getByRole('combobox',{name:'网关写入端 · 输出设备',exact:true}).selectOption('remote-out');
    await page.getByRole('combobox',{name:'目标程序读取端 · 输入设备',exact:true}).selectOption('remote-in');
    const remoteSaved=page.waitForResponse(response=>response.url().endsWith('/stream-sessions/audio-test/audio-target'));
    await page.getByRole('button',{name:'保存并应用目标',exact:true}).click();await remoteSaved;
    assert.deepEqual(targetWrites[1],{expected_epoch:3,target:{mode:'remote',node_id:'renderer-a',render_device_id:'remote-out',capture_device_id:'remote-in'}});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
    assert.deepEqual(errors,[]);
    const out = evidenceDirectory('artifacts/session-audio');
    fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,'admin-browser-result.json'), JSON.stringify({passed:true,engine,browser_version:browser.version(),cases:['stale-draft-preserved','stale-submit-disabled','explicit-reload','compare-and-set-payload','untouched-form-refresh','capacity-conflict-preserves-draft','capacity-compare-and-set','target-conflict-preserves-draft','target-compare-and-set','remote-node-device-selection-and-save','narrow-layout'],errors},null,2));
    console.log('Session audio browser checks passed');
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
