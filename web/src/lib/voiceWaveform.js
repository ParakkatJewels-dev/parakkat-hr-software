export const VOICE_WAVEFORM_BARS = 42;
export const EMPTY_VOICE_WAVEFORM = Array(VOICE_WAVEFORM_BARS).fill(0.08);

/** A small amplitude envelope, keeping stereo channels separate so opposite phases cannot cancel. */
export function voiceWaveform(channels, barCount = VOICE_WAVEFORM_BARS) {
  const count = Number.isFinite(barCount) ? Math.max(1, Math.min(100, Math.floor(barCount))) : VOICE_WAVEFORM_BARS;
  const samples = (channels ?? []).filter((channel) => channel?.length > 0);
  const length = samples.reduce((longest, channel) => Math.max(longest, channel.length), 0);
  if (!length) return Array(count).fill(0.08);

  const levels = Array.from({ length: count }, (_, bar) => {
    const start = Math.floor((bar * length) / count);
    const end = Math.max(start + 1, Math.floor(((bar + 1) * length) / count));
    // Bound the work even for a long recording. This is a visual envelope, not audio processing.
    const stride = Math.max(1, Math.floor((end - start) / 400));
    let sum = 0;
    let inspected = 0;
    for (const channel of samples) {
      for (let index = start; index < Math.min(end, channel.length); index += stride) {
        const value = Number.isFinite(channel[index]) ? channel[index] : 0;
        sum += value * value;
        inspected += 1;
      }
    }
    return inspected ? Math.sqrt(sum / inspected) : 0;
  });
  const highest = Math.max(...levels);
  return levels.map((level) => highest > 0 ? Math.max(0.08, Math.sqrt(level / highest)) : 0.08);
}
