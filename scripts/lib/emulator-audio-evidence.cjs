const assert = require('node:assert/strict');

// Silence can prove revocation only while the independent source still runs.
function assertContinuousInjection(source, previousPackets) {
  assert.equal(source.senderEnded, false, 'Synthetic microphone source ended before the measurement');
  assert.equal(source.rpcEnded, false, 'Official microphone injection RPC ended before the measurement');
  assert.equal(source.error, undefined, 'Official microphone injection failed during the measurement');
  assert.ok(source.packets > previousPackets, 'Synthetic microphone packets did not advance during the measurement');
}

// AudioPacket may omit a repeated format; any explicitly supplied format must
// agree with the requested mono S16LE/48kHz format before decoding its PCM.
function validMonoPCM(packet) {
  const format = packet.format;
  return Buffer.isBuffer(packet.audio) && packet.audio.length % 2 === 0 &&
    (!format || Number(format.samplingRate) === 0 ||
      (Number(format.samplingRate) === 48000 && format.channels === 0 && format.format === 1));
}

module.exports = { assertContinuousInjection, validMonoPCM };
