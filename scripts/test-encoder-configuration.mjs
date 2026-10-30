import assert from 'node:assert/strict';
import { persistConfiguration } from '../third_party/sunshine/src_assets/common/assets/web/configuration_save.js';

const config = { mouse: 'disabled', fec_percentage: 20 };
let sent;
const saved = await persistConfiguration(config, async (url, request) => {
  sent = { url, request };
  return { ok: true, json: async () => ({ status: true, apply_policy: 'encoder_restart' }) };
});
assert.equal(saved.apply_policy, 'encoder_restart');
assert.equal(sent.url, './api/config');
assert.equal(sent.request.method, 'POST');
assert.deepEqual(JSON.parse(sent.request.body), config);
for (const [ok, result] of [
  [true, { status: false }],
  [true, { status: true }],
  [true, { status: true, apply_policy: 'live' }],
  [false, { status: true, apply_policy: 'encoder_restart' }],
  [true, null],
]) {
  await assert.rejects(persistConfiguration(config, async () => ({ ok, json: async () => result })), /not confirmed/);
}
await assert.rejects(persistConfiguration(config, async () => ({ ok: false, json: async () => ({ committed: true }) })), /Reload before retrying/);
await assert.rejects(persistConfiguration(config, async () => ({ ok: false, json: async () => ({ error: 'Disk is unavailable' }) })), /Disk is unavailable/);
await assert.rejects(persistConfiguration(config, async () => { throw new Error('Connection lost'); }), /Connection lost/);
await assert.rejects(persistConfiguration(config, async () => ({ ok: true, json: async () => { throw new Error('Invalid JSON'); } })), /Invalid JSON/);
console.log('Encoder configuration acknowledgement checks passed');
