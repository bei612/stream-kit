const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

if (process.argv.length !== 3) throw Error('Expected source-built Sunshine executable');
const binary = path.resolve(process.argv[2]);
const root = path.resolve(__dirname, '..');
const parent = path.join(root, '.local', 'validation');
fs.mkdirSync(parent, {recursive:true});
const scratch = fs.mkdtempSync(path.join(parent, 'renderer-bootstrap-'));
const credentials = path.join(scratch, 'credentials.json');
const config = path.join(scratch, 'sunshine.conf');
const native = file => file.replaceAll('\\', '/');
fs.writeFileSync(config, [
  'system_tray = disabled',
  'upnp = disabled',
  `credentials_file = ${native(credentials)}`,
  `file_state = ${native(path.join(scratch, 'state.json'))}`,
  `file_apps = ${native(path.join(scratch, 'apps.json'))}`,
  `log_path = ${native(path.join(scratch, 'sunshine.log'))}`,
].join('\n'));
fs.writeFileSync(path.join(scratch, 'apps.json'), '{"env":{},"apps":[]}');
const password = crypto.randomBytes(32).toString('base64url');
function run(args, input = '') {
  const result = spawnSync(binary, [config, ...args], {cwd:scratch, input, encoding:'utf8', timeout:30000, windowsHide:true});
  if (result.error) throw result.error;
  assert.equal(result.signal, null, 'Renderer command timed out or was signalled');
  assert.ok(!(result.stdout + result.stderr).includes(password), 'Credential leaked to process output');
  return result.status;
}
assert.equal(run(['--creds-stdin'], JSON.stringify({name:'installation-test', password})), 0);
const saved = JSON.parse(fs.readFileSync(credentials, 'utf8'));
assert.equal(saved.username, 'installation-test');
// Sunshine uses its existing reversed-byte uppercase SHA-256 serialization.
assert.equal(saved.password, crypto.createHash('sha256').update(password + saved.salt).digest().reverse().toString('hex').toUpperCase());
const before = fs.readFileSync(credentials);
assert.notEqual(run(['--creds-stdin'], JSON.stringify({name:'installation-test', password:1})), 0);
assert.deepEqual(fs.readFileSync(credentials), before);
assert.notEqual(run(['--creds-stdin'], 'x'.repeat(16385)), 0);
assert.deepEqual(fs.readFileSync(credentials), before);
assert.notEqual(run(['--creds']), 0, 'Missing credential arguments must fail without indexing argv');
assert.deepEqual(fs.readFileSync(credentials), before);
fs.chmodSync(credentials, 0o444);
try {
  assert.notEqual(run(['--creds-stdin'], JSON.stringify({name:'installation-test', password})), 0, 'Read-only persistence failure must propagate');
  assert.notEqual(run(['--creds', 'installation-test', password]), 0, 'Legacy command must also propagate persistence failure');
  assert.deepEqual(fs.readFileSync(credentials), before);
} finally {
  fs.chmodSync(credentials, 0o600);
}
console.log(JSON.stringify({passed:true, scope:'offline renderer credential CLI, no listeners or capture started', scratch}));
