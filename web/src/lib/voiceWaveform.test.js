import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceWaveform, VOICE_WAVEFORM_BARS } from './voiceWaveform.js';

test('silent and missing audio use a quiet, finite baseline', () => {
  for (const channels of [[], [new Float32Array(16)], [new Float32Array([NaN, Infinity])]]) {
    const result = voiceWaveform(channels);
    assert.equal(result.length, VOICE_WAVEFORM_BARS);
    assert.ok(result.every((value) => value === 0.08));
  }
});

test('the waveform preserves quiet and loud portions through the end of a recording', () => {
  const result = voiceWaveform([new Float32Array([0, 0, 0.05, 0.05, 0.25, 0.25, 1, 1])], 4);
  assert.equal(result[0], 0.08);
  assert.ok(result[0] < result[1] && result[1] < result[2] && result[2] < result[3]);
  assert.equal(result[3], 1);
});

test('stereo audio in opposite phases remains visible', () => {
  const mono = voiceWaveform([new Float32Array([0, 0.1, 0.4, 1])], 4);
  const stereo = voiceWaveform([new Float32Array([0, 0.1, 0.4, 1]), new Float32Array([0, -0.1, -0.4, -1])], 4);
  assert.deepEqual(stereo, mono);
});

test('very short audio fills every bar without NaN or unbounded amplitude', () => {
  const result = voiceWaveform([new Float32Array([1])]);
  assert.equal(result.length, VOICE_WAVEFORM_BARS);
  assert.ok(result.every((value) => value === 1));
});
