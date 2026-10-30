// Render production assets against isolated fixtures. Screenshots are layout
// evidence, not proof of media delivery or physical-device compatibility.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const gateway = path.join(root, 'third_party/moonlight-web-stream');
const { chromium } = createRequire(path.join(gateway, 'package.json'))('playwright');
const output = path.join(root, 'artifacts/web-ui-review');
fs.mkdirSync(output, { recursive: true });
const session = {
  session_id: '7b40da26-layout-fixture', host_id: 1, app_id: 2, state: 'running', revision: 3, control_epoch: 2,
  controller_connection_id: 'a9e2c7-controller',
  connections: Object.fromEntries(['a9e2c7-controller', 'b36d81-viewer', 'c89d45-viewer'].map((id, i) => [id, {
    connection_id: id, user_id: 'guest:fixture', role: i ? 'viewer' : 'controller', microphone_live: !i,
    state: 'connected', expires_at: new Date(Date.now() + 3600000).toISOString(),
  }])),
  audio: { target:{epoch:1,mode:'upstream',render_device_id:'',capture_device_id:''}, program_gain_db: 0, microphone_gain_db: 0, microphone_enabled: true, broadcast_controller_microphone: true, controller_monitor: false },
  policy: { max_viewers: 20, controller_disconnect_policy: 'release', allow_viewer_microphone: false },
};
const components = ['sunshine', 'web_server'].map((name, i) => ({ name, status: 'running', pid: 1000 + i, crash_count:0, started_at: new Date().toISOString() }));
const apps = [{ id: 'demo', name: '鼓楼直播电商基地 · UE5 场景', status: 'running', file_size_bytes: 5368709120, created_at: new Date().toISOString() }];
const token = `fixture.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.fixture`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if(url.pathname === '/gateway/config.js') {
    res.setHeader('Content-Type', 'text/javascript');
    return res.end('window.__CONFIG_JS__={path_prefix:"/gateway",managed_streaming:false,control_plane_url:null};');
  }
  const isGateway = url.pathname.startsWith('/gateway/');
  const base = isGateway ? path.join(gateway, 'dist') : path.join(root, 'orchestrator/web/dist');
  const relative = url.pathname.replace(/^\/gateway/, '');
  const name = relative === '/' || (!path.extname(relative) && !isGateway) ? '/index.html' : relative;
  const file = path.resolve(base, '.' + name);
  if(path.relative(base, file).startsWith('..') || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', {'.js':'text/javascript','.css':'text/css','.html':'text/html','.wasm':'application/wasm','.svg':'image/svg+xml','.json':'application/json'}[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

async function main() {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({ headless:true, channel:process.env.BROWSER_CHANNEL || 'chrome' });
  const errors = [], results = [], mutations = [];
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for(const width of [1440,390]) {
      const detail = {...apps[0],status:'ready',source:'local',exe_path:'C:\\Render\\Example.exe',args:'--initial',capture_mode:'application'};
      let failSettings = true;
      let failComponentRestart = true;
      const configuration = {revision:'config-1',restart_required:false,apply_policy:'service_restart',values:{server:{bind_address:'127.0.0.1:9000',password:'****'},storage:{max_file_count:1000},components:{gateway:{auto_start:true,env:{PRIVATE:'****'}}}},redacted_paths:['/server/password','/components/gateway/env/PRIVATE'],environment_overrides:[]};
      let conflictConfiguration=true;
      const gatewayConfiguration={revision:'native-1',restart_required:false,apply_policy:'gateway_restart',values:{moonlight:{pair_device_name:'Stream Kit',default_http_port:47989},web_server:{media_ticket_secret:null,control_plane_url:'https://control.example'},webrtc:{port_range:null,ice_servers:[{urls:null,username:'turn-user',credential:null}],include_loopback_candidates:true}},redacted_paths:['/web_server/media_ticket_secret','/webrtc/ice_servers/0/urls','/webrtc/ice_servers/0/credential'],overridden_paths:['/web_server/control_plane_url']};
      let conflictGateway=true;
      gatewayConfiguration.running_revision=gatewayConfiguration.revision;
      gatewayConfiguration.values.web_server.certificate=null;
      gatewayConfiguration.redacted_paths.push('/web_server/certificate');
      const context = await browser.newContext({ viewport:{width,height:900}, locale:'zh-CN', reducedMotion:'reduce' });
      await context.routeWebSocket('**/api/v1/ws**', ws => { ws.onMessage(()=>{}); });
      await context.route('**/api/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        let data;
        if(pathname === '/gateway/api/authenticate') return route.fulfill({status:401,json:{error:'Fixture login'}});
        if(route.request().method() !== 'GET') mutations.push({path:pathname,method:route.request().method()});
        if(pathname === '/api/v1/login') data = { token };
        else if(pathname === '/api/v1/components') data = components;
        else if(pathname === '/api/v1/components/web_server/restart') {
          if(failComponentRestart) {
            failComponentRestart=false;
            return route.fulfill({status:500,json:{status:'error',message:'组件原生配置预检失败，请检查配置及运行环境'}});
          }
          data=components[1];
        }
        else if(pathname === '/api/v1/apps') data = apps;
        else if(pathname === '/api/v1/apps/capture-capabilities') data = {schema_version:1,capture_modes:['desktop','application'],capture_mode_apply:'application_restart'};
        else if(pathname === '/api/v1/apps/demo') {
          if(route.request().method() === 'PUT') {
            Object.assign(detail,route.request().postDataJSON());
            if(failSettings) {
              detail.status='register_failed'; detail.error_message='编码器暂时不可用';
              return route.fulfill({status:400,json:{status:'error',message:'参数已保存，但尚未确认编码器应用成功，请查看应用状态并重试注册'}});
            }
          }
          data=detail;
        }
        else if(pathname === '/api/v1/apps/demo/register') { detail.status='ready'; detail.error_message=''; failSettings=false; data=detail; }
        else if(pathname === '/api/v1/health') data = { version:'review', commit:'fixture' };
        else if(pathname === '/api/v1/stream-sessions') data = [session];
        else if(pathname === '/api/v1/media-control') data = {
          reachable:true,lease_valid:true,observations_valid:true,acknowledged_at_ms:Date.now()-5000,lease_expires_at_ms:Date.now()+30000,
          observations_expires_at_ms:Date.now()+30000,applied_revisions:{[session.session_id]:3},
          observations:{[session.session_id]:{session_id:session.session_id,revision:session.revision,upstream_active:true,subscribers:3,microphone_target:{epoch:session.audio.target.epoch,state:'unconfigured',device:null,error:null}}},
        };
        else if(pathname === '/api/v1/logs') data = [];
        else if(pathname === '/api/v1/config') data = {server:{listen:'127.0.0.1:9000'}};
        else if(pathname === '/api/v1/configuration') {
          if(route.request().method()==='PATCH') {
            const update=route.request().postDataJSON();
            assert.equal(update.revision,configuration.revision);
            assert.deepEqual(Object.keys(update.changes),['/storage/max_file_count']);
            if(conflictConfiguration) { conflictConfiguration=false;return route.fulfill({status:409,json:{status:'error',message:'配置已被修改，请重新读取后再保存'}}); }
            configuration.values.storage.max_file_count=update.changes['/storage/max_file_count'];
            configuration.revision='config-2';configuration.restart_required=true;
          }
          data=configuration;
        }
        else if(pathname === '/api/v1/gateway-configuration') {
          if(route.request().method()==='PATCH') {
            const update=route.request().postDataJSON();
            assert.equal(update.revision,gatewayConfiguration.revision);
            if('/moonlight/pair_device_name' in update.changes) {
              assert.deepEqual(Object.keys(update.changes),['/moonlight/pair_device_name']);
              if(conflictGateway) {conflictGateway=false;return route.fulfill({status:409,json:{status:'error',message:'网关配置已被修改，请重新读取后保存'}})}
              gatewayConfiguration.values.moonlight.pair_device_name=update.changes['/moonlight/pair_device_name'];
              gatewayConfiguration.revision='native-2';
            } else if('/web_server/certificate/private_key_pem' in update.changes) {
              assert.deepEqual(update.changes,{'/web_server/certificate/private_key_pem':'certs/replaced-key.pem'});
              gatewayConfiguration.revision='native-3';
            } else {
              assert.deepEqual(update.changes,{'/webrtc/port_range':{min:50010,max:50020}});
              gatewayConfiguration.values.webrtc.port_range=update.changes['/webrtc/port_range'];
              gatewayConfiguration.revision='native-4';
            }
            gatewayConfiguration.restart_required=true;
          }
          data=gatewayConfiguration;
        }
        else if(pathname === '/api/v1/audio-devices') data = {schema_version:1,observed_at_ms:Date.now(),devices:[
          {id:'wasapi:render-fixture',name:'虚拟音频 · 网关输出',input:false,output:true},
          {id:'wasapi:capture-fixture',name:'虚拟音频 · 应用输入',input:true,output:false},
        ],configured_routes:[{host_id:1,app_id:2,endpoint:{render_device_id:'wasapi:render-fixture',capture_device_id:'wasapi:missing-fixture'}}]};
        else if(pathname.endsWith('/controller/b36d81-viewer')) { session.controller_connection_id='b36d81-viewer'; data=session; }
        else if(pathname.endsWith('/audio-target')) {
          const request=route.request().postDataJSON();
          assert.equal(request.expected_epoch,session.audio.target.epoch);
          session.audio.target={...request.target,epoch:++session.revision}; data=session;
        }
        else return route.fulfill({status:404,json:{status:'error',message:'Unrecognized review fixture route'}});
        return route.fulfill({json:{status:'ok',data}});
      });
      const page = await context.newPage();
      page.on('pageerror', e=>errors.push(e.message));
      async function capture(name) {
        await page.screenshot({path:path.join(output,`${name}-${width}.png`),fullPage:true});
        const layout = await page.evaluate(()=>({viewport:innerWidth, width:document.documentElement.scrollWidth}));
        assert.ok(layout.width<=layout.viewport+1,`${name} overflows at ${width}: ${layout.width}`);
        results.push({name,width,passed:true});
      }
      await page.goto(origin+'/login');
      await page.getByRole('heading',{name:'欢迎回来'}).waitFor();
      await capture('login');
      await page.getByLabel('用户名').fill('admin');
      await page.getByLabel('密码',{exact:true}).fill('isolated-fixture');
      await page.getByRole('button',{name:'登录控制台'}).click();
      await page.getByRole('heading',{name:'工作台',exact:true}).waitFor();
      await page.getByText('串流编码器',{exact:true}).waitFor();
      await capture('dashboard');
      for(const [route,name] of [['/stream-sessions','sessions'],['/components','components'],['/apps','apps'],['/upload','upload'],['/logs','logs'],['/settings','settings']]) {
        await page.locator(`nav a[href="${route}"]`).click();
        await page.locator('main h2').waitFor();
        if(name==='components') {
          assert.equal(await page.getByRole('button',{name:'启动',exact:true}).first().isDisabled(),true);
          await page.getByRole('button',{name:'重启',exact:true}).nth(1).click();
          await page.getByRole('alert').filter({hasText:'组件原生配置预检失败'}).waitFor();
          assert.equal(await page.getByRole('button',{name:'重启',exact:true}).nth(1).isEnabled(),true);
          await page.getByRole('button',{name:'重启',exact:true}).nth(1).click();
          await page.getByRole('alert').filter({hasText:'组件原生配置预检失败'}).waitFor({state:'hidden'});
          await page.waitForFunction(()=>[...document.querySelectorAll('button')].filter(button=>button.textContent.trim()==='重启').every(button=>!button.disabled));
        }
        if(name==='sessions') {
          await page.getByText('客户端 B36D81',{exact:true}).waitFor();
          const card=page.locator('.client-card').filter({hasText:'客户端 B36D81'});
          if(width===1440) { await card.getByRole('button',{name:'转移控制权'}).click(); await card.getByRole('button',{name:'释放控制权'}).waitFor(); }
          await page.getByLabel('发送方式',{exact:true}).selectOption('disabled');
          await page.getByRole('button',{name:'保存并应用目标'}).click();
          await page.getByRole('button',{name:'重新应用目标'}).waitFor();
          await page.getByLabel('发送方式',{exact:true}).selectOption('local');
          await page.getByRole('button',{name:'刷新音频设备'}).click();
          await page.getByLabel('网关写入端 · 输出设备',{exact:true}).selectOption('wasapi:render-fixture');
          await page.getByLabel('目标程序读取端 · 输入设备',{exact:true}).selectOption('wasapi:capture-fixture');
        }
        if(name==='settings') {
          await page.getByText('当前进程已加载此配置文件版本。',{exact:true}).waitFor();
          await page.locator('summary').filter({hasText:'渲染主机连接'}).click();
          await page.getByLabel('配对设备名称',{exact:true}).fill('Gateway draft');
          await page.getByRole('button',{name:'保存网关配置',exact:true}).click();
          await page.getByRole('alert').filter({hasText:'网关配置已被修改'}).waitFor();
          assert.equal(await page.getByLabel('配对设备名称',{exact:true}).inputValue(),'Gateway draft');
          await page.getByRole('button',{name:'放弃网关修改并重新读取',exact:true}).click();
          await page.waitForFunction(()=>document.querySelector('input[id="gateway-setting/moonlight/pair_device_name"]')?.value==='Stream Kit');
          await page.getByLabel('配对设备名称',{exact:true}).fill('Gateway saved');
          await page.getByRole('button',{name:'保存网关配置',exact:true}).click();
          await page.getByText('网关配置已保存，重启网关后生效。当前串流继续使用原配置。',{exact:true}).waitFor();
          await page.getByText('网关存在待生效配置，请在维护时段协调重启。',{exact:true}).waitFor();
          assert.equal(await page.getByText('当前进程已加载此配置文件版本。',{exact:true}).count(),0);
          await page.locator('summary').filter({hasText:'访问与信任'}).click();
          assert.equal(await page.getByLabel('媒体信任密钥',{exact:true}).inputValue(),'');
          await page.getByRole('button',{name:'清空可选配置',exact:true}).click();
          await page.getByText('保存后清空此可选配置，重启生效。',{exact:true}).waitFor();
          await page.getByRole('button',{name:'撤销此项修改',exact:true}).click();
          assert.equal(await page.getByLabel('证书路径',{exact:true}).inputValue(),'');
          await page.getByLabel('私钥路径',{exact:true}).fill('certs/replaced-key.pem');
          await page.getByRole('button',{name:'保存网关配置',exact:true}).click();
          await page.getByText('网关配置已保存，重启网关后生效。当前串流继续使用原配置。',{exact:true}).waitFor();
          assert.equal(await page.getByLabel('私钥路径',{exact:true}).inputValue(),'');
          await page.locator('summary').filter({hasText:'网络与 WebRTC'}).click();
          await page.getByLabel('媒体 UDP 端口范围',{exact:true}).selectOption('enabled');
          await page.getByLabel('起始端口',{exact:true}).fill('');
          await page.getByRole('button',{name:'保存网关配置',exact:true}).click();
          await page.getByRole('alert').filter({hasText:'起始端口 必须填写有效整数'}).waitFor();
          await page.getByLabel('起始端口',{exact:true}).fill('50010');
          await page.getByLabel('结束端口',{exact:true}).fill('50020');
          await page.getByRole('button',{name:'保存网关配置',exact:true}).click();
          await page.getByText('网关配置已保存，重启网关后生效。当前串流继续使用原配置。',{exact:true}).waitFor();
          await page.getByLabel('媒体 UDP 端口范围',{exact:true}).selectOption('disabled');
          await page.getByRole('button',{name:'撤销此项修改',exact:true}).click();
          assert.equal(await page.getByLabel('起始端口',{exact:true}).inputValue(),'50010');
          assert.equal(await page.getByLabel('访问凭据',{exact:true}).inputValue(),'');
          assert.equal(await page.getByLabel('访问凭据',{exact:true}).getAttribute('type'),'password');
          await page.getByRole('button',{name:'替换列表',exact:true}).click();
          await page.getByLabel('STUN / TURN 服务',{exact:true}).fill('{');
          await page.getByRole('button',{name:'保存网关配置',exact:true}).click();
          await page.getByRole('alert').filter({hasText:'JSON 格式无效'}).waitFor();
          await page.getByRole('button',{name:'撤销此项修改',exact:true}).click();
          assert.ok(await page.getByRole('button',{name:'保存网关配置',exact:true}).isDisabled());
          await capture('gateway-settings');
          await page.locator('summary').filter({hasText:'应用与存储'}).click();
          await page.getByLabel('解压文件数上限',{exact:true}).fill('1500');
          await page.getByRole('button',{name:'保存配置（1 项）',exact:true}).click();
          await page.getByRole('alert').filter({hasText:'配置已被修改'}).waitFor();
          assert.equal(await page.getByLabel('解压文件数上限',{exact:true}).inputValue(),'1500');
          await page.getByRole('button',{name:'放弃修改并重新读取',exact:true}).click();
          await page.waitForFunction(()=>document.querySelector('input[id="setting/storage/max_file_count"]')?.value==='1000');
          await page.getByLabel('解压文件数上限',{exact:true}).fill('2000');
          await page.getByRole('button',{name:'保存配置（1 项）',exact:true}).click();
          await page.getByText('配置已保存。服务重启后生效，当前串流继续使用原配置。',{exact:true}).waitFor();
          await page.getByText('存在待生效配置。请在维护时段通过服务管理器重启服务。',{exact:true}).waitFor();
          await page.getByRole('button',{name:'读取设备',exact:true}).click();
          await page.getByText('2 个设备 · 1 个应用绑定',{exact:true}).waitFor();
          await page.getByText('设备当前不可见',{exact:true}).waitFor();
          await page.locator('summary').filter({hasText:'全部设备与标识'}).click();
        }
        if(name==='upload') {
          await page.getByLabel('画面与声音范围',{exact:true}).selectOption('application');
          await page.getByText('下次启动应用生效',{exact:true}).waitFor();
        }
        await capture(name);
      }
      await page.goto(origin+'/apps/demo');
      await page.getByLabel('启动参数',{exact:true}).fill('--draft-with-native-failure');
      await page.getByRole('button',{name:'保存',exact:true}).click();
      await page.getByRole('alert').filter({hasText:'参数已保存'}).waitFor();
      await page.getByText('配置尚未在编码器中应用成功',{exact:true}).waitFor();
      assert.equal(await page.getByLabel('启动参数',{exact:true}).inputValue(),'--draft-with-native-failure');
      await capture('app-settings-pending');
      await page.getByRole('button',{name:'重试注册',exact:true}).click();
      await page.getByText('配置尚未在编码器中应用成功',{exact:true}).waitFor({state:'hidden'});
      await page.getByLabel('启动参数',{exact:true}).fill('--applied');
      await page.getByRole('button',{name:'保存',exact:true}).click();
      await page.getByText('配置已保存，下次启动应用时生效。',{exact:true}).waitFor();
      await capture('app-settings-saved');
      for(const status of ['running','registering']) {
        detail.status=status;
        await page.reload();
        await page.getByLabel('启动参数',{exact:true}).waitFor();
        assert.ok(await page.getByLabel('启动参数',{exact:true}).isDisabled());
        assert.ok(await page.getByLabel('画面与声音范围',{exact:true}).isDisabled());
        assert.ok(await page.getByRole('button',{name:'保存',exact:true}).isDisabled());
      }
      await page.goto(origin+'/gateway/index.html');
      await page.locator('#ml-api-name').waitFor();
      await capture('gateway-login');
      await context.close();
    }
    assert.deepEqual(errors,[],'Browser script errors');
    assert.ok(mutations.some(m=>m.path.endsWith('/controller/b36d81-viewer') && m.method==='PUT'));
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,scope:'Production UI with isolated API fixtures; desktop and narrow viewport, not physical-device/media acceptance',results,errors},null,2));
    console.log(JSON.stringify({passed:true,screenshots:results.length,output}));
  } finally { await browser.close(); server.close(); }
}
main().catch(error=>{fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,error:error.message}));console.error(error);server.close();process.exitCode=1;});
