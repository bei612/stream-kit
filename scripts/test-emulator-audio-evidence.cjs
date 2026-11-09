const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertContinuousInjection, validMonoPCM } = require('./lib/emulator-audio-evidence.cjs');

test('silence after an exhausted, completed or stalled source cannot prove revocation', () => {
  const live = { packets: 200, senderEnded: false, rpcEnded: false, error: undefined };
  assert.doesNotThrow(() => assertContinuousInjection(live, 100));
  for (const change of [{ senderEnded: true }, { rpcEnded: true }, { error: 4 }, { packets: 100 }])
    assert.throws(() => assertContinuousInjection({ ...live, ...change }, 100));
});

test('PCM decoding rejects explicit incompatible audio formats and partial samples', () => {
  const packet = { audio: Buffer.alloc(1920), format: { samplingRate: '48000', channels: 0, format: 1 } };
  assert.equal(validMonoPCM(packet), true);
  assert.equal(validMonoPCM({ audio: Buffer.alloc(1920) }), true);
  for (const change of [{ samplingRate: '44100' }, { channels: 1 }, { format: 0 }])
    assert.equal(validMonoPCM({ ...packet, format: { ...packet.format, ...change } }), false);
  assert.equal(validMonoPCM({ ...packet, audio: Buffer.alloc(3) }), false);
});
