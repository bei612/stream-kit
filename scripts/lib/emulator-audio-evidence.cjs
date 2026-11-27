const assert = require('node:assert/strict');

// Silence can prove revocation only while the independent source still runs.
function assertContinuousInjection(source, previousPackets) {
  assert.equal(source.senderEnded, false, 'Synthetic microphone source ended before the measurement');
  assert.equal(source.transportEnded, false, 'Synthetic microphone transport ended before the measurement');
  assert.equal(source.error, undefined, 'Synthetic microphone transport failed during the measurement');
  assert.ok(source.packets > previousPackets, 'Synthetic microphone packets did not advance during the measurement');
}

module.exports = { assertContinuousInjection };
