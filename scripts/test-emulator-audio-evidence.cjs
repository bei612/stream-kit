const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertContinuousInjection } = require('./lib/emulator-audio-evidence.cjs');

test('silence after an exhausted, completed or stalled source cannot prove revocation', () => {
  const live = { packets: 200, senderEnded: false, rpcEnded: false, error: undefined };
  assert.doesNotThrow(() => assertContinuousInjection(live, 100));
  for (const change of [{ senderEnded: true }, { rpcEnded: true }, { error: 4 }, { packets: 100 }])
    assert.throws(() => assertContinuousInjection({ ...live, ...change }, 100));
});
