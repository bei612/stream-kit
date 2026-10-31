// Exercise production page drafts against concurrent administrator changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const {chromium} = createRequire(path.resolve('third_party/moonlight-web-stream/package.json'))('playwright');
(async () => {
  const root = path.resolve('orchestrator/web/dist');
  const browser = await chromium.launch({headless:true, channel:process.env.BROWSER_CHANNEL || 'chrome'});
  const session = {session_id:'audio-test', revision:1, control_epoch:1, host_id:1, app_id:2, state:'running', connections:{},
    audio:{program_gain_db:0, microphone_gain_db:0, microphone_enabled:true, broadcast_controller_microphone:true, controller_monitor:false, target:{mode:'upstream',epoch:1,render_device_id:'',capture_device_id:''}},
    policy:{max_viewers:20, controller_disconnect_policy:'release', allow_viewer_microphone:false}};
  const writes = [], policyWrites = [], errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('auth_token', 'test.'+btoa(JSON.stringify({exp:Date.now()/1000+3600}))+'.test'));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'admin.test') return route.abort();
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
    assert.deepEqual(errors,[]);
    fs.mkdirSync('artifacts/session-audio',{recursive:true});
    fs.writeFileSync('artifacts/session-audio/admin-browser-result.json', JSON.stringify({passed:true,cases:['stale-draft-preserved','stale-submit-disabled','explicit-reload','compare-and-set-payload','untouched-form-refresh','capacity-conflict-preserves-draft','capacity-compare-and-set'],errors},null,2));
    console.log('Session audio browser checks passed');
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
