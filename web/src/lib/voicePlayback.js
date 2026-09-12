let playingVoice = null;

/** A pending play request also owns the slot, so a slow-loading note cannot overlap the next. */
export function claimVoicePlayback(audio) {
  if (playingVoice && playingVoice !== audio) playingVoice.pause();
  playingVoice = audio;
}

export function ownsVoicePlayback(audio) {
  return playingVoice === audio;
}

export function releaseVoicePlayback(audio) {
  if (playingVoice === audio) playingVoice = null;
}

/** Recording uses this too, before opening the microphone. */
export function pauseVoicePlayback() {
  const audio = playingVoice;
  playingVoice = null;
  audio?.pause();
}
