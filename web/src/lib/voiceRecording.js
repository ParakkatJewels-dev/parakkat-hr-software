const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];

function errorMessage(error) {
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name)) {
    return 'Microphone access was refused. Allow it in your browser settings to send a voice note.';
  }
  if (['NotFoundError', 'DevicesNotFoundError'].includes(error?.name)) {
    return 'No microphone was found. Connect a microphone and try again.';
  }
  if (['NotReadableError', 'TrackStartError'].includes(error?.name)) {
    return 'Your microphone is unavailable. Close other apps using it and try again.';
  }
  return 'Could not record your voice note. Please try again.';
}

function extensionFor(mimeType) {
  const baseType = mimeType.split(';')[0].trim().toLowerCase();
  return {
    'audio/webm': 'webm',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mpeg': 'mp3',
  }[baseType] || 'audio';
}

/**
 * Owns one microphone recording at a time, including a pending permission request.
 * Browser dependencies can be supplied for tests. Call dispose() on unmount.
 * onReady runs only after the recorder's final data event and microphone cleanup.
 */
export function createVoiceRecording(
  { onChange, onReady, onError, maxBytes = DEFAULT_MAX_BYTES } = {},
  dependencies = {},
) {
  const mediaDevices = dependencies.mediaDevices ?? globalThis.navigator?.mediaDevices;
  const Recorder = dependencies.MediaRecorder ?? globalThis.MediaRecorder;
  const FileClass = dependencies.File ?? globalThis.File;
  const BlobClass = dependencies.Blob ?? globalThis.Blob;
  const now = dependencies.now ?? (() => performance.now());
  let status = 'idle';
  let current = null;
  let disposed = false;

  function change(nextStatus) {
    if (status === nextStatus) return;
    status = nextStatus;
    if (!disposed) onChange?.(status);
  }

  function isCurrent(recording) {
    return !disposed && current === recording && !recording.cancelled;
  }

  function stopTracks(recording) {
    const stream = recording.stream;
    recording.stream = null;
    for (const track of stream?.getTracks() || []) {
      try { track.stop(); } catch { /* Other tracks still need to be released. */ }
    }
  }

  function release(recording, stopRecorder = false) {
    const recorder = recording.recorder;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (stopRecorder && recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* Always release the microphone below. */ }
      }
    }
    stopTracks(recording);
    recording.recorder = null;
    recording.chunks = [];
  }

  function freezeTime(recording) {
    if (recording.activeSince !== null) {
      recording.durationMs += Math.max(0, now() - recording.activeSince);
      recording.activeSince = null;
    }
  }

  function fail(recording, message) {
    if (!isCurrent(recording)) return;
    recording.cancelled = true;
    release(recording, true);
    current = null;
    change('idle');
    if (!disposed) onError?.(message);
  }

  function ready(recording) {
    if (!isCurrent(recording)) return;
    freezeTime(recording);
    if (!recording.bytes) {
      fail(recording, 'No audio was recorded. Please try again.');
      return;
    }

    let file;
    try {
      const mimeType = recording.recorder.mimeType
        || recording.chunks.find(chunk => chunk.type)?.type
        || recording.mimeType;
      const blob = new BlobClass(recording.chunks, { type: mimeType });
      file = new FileClass([blob], `voice-${Date.now()}.${extensionFor(mimeType)}`, { type: mimeType });
    } catch {
      fail(recording, 'Could not prepare your voice note. Please try again.');
      return;
    }

    const { durationMs, sendImmediately } = recording;
    release(recording);
    current = null;
    change('idle');
    // Keep fractional timing internally, but persist only whole milliseconds.
    if (!disposed) onReady?.(file, Math.round(durationMs), { sendImmediately });
  }

  async function start() {
    if (disposed || status !== 'idle') return false;
    if (!mediaDevices?.getUserMedia || !Recorder || !FileClass || !BlobClass) {
      onError?.('Voice recording is not supported in this browser. Try a supported browser over HTTPS.');
      return false;
    }
    const recording = {
      cancelled: false,
      stream: null,
      recorder: null,
      chunks: [],
      bytes: 0,
      durationMs: 0,
      activeSince: null,
      sendImmediately: false,
      mimeType: '',
    };
    current = recording;
    change('requesting');
    try {
      // Ask directly so the browser can present its microphone permission prompt.
      recording.stream = await mediaDevices.getUserMedia({ audio: true });
      if (!isCurrent(recording)) {
        stopTracks(recording);
        return false;
      }
      recording.mimeType = typeof Recorder.isTypeSupported === 'function'
        ? MIME_TYPES.find(type => Recorder.isTypeSupported(type)) || ''
        : '';
      const recorder = new Recorder(recording.stream, recording.mimeType ? { mimeType: recording.mimeType } : undefined);
      recording.recorder = recorder;
      recorder.ondataavailable = event => {
        if (!isCurrent(recording) || !event.data?.size) return;
        recording.bytes += event.data.size;
        if (recording.bytes > maxBytes) {
          fail(recording, 'Your voice note is too large. Please record a shorter message.');
          return;
        }
        recording.chunks.push(event.data);
      };
      recorder.onerror = event => fail(recording, errorMessage(event.error));
      recorder.onstop = () => ready(recording);
      recorder.start(1000);
      // Some browser errors can dispatch synchronously from start().
      if (!isCurrent(recording)) return false;
      recording.activeSince = now();
      change('recording');
      return true;
    } catch (error) {
      fail(recording, errorMessage(error));
      return false;
    }
  }

  function pause() {
    if (disposed || status !== 'recording' || !current) return false;
    const recording = current;
    try {
      recording.recorder.pause();
      freezeTime(recording);
      change('paused');
      return true;
    } catch (error) {
      fail(recording, errorMessage(error));
      return false;
    }
  }

  function resume() {
    if (disposed || status !== 'paused' || !current) return false;
    const recording = current;
    try {
      recording.recorder.resume();
      recording.activeSince = now();
      change('recording');
      return true;
    } catch (error) {
      fail(recording, errorMessage(error));
      return false;
    }
  }

  function finish(sendImmediately = false) {
    if (disposed || !['recording', 'paused'].includes(status) || !current) return false;
    const recording = current;
    recording.sendImmediately = Boolean(sendImmediately);
    freezeTime(recording);
    change('stopping');
    try {
      // An inactive recorder can already have its final data/stop events queued.
      if (recording.recorder.state !== 'inactive') recording.recorder.stop();
      return true;
    } catch (error) {
      fail(recording, errorMessage(error));
      return false;
    }
  }

  function cancel() {
    if (current) {
      current.cancelled = true;
      release(current, true);
      current = null;
    }
    change('idle');
  }

  return {
    start,
    pause,
    resume,
    finish,
    cancel,
    dispose() {
      disposed = true;
      cancel();
    },
    elapsedMs() {
      if (!current) return 0;
      return current.durationMs + (current.activeSince === null ? 0 : Math.max(0, now() - current.activeSince));
    },
    get status() { return status; },
    get stream() { return current?.stream ?? null; },
  };
}
