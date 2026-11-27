'use strict';

const assert = require('node:assert/strict');
const {once} = require('node:events');
const {setTimeout: delay} = require('node:timers/promises');

const RATE = 48000;
const FREQUENCY = 1499;
const PACKET_MS = 20;
const FRAMES = RATE * PACKET_MS / 1000;

// Both the independent guest recorder and the signed APK receive the same
// synthetic PCM through the official emulator API. No host input is sampled.
function startToneInjection(client, metadata, source) {
  source.started_at_ms = Date.now();
  const writes = new AbortController();
  let sending = true, call;
  const finished = new Promise(resolve => {
    call = client.injectAudio(metadata, {deadline: Date.now() + 35000}, error => {
      source.error = error?.code;
      source.rpcEnded = true;
      writes.abort();
      resolve();
    });
    call.on('error', () => {}); // The RPC callback owns transport status.
  });
  const sender = (async () => {
    try {
      while (sending && source.packets < 1500) {
        if (source.rpcEnded) throw Error('Official microphone injection ended while sending');
        const audio = Buffer.alloc(FRAMES * 2);
        const sampleOffset = source.packets * FRAMES;
        for (let i = 0; i < FRAMES; i++) {
          const phase = 2 * Math.PI * FREQUENCY * (sampleOffset + i) / RATE;
          audio.writeInt16LE(Math.round(32767 * Math.pow(10, -18 / 20) * Math.sin(phase)), i * 2);
        }
        const writable = call.write({format: {samplingRate: String(RATE), channels: 0, format: 1, mode: 1},
          timestamp: String(Date.now() * 1000), audio});
        source.packets++;
        source.last_packet_at_ms = Date.now();
        if (!writable) await once(call, 'drain', {signal: writes.signal});
        await delay(Math.max(0, source.started_at_ms + source.packets * PACKET_MS - Date.now()));
      }
    } catch (error) {
      if (sending || error.name !== 'AbortError') throw error;
    } finally {
      source.senderEnded = true;
      if (!source.rpcEnded) call.end();
    }
  })();
  void sender.catch(() => {}); // The owner awaits the result at completion.
  return {
    async finish() {
      sending = false;
      writes.abort();
      await sender;
      await finished;
      assert.equal(source.error, undefined, 'Official microphone injection failed');
    },
    async cancel() {
      sending = false;
      writes.abort();
      if (!source.rpcEnded) call.cancel();
      await sender.catch(() => {});
      await finished;
    },
  };
}

module.exports = {startToneInjection, RATE, FREQUENCY};
