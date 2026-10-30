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
  audio: { program_gain_db: 0, microphone_gain_db: 0, microphone_enabled: true, broadcast_controller_microphone: true, controller_monitor: false },
  policy: { max_viewers: 20, controller_disconnect_policy: 'release', allow_viewer_microphone: false },
};
const components = ['sunshine', 'web_server'].map((name, i) => ({ name, status: 'running', pid: 1000 + i, started_at: new Date().toISOString() }));
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
      const context = await browser.newContext({ viewport:{width,height:900}, locale:'zh-CN', reducedMotion:'reduce' });
      await context.routeWebSocket('**/api/v1/ws**', ws => { ws.onMessage(()=>{}); });
      await context.route('**/api/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        let data;
        if(pathname === '/gateway/api/authenticate') return route.fulfill({status:401,json:{error:'Fixture login'}});
        if(route.request().method() !== 'GET') mutations.push({path:pathname,method:route.request().method()});
        if(pathname === '/api/v1/login') data = { token };
        else if(pathname === '/api/v1/components') data = components;
        else if(pathname === '/api/v1/apps') data = apps;
        else if(pathname === '/api/v1/health') data = { version:'review', commit:'fixture' };
        else if(pathname === '/api/v1/stream-sessions') data = [session];
        else if(pathname === '/api/v1/media-control') data = {
          reachable:true,lease_valid:true,observations_valid:true,acknowledged_at_ms:Date.now()-5000,lease_expires_at_ms:Date.now()+30000,
          observations_expires_at_ms:Date.now()+30000,applied_revisions:{[session.session_id]:3},
          observations:{[session.session_id]:{session_id:session.session_id,revision:3,upstream_active:true,subscribers:3,microphone_target:{state:'unconfigured',device:null}}},
        };
        else if(pathname === '/api/v1/logs') data = [];
        else if(pathname === '/api/v1/config') data = {server:{listen:'127.0.0.1:9000'}};
        else if(pathname.endsWith('/controller/b36d81-viewer')) { session.controller_connection_id='b36d81-viewer'; data=session; }
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
        if(name==='sessions') {
          await page.getByText('客户端 B36D81',{exact:true}).waitFor();
          const card=page.locator('.client-card').filter({hasText:'客户端 B36D81'});
          if(width===1440) { await card.getByRole('button',{name:'转移控制权'}).click(); await card.getByRole('button',{name:'释放控制权'}).waitFor(); }
        }
        await capture(name);
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
