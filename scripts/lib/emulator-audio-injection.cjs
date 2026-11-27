'use strict';

const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {setTimeout: delay} = require('node:timers/promises');

const RATE = 48000;
const FREQUENCY = 1499;
const PACKET_MS = 20;
const FRAMES = RATE * PACKET_MS / 1000;

// Both the independent recorder and the signed APK receive the same PCM.
function startToneInjection(client, metadata, source, {pulseSink} = {}) {
  source.started_at_ms = Date.now();
  const writes = new AbortController();
  let sending = true, stream, push, cancel, pid;
  const finished = new Promise(resolve => {
    const complete = error => {
      if (source.transportEnded) return;
      source.error = error;
      source.transportEnded = true;
      writes.abort();
      resolve();
    };
    if (pulseSink) {
      const player = spawn('pacat', ['--playback', '--raw', `--device=${pulseSink}`, `--rate=${RATE}`,
        '--channels=1', '--format=s16le', '--latency-msec=40'], {stdio: ['pipe', 'ignore', 'ignore'], timeout: 35000});
      pid = player.pid;
      stream = player.stdin;
      push = audio => stream.write(audio);
      cancel = () => player.kill();
      player.on('error', error => complete(error.code || 'pulse_start_failed'));
      player.once('close', code => complete(code === 0 ? undefined : 'pulse_playback_failed'));
    } else {
      const call = client.injectAudio(metadata, {deadline: Date.now() + 35000}, error => complete(error?.code));
      stream = call;
      push = audio => call.write({format: {samplingRate: String(RATE), channels: 0, format: 1, mode: 1},
        timestamp: String(Date.now() * 1000), audio});
      cancel = () => call.cancel();
    }
    stream.on('error', () => {}); // Completion owns transport status.
  });
  const sender = (async () => {
    try {
      while (sending && source.packets < 1500) {
        if (source.transportEnded) throw Error('Synthetic microphone transport ended while sending');
        const audio = Buffer.alloc(FRAMES * 2);
        const sampleOffset = source.packets * FRAMES;
        for (let i = 0; i < FRAMES; i++) {
          const phase = 2 * Math.PI * FREQUENCY * (sampleOffset + i) / RATE;
          audio.writeInt16LE(Math.round(32767 * Math.pow(10, -18 / 20) * Math.sin(phase)), i * 2);
        }
        const writable = push(audio);
        source.packets++;
        source.last_packet_at_ms = Date.now();
        if (!writable) await once(stream, 'drain', {signal: writes.signal});
        // PulseAudio's writable buffer provides the playback clock. The RPC
        // real-time mode instead needs client pacing to avoid overwrites.
        if (!pulseSink) await delay(Math.max(0, source.started_at_ms + source.packets * PACKET_MS - Date.now()));
      }
    } catch (error) {
      if (sending || error.name !== 'AbortError') throw error;
    } finally {
      source.senderEnded = true;
      if (!source.transportEnded) stream.end();
    }
  })();
  void sender.catch(() => {}); // The owner awaits the result at completion.
  return {
    pid,
    async finish() {
      sending = false;
      writes.abort();
      await sender;
      await finished;
      assert.equal(source.error, undefined, 'Synthetic microphone transport failed');
    },
    async cancel() {
      sending = false;
      writes.abort();
      if (!source.transportEnded) cancel();
      await sender.catch(() => {});
      await finished;
    },
  };
}

module.exports = {startToneInjection, RATE, FREQUENCY};
