'use strict';

// Development-only QEMU output observation through the official emulator RPC.
// Keep only bounded numeric aggregates; never retain PCM or replace the native
// PulseAudio acceptance with this diagnostic. No input or volume state changes.
const RATE = 48000, WINDOW = 4800, MAX_FRAMES = RATE * 10;

function createToneMetrics() {
  let frames = 0, count = 0, square = 0, peak = 0, real = 0, imaginary = 0;
  let remainder = null;
  const windows = [];
  return {
    consume(bytes) {
      if (!Buffer.isBuffer(bytes)) throw Error('INVALID_AUDIO_BYTES');
      if (frames + Math.floor((bytes.length + (remainder === null ? 0 : 1)) / 2) > MAX_FRAMES)
        throw Error('AUDIO_OBSERVATION_LIMIT');
      const data = remainder === null ? bytes : Buffer.concat([Buffer.from([remainder]), bytes]);
      let offset = 0;
      for (; offset + 1 < data.length; offset += 2) {
        const value = data.readInt16LE(offset) / 32768;
        const angle = 2 * Math.PI * 997 * count / RATE;
        real += value * Math.cos(angle); imaginary += value * Math.sin(angle);
        square += value * value; peak = Math.max(peak, Math.abs(value));
        frames++; count++;
        if (count === WINDOW) {
          windows.push({ frames: count, program_997_amplitude: 2 * Math.hypot(real, imaginary) / count,
            rms: Math.sqrt(square / count), peak });
          count = 0; square = 0; peak = 0; real = 0; imaginary = 0;
        }
      }
      remainder = offset < data.length ? data[offset] : null;
    },
    result() {
      const amplitudes = windows.map(window => window.program_997_amplitude).sort((a,b) => a-b);
      const middle = Math.floor(amplitudes.length / 2);
      return { frames, partial_window_frames: count, incomplete_sample_bytes: remainder === null ? 0 : 1,
        program_997_median: amplitudes.length ? (amplitudes[middle] + amplitudes[Math.floor((amplitudes.length-1)/2)]) / 2 : null,
        windows: windows.map(window => ({ ...window })) };
    },
  };
}

function observeEmulatorPlayout(client, metadata) {
  const metrics = createToneMetrics();
  const started = Date.now();
  let ended = false, canceled = false, rpcError = null, failure = null, resolveEnded;
  const finished = new Promise(resolve => { resolveEnded = resolve; });
  const stream = client.streamAudio({ samplingRate: String(RATE), channels: 0, format: 1 },
    metadata, { deadline: started + 7000 });
  stream.on('data', packet => {
    if (canceled || failure) return;
    try {
      if (Number(packet.format?.samplingRate) !== RATE || packet.format?.channels !== 0 || packet.format?.format !== 1)
        throw Error('UNEXPECTED_AUDIO_FORMAT');
      metrics.consume(packet.audio);
    } catch (error) { failure = error.message; canceled = true; stream.cancel(); }
  });
  stream.on('error', error => { if (!(canceled && error.code === 1)) rpcError = Number.isInteger(error.code) ? error.code : -1; });
  stream.on('end', () => { ended = true; resolveEnded(); });
  return async () => {
    const stopped = Date.now();
    canceled = true; stream.cancel();
    let timer;
    try { await Promise.race([finished, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); }
    finally { clearTimeout(timer); }
    return { diagnostic_only: true, source: 'Official emulator streamAudio; not application pre-write PCM',
      started_at_ms: started, stopped_at_ms: stopped, sample_rate: RATE, channels: 1, format: 'S16LE',
      rpc_error_code: rpcError, failure, stream_ended: ended, pcm_saved: false, ...metrics.result() };
  };
}

module.exports = { createToneMetrics, observeEmulatorPlayout };
