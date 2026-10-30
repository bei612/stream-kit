// Native configuration preflight: never starts listeners or opens audio devices.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const binary = process.argv[2];
assert.ok(binary, 'Usage: node scripts/test-gateway-config.cjs <web-server.exe>');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-kit-config-'));
const configPath = path.join(directory, 'config.json');
const storagePath = path.join(directory, 'data.json');
let count = 0;
function check(config, expected, extra = [], command = ['config', 'check']) {
  if (config?.web_server) config = {...config, web_server:{
    first_login_create_admin:false, first_login_assign_global_hosts:false, ...config.web_server,
  }};
  if (config !== null) fs.writeFileSync(configPath, JSON.stringify(config));
  const result = spawnSync(path.resolve(binary), ['--config-path', configPath, ...extra, ...command],
    { cwd: directory, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, expected, result.stderr);
  assert.ok(!(result.stdout + result.stderr).includes('private-test-value'), 'validation exposed field contents');
  assert.equal(fs.existsSync(storagePath), false, 'check created gateway storage');
  assert.equal(fs.existsSync(path.join(directory, 'server')), false, 'check created default runtime resources');
  count++;
}
check(null, 2);
const base = { data_storage: { type:'json', path:storagePath, session_expiration_check_interval:{secs:300,nanos:0} } };
check(base, 0);
check({...base, unknown_setting:'private-test-value'}, 2);
check({...base, webrtc:{port_range:{min:500,max:499}}}, 2);
check({...base, webrtc:{port_range:{min:0,max:10}}}, 2);
check({...base, webrtc:{port_range:{min:500,max:500}}}, 0);
check({...base, webrtc:{nat_1to1:{ips:['private-test-value'],ice_candidate_type:'host'}}}, 2);
check({...base, data_storage:{...base.data_storage, session_expiration_check_interval:{secs:0,nanos:0}}}, 2);
check(base, 2, ['--webrtc-port-range','900:800']);
check(base, 0, ['--webrtc-port-range','800:900']);
const tlsFixtures = path.resolve(__dirname, '../third_party/moonlight-web-stream/tests/fixtures/tls');
const certificate = {
  certificate_pem: path.join(tlsFixtures, 'test-cert.pem.fixture'),
  private_key_pem: path.join(tlsFixtures, 'test-key.pem.fixture'),
};
check({...base, web_server:{certificate}}, 0);
check({...base, web_server:{certificate:{...certificate, private_key_pem:path.join(tlsFixtures, 'other-test-key.pem.fixture')}}}, 2);
check({...base, web_server:{certificate:{...certificate, certificate_pem:'private-test-value-missing.pem'}}}, 2);
const invalidPem = path.join(directory, 'invalid.pem');
fs.writeFileSync(invalidPem, 'private-test-value');
check({...base, web_server:{certificate:{...certificate, certificate_pem:invalidPem}}}, 2);
check({...base, web_server:{certificate:{...certificate, private_key_pem:invalidPem}}}, 2);
fs.writeFileSync(invalidPem, Buffer.alloc(1024 * 1024 + 1, 'x'));
check({...base, web_server:{certificate:{...certificate, certificate_pem:invalidPem}}}, 2);
check({...base, web_server:{certificate:{...certificate, certificate_pem:directory}}}, 2);
check({...base, web_server:{certificate:{...certificate, certificate_pem:'private-test-value-missing.pem'}}}, 1, [], ['run']);
check({...base, webrtc:{port_range:{min:900,max:800}}}, 1, [], ['run']);
console.log(JSON.stringify({passed:true, cases:count, scope:'Native configuration checks only; no services, device access or runtime storage created.'}));
