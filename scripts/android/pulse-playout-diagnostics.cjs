'use strict';

// Development-only, independent PulseAudio reference. Never part of the APK or
// product runtime. Only numeric measurements leave this helper; no PCM is saved.
const { spawn } = require('node:child_process');

const RATE = 48000, CHANNELS = 2, FRAME_BYTES = 4, TARGET_FRAMES = RATE * 2;
const SOURCE = 'streamkit_android_capture';

/**
 * Capture exactly two seconds of stereo S16LE from the existing isolated source.
 * mono_sum_rms measures (L + R) / 2; half_difference_rms measures (L - R) / 2.
 * Correlation is mean-centred Pearson correlation, or null for constant channels.
 * This reference never substitutes for the primary four-second probe acceptance.
 */
async function collectPulsePlayoutDiagnostics() {
  const started = Date.now();
  let status = 'unsupported_platform', cleanup = 'not_started', childPid = null;
  let frames = 0, bytes = 0, remainder = Buffer.alloc(0);
  let leftSum = 0, rightSum = 0, leftSquare = 0, rightSquare = 0, cross = 0;
  let sumSquare = 0, differenceSquare = 0, leftPeak = 0, rightPeak = 0;
  if (process.platform === 'linux') {
    let child, closed = false, resolveClosed;
    const closedPromise = new Promise(resolve => { resolveClosed = resolve; });
    const waitForClose = async milliseconds => {
      let timer;
      try {
        await Promise.race([closedPromise, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]);
      } finally { clearTimeout(timer); }
      return closed;
    };
    try {
      status = await new Promise(resolve => {
        let finished = false, timer;
        const finish = result => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          child?.stdout?.pause();
          resolve(result);
        };
        try {
          // Inherit the already isolated PULSE_SERVER; never change defaults,
          // source volume, Android settings, or the primary recorder's route.
          child = spawn('parec', ['--raw', '--format=s16le', '--rate=48000', '--channels=2',
            '--latency-msec=20', '--device=' + SOURCE], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        } catch {
          finish('spawn_failed');
          return;
        }
        childPid = child.pid ?? null;
        child.once('close', () => {
          closed = true;
          resolveClosed();
          finish('capture_ended_early');
        });
        child.once('error', () => finish('spawn_failed'));
        child.stdout.once('error', () => finish('capture_read_failed'));
        child.stdout.on('data', chunk => {
          if (finished) return;
          bytes += chunk.length;
          // Pipe chunk boundaries need not coincide with stereo sample frames.
          // Retain at most three bytes between callbacks, never the recording.
          const data = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
          const count = Math.min(Math.floor(data.length / FRAME_BYTES), TARGET_FRAMES - frames);
          for (let index = 0; index < count; ++index) {
            const offset = index * FRAME_BYTES;
            const left = data.readInt16LE(offset) / 32768, right = data.readInt16LE(offset + 2) / 32768;
            leftSum += left; rightSum += right;
            leftSquare += left * left; rightSquare += right * right; cross += left * right;
            sumSquare += ((left + right) / 2) ** 2;
            differenceSquare += ((left - right) / 2) ** 2;
            leftPeak = Math.max(leftPeak, Math.abs(left)); rightPeak = Math.max(rightPeak, Math.abs(right));
          }
          frames += count;
          remainder = frames === TARGET_FRAMES ? Buffer.alloc(0) : Buffer.from(data.subarray(count * FRAME_BYTES));
          if (frames === TARGET_FRAMES) finish('complete');
        });
        timer = setTimeout(() => finish('capture_timeout'), 5000);
      });
    } finally {
      // Only signal the ChildProcess created here. Cleanup remains bounded even
      // when the source/server fails or parec does not accept a normal stop.
      if (child) {
        if (closed) cleanup = 'closed';
        else {
          try { child.kill('SIGTERM'); } catch {}
          child.stdout?.destroy();
          if (await waitForClose(500)) cleanup = 'terminated';
          else {
            try { child.kill('SIGKILL'); } catch {}
            cleanup = await waitForClose(500) ? 'killed' : 'failed';
            if (!closed) child.unref();
          }
        }
      }
      remainder = Buffer.alloc(0);
    }
  }
  const leftVariance = frames ? Math.max(0, leftSquare - leftSum * leftSum / frames) : 0;
  const rightVariance = frames ? Math.max(0, rightSquare - rightSum * rightSum / frames) : 0;
  const correlation = leftVariance > 0 && rightVariance > 0
    ? Math.max(-1, Math.min(1, (cross - leftSum * rightSum / frames) / Math.sqrt(leftVariance * rightVariance))) : null;
  return {
    diagnostic_only: true,
    status: cleanup === 'failed' ? 'cleanup_failed' : status,
    capture_status: status,
    cleanup,
    source: SOURCE,
    child_pid: childPid,
    sample_rate: RATE,
    channels: CHANNELS,
    bits_per_sample: 16,
    requested_frames: TARGET_FRAMES,
    bytes_received: bytes,
    analyzed_bytes: frames * FRAME_BYTES,
    analyzed_frames: frames,
    elapsed_ms: Date.now() - started,
    left_rms: frames ? Math.sqrt(leftSquare / frames) : null,
    right_rms: frames ? Math.sqrt(rightSquare / frames) : null,
    left_peak: frames ? leftPeak : null,
    right_peak: frames ? rightPeak : null,
    mono_sum_rms: frames ? Math.sqrt(sumSquare / frames) : null,
    half_difference_rms: frames ? Math.sqrt(differenceSquare / frames) : null,
    left_right_correlation: correlation
  };
}

module.exports = { collectPulsePlayoutDiagnostics };
