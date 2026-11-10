'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createToneMetrics } = require('./emulator-playout-observation.cjs');

test('actual S16 bytes retain tone amplitude across arbitrary packet boundaries', () => {
  const pcm = Buffer.alloc(48000 * 2);
  for (let index = 0; index < 48000; index++)
    pcm.writeInt16LE(Math.round(0.08 * 32767 * Math.sin(2 * Math.PI * 997 * index / 48000)), index * 2);
  const metrics = createToneMetrics();
  for (let offset = 0; offset < pcm.length; offset += 127) metrics.consume(pcm.subarray(offset, offset+127));
  const result = metrics.result();
  assert.equal(result.frames, 48000); assert.equal(result.windows.length, 10);
  assert.equal(result.incomplete_sample_bytes, 0); assert.equal(result.partial_window_frames, 0);
  for (const window of result.windows) {
    assert.ok(Math.abs(window.program_997_amplitude-0.08) < 0.0002);
    assert.ok(Math.abs(window.rms-0.08/Math.sqrt(2)) < 0.0002);
  }
  assert.ok(Math.abs(result.program_997_median-0.08) < 0.0002);
});

test('empty and silent input cannot become a positive tone observation; memory is bounded', () => {
  const metrics = createToneMetrics();
  assert.equal(metrics.result().program_997_median, null);
  metrics.consume(Buffer.alloc(480000 * 2 - 1));
  assert.equal(metrics.result().incomplete_sample_bytes, 1);
  metrics.consume(Buffer.alloc(1));
  assert.equal(metrics.result().program_997_median, 0);
  assert.equal(metrics.result().windows.length, 100);
  assert.throws(() => metrics.consume(Buffer.alloc(2)), /AUDIO_OBSERVATION_LIMIT/);
});
