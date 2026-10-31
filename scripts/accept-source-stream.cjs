// Owns an isolated, source-built native encoder and delegates browser/media
// assertions to the shared acceptance harness. No live service is replaced.
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const dgram = require('node:dgram'), https = require('node:https'), crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events'), { setTimeout: delay } = require('node:timers/promises');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
function option(name) { const i = process.argv.indexOf(name); assert.ok(i >= 0 && process.argv[i+1], `Required ${name}`); return process.argv[i+1]; }
const encoder = path.resolve(option('--sunshine')), gateway = path.resolve(option('--gateway'));
const control = path.resolve(option('--orchestrator')), example = path.resolve(option('--example'));
const outputDevice = option('--example-output');
const serviceControl=process.argv.includes('--service-control');
const managedEncoder=process.argv.includes('--apply-managed-encoder')||serviceControl;
assert.ok(!managedEncoder||serviceControl||process.argv.includes('--edit-encoder-configuration'),'Managed encoder apply requires configuration editing');
const scratch = fs.mkdtempSync(path.join(root, '.local/source-stream-'));
const output = path.join(root, 'artifacts/source-stream', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(output, { recursive:true });
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result = { passed:false, scope:'Source-built Sunshine program capture, shared native gateway and browser acceptance',
  encoder_sha256:sha(encoder), gateway_sha256:sha(gateway), control_sha256:sha(control), example_sha256:sha(example), scratch };
const credentials = { username:'isolated-acceptance', password:crypto.randomBytes(32).toString('base64url') };
let child, exited, base;
async function ports() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = crypto.randomInt(40000, 55000), held = [];
    try {
      for (const offset of [-5, 0, 1, 21]) {
        const socket = net.createServer();
        await new Promise((resolve,reject) => { socket.once('error',reject); socket.listen(candidate+offset,'127.0.0.1',resolve); });
        held.push(() => new Promise(resolve => socket.close(resolve)));
      }
      for (const offset of [9, 10, 11]) {
        const socket = dgram.createSocket('udp4');
        try { await new Promise((resolve,reject) => { socket.once('error',reject); socket.bind(candidate+offset,'127.0.0.1',resolve); }); }
        catch (error) { socket.close(); throw error; }
        held.push(() => new Promise(resolve => socket.close(resolve)));
      }
      return candidate;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
    finally { for (const release of held) await release(); }
  }
  throw new Error('No free loopback native port group');
}
function native(resource, method='GET', body, csrf) {
  return new Promise((resolve,reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = https.request(`https://127.0.0.1:${base+1}${resource}`, {
      method, rejectUnauthorized:false, timeout:15000,
      headers:{ Authorization:'Basic '+Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64'),
        ...(payload ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)} : {}),
        ...(csrf ? {'X-CSRF-Token':csrf} : {}) },
    }, response => {
      let text=''; response.on('data', data => { text+=data; if(text.length>1048576) request.destroy(new Error('Native response too large')); });
      response.on('end', () => { try { assert.equal(response.statusCode,200,`Native ${resource}`); resolve(JSON.parse(text)); } catch(error) { reject(error); } });
    });
    request.on('timeout',()=>request.destroy(new Error('Native operation timed out'))); request.on('error',reject); request.end(payload);
  });
}
async function main() {
  base = await ports(); result.native_base_port = base;
  const catalog = path.join(scratch,'apps.json'), configFile = path.join(scratch,'sunshine.conf');
  fs.writeFileSync(catalog, JSON.stringify({env:{},apps:[]}));
  const nativePath = name => path.join(scratch,name).replaceAll('\\','/');
  const config = {port:base, bind_address:'127.0.0.1', address_family:'ipv4', system_tray:'disabled', upnp:'disabled',
    controller:'disabled',
    nvenc_opengl_vulkan_on_dxgi:'disabled', nvenc_latency_over_power:'disabled',
    install_steam_audio_drivers:'disabled', dd_configuration_option:'disabled', dd_config_revert_on_disconnect:'disabled',
    file_apps:nativePath('apps.json'), file_state:nativePath('state.json'), credentials_file:nativePath('credentials.json'),
    pkey:nativePath('key.pem'), cert:nativePath('cert.pem'), log_path:nativePath('sunshine.log'), sunshine_name:'StreamKit source acceptance' };
  fs.writeFileSync(configFile,Object.entries(config).map(([key,value])=>`${key} = ${value}`).join('\n'));
  if(process.argv.includes('--edit-encoder-configuration'))fs.appendFileSync(configFile,'\nglobal_prep_cmd = [\n]\n');
  try { execFileSync(encoder,[configFile,'--creds',credentials.username,credentials.password],{cwd:scratch,windowsHide:true,stdio:'ignore',timeout:30000}); }
  catch { throw new Error('Failed to initialize isolated native credentials'); }
  const fd=fs.openSync(path.join(output,'sunshine.log'),'w');
  child=spawn(encoder,[configFile,...(process.argv.includes('--edit-encoder-configuration')?['sunshine_name=StreamKit startup override']:[])],{cwd:scratch,windowsHide:true,stdio:['ignore',fd,fd]}); fs.closeSync(fd); exited=once(child,'exit');
  const info=`http://127.0.0.1:${base}/serverinfo`;
  let ready=false;
  for(let i=0;i<150;i++) {
    assert.equal(child.exitCode,null,'Source-built Sunshine exited during startup');
    try { if((await fetch(info,{signal:AbortSignal.timeout(500)})).ok) { ready=true; break; } } catch {}
    await delay(200);
  }
  assert.ok(ready,'Source-built Sunshine did not become ready');
  result.capabilities=await native('/api/stream-kit/capabilities');
  assert.ok(result.capabilities.capture_modes.includes('application'));
  assert.equal(result.capabilities.managed_runtime_version,1);
  const encoderConfigurationBefore=process.argv.includes('--edit-encoder-configuration')?await native('/api/config'):null;
  const runtime=path.join(scratch,'runtime.json');
  fs.writeFileSync(runtime,JSON.stringify({sunshine_api:{base_url:`https://127.0.0.1:${base+1}`,server_info_url:info,...credentials,verify_ssl:false},...(managedEncoder?{managed_encoder:{exe_path:encoder,config_file:configFile,working_dir:scratch}}:{})}));
  if(managedEncoder){child.kill();await exited;child=null;}
  console.log('Source-built Sunshine ready; starting program browser acceptance');
  const fd2=fs.openSync(path.join(output,'acceptance.log'),'w');
  const probe=spawn(process.execPath,[path.join(__dirname,'accept-managed-stream.cjs'),'--gateway',gateway,'--orchestrator',control,
    '--runtime-config',runtime,'--scratch',path.join(scratch,'media'),'--output-dir',path.join(output,'browser'),'--example',example,'--example-output',outputDevice,
    ...['--microphone-tone','--service-control','--remote-target','--target-switch','--stop-active','--delete-active','--restart-services','--expire-client-lease','--edit-gateway-configuration','--edit-encoder-configuration','--edit-vulkan','--apply-managed-gateway','--apply-managed-encoder'].filter(flag => process.argv.includes(flag)),
    ...['--web-assets','--audio-probe','--target-render-device','--target-capture-device','--clients','--hold-seconds','--microphone-source','--physical-device-label'].flatMap(flag=>process.argv.includes(flag)?[flag,option(flag)]:[])],
    {cwd:root,windowsHide:true,stdio:['ignore',fd2,fd2]}); fs.closeSync(fd2);
  const [code]=await once(probe,'exit');
  assert.equal(code,0,'Program browser acceptance failed; inspect acceptance.log');
  result.browser_result=path.relative(root,path.join(output,'browser/result.json')).replaceAll('\\','/');
  const browserResult = JSON.parse(fs.readFileSync(path.join(output,'browser/result.json'),'utf8'));
  assert.equal(browserResult.passed,true);
  result.browser_engine=browserResult.browser_engine;
  result.browser=browserResult.browser;
  if(serviceControl){assert.equal(browserResult.service_control?.identity,'LocalSystem');assert.equal(browserResult.service_cleanup?.passed,true);result.service_control=browserResult.service_control;}
  else if(managedEncoder){assert.equal(browserResult.encoder_apply?.passed,true);result.encoder_apply=browserResult.encoder_apply;}
  if(encoderConfigurationBefore&&!managedEncoder) {
    assert.equal(browserResult.encoder_configuration?.passed,true);
    const after=await native('/api/config');
    assert.equal(after.sunshine_name,'Stream Kit encoder acceptance');
    for(const [key,value] of Object.entries(encoderConfigurationBefore))if(key!=='sunshine_name')assert.deepEqual(after[key],value,`Untouched encoder field changed: ${key}`);
    assert.equal(after.global_prep_cmd,'[\n]');
    result.encoder_configuration={passed:true,untouched_fields_preserved:true,multiline_preserved:true};
  }
  if (process.argv.includes('--target-switch')) {
    assert.deepEqual(browserResult.target_mode_switch?.observations.map(item=>item.mode),['disabled','upstream'], 'Requested audio target mode switching was not verified');
    assert.equal(browserResult.target_mode_switch.video_continued,true);
  }
  result.passed=true;
}
main().catch(error=>{result.error=error.message;process.exitCode=1;}).finally(async()=>{
  if(child && child.exitCode===null) {
    try {
      const active=await native('/api/stream-kit/runtime');
      if(active.gamestream_id>0) {
        const registration=await native(`/api/stream-kit/apps/${active.app_id}`);
        assert.ok(registration.app.cmd.includes(example),'Refuse to stop an unrelated execution');
        const csrf=(await native('/api/csrf-token')).csrf_token;
        await native(`/api/stream-kit/apps/${active.app_id}/stop`,'POST',{instance_id:active.instance_id},csrf);
      }
    } catch(error) { result.cleanup_error=error.message;result.passed=false;process.exitCode=1; }
    child.kill(); await exited;
  }
  result.finished_at=new Date().toISOString();
  // Sparse native startup markers identify which media stage completed even
  // when browser acceptance times out. Absence is not interpreted as success.
  const encoderLog = managedEncoder?path.join(scratch,'sunshine.log'):path.join(output,'sunshine.log');
  if (fs.existsSync(encoderLog)) {
    if(managedEncoder)fs.copyFileSync(encoderLog,path.join(output,'managed-encoder.log'));
    result.encoder_startup = fs.readFileSync(encoderLog,'utf8').split(/\r?\n/)
      .filter(line=>line.includes('Application video startup:') || line.includes('Video startup failed to prepare initial image'));
  }
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,output}));
});
