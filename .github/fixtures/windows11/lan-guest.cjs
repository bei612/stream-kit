'use strict';

// Runs only after the boot and audio checks in the isolated Windows guest.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {execute, serviceStartTimeout} = require('./maintain-windows-runtime.cjs');

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function verifyWindowsLAN({program, data, output, build, ps}) {
  const guest = JSON.parse(ps('Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model | ConvertTo-Json -Compress'));
  assert.equal(process.platform, 'win32');
  assert.equal(guest.Manufacturer, 'QEMU');
  assert.equal(guest.Model, 'StreamKit-Win11-Acceptance');
  const fixture = path.resolve('lan-fixture');
  const net = read(path.join(fixture, 'network.json'));
  const hostname = os.hostname().toLowerCase() + '.local';
  assert.match(hostname, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/);
  const report = {passed:false, stage:'setup', runtime_commit:build, hostname, network:net};
  const record = () => write(path.join(output, 'windows-lan-guest.json'), report);
  record();
  ps(String.raw`
$ErrorActionPreference='Stop'
$port=[IO.Ports.SerialPort]::new('COM1',115200)
try{
 $port.WriteTimeout=8000
 $port.Open()
 $message = @{phase='lan_ready'; guest_utc=[DateTime]::UtcNow.ToString('o'); guest_time_zone=(Get-TimeZone).Id}
 $event = [Text.Encoding]::UTF8.GetBytes(($message | ConvertTo-Json -Compress))
 $port.WriteLine('STREAMKIT_EVIDENCE '+[Convert]::ToBase64String($event))
}finally{$port.Dispose()}`);
  const adapter = JSON.parse(ps(String.raw`
$ErrorActionPreference='Stop'
$mac=[Console]::In.ReadToEnd()|ConvertFrom-Json
for($i=0;$i -lt 45;$i++){
 $device=@(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object MacAddress -eq $mac)
 if($device.Count -eq 1 -and $device[0].Status -eq 'Up'){
  $device[0] | Select-Object Name,ifIndex | ConvertTo-Json -Compress
  return
 }
 Start-Sleep -Seconds 1
}
throw 'Owned VM NIC did not become active'`, net.mac, 65000));
  const addresses = () => JSON.parse(ps(String.raw`
$ErrorActionPreference='Stop'
$i=[Console]::In.ReadToEnd()|ConvertFrom-Json
ConvertTo-Json -InputObject @(Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object PrefixOrigin -eq Manual | Select-Object -ExpandProperty IPAddress) -Compress`, adapter.ifIndex));
  function changeAddress(oldAddress, newAddress) {
    ps(String.raw`
$ErrorActionPreference='Stop'
$p=[Console]::In.ReadToEnd()|ConvertFrom-Json
if($p.old){Remove-NetIPAddress -InterfaceIndex $p.index -IPAddress $p.old -Confirm:$false}
else{Set-NetIPInterface -InterfaceIndex $p.index -AddressFamily IPv4 -Dhcp Disabled}
New-NetIPAddress -InterfaceIndex $p.index -IPAddress $p.next -PrefixLength 24 | Out-Null`,
    {index: adapter.ifIndex, old:oldAddress, next:newAddress});
    assert.deepEqual(addresses(), [newAddress]);
  }
  assert.deepEqual(addresses(), []);
  changeAddress(null, net.old_address);

  const runtime = path.join(program, 'orchestrator', 'orchestrator.exe');
  const controlFile = path.join(data, 'orchestrator.json');
  const gatewayFile = path.join(data, 'gateway', 'config.json');
  const control = read(controlFile), gateway = read(gatewayFile);
  assert.equal(control.server.bind_address, '127.0.0.1:19000');
  const caCert = path.join(data, 'acceptance-ca.crt');
  const caKey = path.join(data, 'acceptance-ca.key');
  const leaf = path.join(data, 'gateway', 'acceptance.crt');
  const leafKey = path.join(data, 'gateway', 'acceptance.key');
  const ca = fs.readFileSync(path.join(fixture, 'ca.crt'));
  fs.copyFileSync(path.join(fixture, 'ca.key'), caKey, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(caCert, ca, {flag:'wx'});
  execute(runtime, ['service', 'stop', '--config', controlFile]);
  Object.assign(control.server, {
    bind_address:'0.0.0.0:19000', tls_cert:leaf, tls_key:leafKey,
    cors_origins:['https://{host}:18080'],
    lan_tls:{ca_cert:caCert, ca_key:caKey, watch_hostname:hostname, auto_detect:true, auto_interfaces:[adapter.Name]},
  });
  Object.assign(control.moonlight_web, {base_url:'https://127.0.0.1:18080', public_url:''});
  control.components.web_server.env = {...control.components.web_server.env, WEBRTC_ICE_SERVER_COUNT:'0'};
  control.components.web_server.health_check.url = 'https://127.0.0.1:18080/stream.html';
  Object.assign(gateway.web_server, {
    bind_address:'0.0.0.0:18080', certificate:{certificate_pem:leaf, private_key_pem:leafKey},
    control_plane_url:'https://127.0.0.1:19000', session_cookie_secure:true,
  });
  gateway.webrtc = {...gateway.webrtc, port_range:{min:51000,max:51100}};
  write(controlFile, control);
  write(gatewayFile, gateway);
  // Model a LAN deployment's inbound policy, scoped to the guest's owned NIC
  // and private subnet. Keep the Windows firewall and network profile enabled.
  ps(String.raw`
$ErrorActionPreference='Stop'
$p=[Console]::In.ReadToEnd()|ConvertFrom-Json
$opts=@{Direction='Inbound';Action='Allow';Profile='Any';RemoteAddress=$p.subnet;InterfaceAlias=$p.alias}
New-NetFirewallRule @opts -DisplayName 'Stream Kit test HTTPS' -Protocol TCP -LocalPort 19000,18080 | Out-Null
New-NetFirewallRule @opts -DisplayName 'Stream Kit test media' -Protocol UDP -Program $p.gateway -LocalPort $p.media | Out-Null
New-NetFirewallRule @opts -DisplayName 'Stream Kit test mDNS' -Protocol UDP -LocalPort 5353 | Out-Null`,
  {subnet:net.subnet, alias:adapter.Name, gateway:control.components.web_server.exe_path, media:'51000-51100'});
  execute(runtime, ['check-config', '--config', controlFile]);
  execute(runtime, ['service', 'start', '--config', controlFile], undefined, serviceStartTimeout);

  let token;
  function api(resource, method='GET', body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers = {'Content-Type':'application/json'};
      if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
      if (token) headers.Authorization = 'Bearer ' + token;
      const req = https.request({host:'127.0.0.1',port:19000,path:'/api/v1'+resource,ca,method,headers,agent:false}, res => {
        const buffers = [];
        res.on('data', data => buffers.push(data));
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(Error('Guest control API returned HTTP '+res.statusCode));
          try { resolve(JSON.parse(Buffer.concat(buffers)).data); } catch (err) { reject(err); }
        });
      });
      req.setTimeout(12000, () => req.destroy(Error('Guest control API timed out')));
      req.on('error', reject);
      req.end(payload);
    });
  }
  async function stableRuntime() {
    for (let attempt=0; attempt<80; attempt++) {
      const health = await api('/health').catch(() => null);
      if (health?.commit === build && ['sunshine','web_server'].every(name => health.components?.[name]?.status === 'running')) {
        const component = name => health.components[name].pid;
        return {
          orchestrator: Number(ps("(Get-CimInstance Win32_Service -Filter \"Name='StreamKitOrchestrator'\").ProcessId").trim()),
          sunshine:component('sunshine'), gateway:component('web_server'),
        };
      }
      await delay(300);
    }
    throw Error('Guest native runtime did not become ready');
  }
  async function notify(phase, payload) {
    const response = await fetch(`http://${net.client_address}:18410/${phase}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload),
      signal:AbortSignal.timeout(260000),
    });
    assert.equal(response.status, 204, 'Independent LAN client did not pass phase '+phase);
  }

  report.stage = 'initial_video';
  report.component_pids_before = await stableRuntime();
  const login = await api('/login','POST',{username:control.server.username,password:control.server.password});
  token = login.token;
  assert.ok(token);
  const app = await api('/apps/local','POST',{name:'Windows LAN Example',
    exe_path:path.join(fixture,'checkerboard.exe'), working_dir:fixture, capture_mode:'desktop'});
  const resource = `/apps/${app.id}/watch-link`;
  try {
    const watch = await api(resource,'POST');
    assert.ok(watch.enabled);
    assert.equal(watch.stable_origin, `https://${hostname}:19000`);
    assert.ok(typeof watch.path === 'string' && /^\/watch#key=[A-Za-z0-9_-]+$/.test(watch.path),
      'Guest permanent viewing path is missing');
    const protectedFiles = [controlFile, gatewayFile, caCert, caKey, leafKey];
    const trustBefore = protectedFiles.map(hash);
    record();
    await notify('before', {hostname, watch: watch.path});
    report.stage = 'changed_address';
    changeAddress(net.old_address, net.new_address);
    report.addresses_after = addresses();
    record();
    await notify('after', {});
    report.component_pids_after = await stableRuntime();
    assert.deepEqual(report.component_pids_after, report.component_pids_before);
    assert.deepEqual(protectedFiles.map(hash), trustBefore);
    const current = await api(resource);
    assert.ok(current.enabled && current.path === watch.path && current.stable_origin === watch.stable_origin,
      'Permanent link changed during guest address reassignment');
    report.config_trust_and_watch_preserved = true;
    report.stage = 'complete';
    report.passed = true;
  } finally {
    try { await api(`/apps/${app.id}/stop`, 'POST'); report.target_stopped = true; }
    finally { record(); }
  }
  return report;
}

module.exports = {verifyWindowsLAN};
