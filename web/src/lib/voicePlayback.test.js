import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimVoicePlayback, ownsVoicePlayback, releaseVoicePlayback, pauseVoicePlayback } from './voicePlayback.js';

test('a second note pauses the previous owner, including one whose play is still pending', () => {
  const first = { pauses: 0, pause() { this.pauses += 1; } };
  const second = { pauses: 0, pause() { this.pauses += 1; } };
  claimVoicePlayback(first);
  claimVoicePlayback(second);
  assert.equal(first.pauses, 1);
  assert.equal(ownsVoicePlayback(first), false);
  assert.equal(ownsVoicePlayback(second), true);
  releaseVoicePlayback(first);
  assert.equal(ownsVoicePlayback(second), true, 'a delayed pause/unmount from the first note cannot release the second');
  pauseVoicePlayback();
  assert.equal(second.pauses, 1);
  assert.equal(ownsVoicePlayback(second), false);
});

test('claiming the same note preserves playback and releasing it never pauses the next note', () => {
  const audio = { pauses: 0, pause() { this.pauses += 1; } };
  claimVoicePlayback(audio);
  claimVoicePlayback(audio);
  assert.equal(audio.pauses, 0);
  releaseVoicePlayback(audio);
  pauseVoicePlayback();
  assert.equal(audio.pauses, 0);
});
