import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Mic, Pause, Play, RotateCcw } from 'lucide-react';
import { formatVoiceDuration, playbackFraction } from '../lib/conversations';
import { EMPTY_VOICE_WAVEFORM, voiceWaveform } from '../lib/voiceWaveform';
import { claimVoicePlayback, ownsVoicePlayback, releaseVoicePlayback } from '../lib/voicePlayback';
import './voiceNote.css';

export default function VoiceNote(props) {
  // A refreshed signed URL is a new media source. Remount so pending playback and decoding from
  // the old URL cannot update the next source's controls.
  return <VoiceNotePlayer key={props.url} {...props} />;
}

function VoiceNotePlayer({ url, durationMs, mine = false, compact = false, disabled = false, peaks }) {
  const audioRef = useRef(null);
  const decodeRef = useRef(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(false);
  const pendingSeekRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [current, setCurrent] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(NaN);
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);
  const [decodedPeaks, setDecodedPeaks] = useState(null);
  const bars = useMemo(() => {
    const source = peaks?.length ? peaks : decodedPeaks;
    return source?.length ? Array.from(source, (peak) => Number.isFinite(peak) ? Math.max(0.08, Math.min(1, peak)) : 0.08) : EMPTY_VOICE_WAVEFORM;
  }, [peaks, decodedPeaks]);
  const knownMs = Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration * 1000 : durationMs;
  const fraction = playbackFraction(current, mediaDuration, durationMs);
  const active = playing || loading;

  useEffect(() => {
    mountedRef.current = true;
    const audio = audioRef.current;
    // React's development StrictMode re-runs setup after cleanup on the same element.
    if (audio && url && !audio.getAttribute('src')) audio.setAttribute('src', url);
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      decodeRef.current?.abort();
      decodeRef.current = null;
      audio?.pause();
      // Release the media resource; the caller owns and revokes any passed blob URL.
      audio?.removeAttribute('src');
      audio?.load();
      releaseVoicePlayback(audio);
    };
  }, [url]);

  useEffect(() => {
    if (disabled) {
      requestRef.current += 1;
      audioRef.current?.pause();
      setPlaying(false);
      setLoading(false);
    }
  }, [disabled]);

  const loadWaveform = useCallback(async () => {
    if (peaks?.length || decodeRef.current) return;
    // Download/decode only after the listener presses play, so scrolling past a conversation
    // never downloads every voice note. Unsupported decoders retain the quiet, neutral bars.
    const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineContext) return;
    const controller = new AbortController();
    decodeRef.current = controller;
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('Audio download failed');
      const context = new OfflineContext(1, 1, 8000);
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      if (controller.signal.aborted || !mountedRef.current) return;
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
      setDecodedPeaks(voiceWaveform(channels));
      if (Number.isFinite(buffer.duration) && buffer.duration > 0) setMediaDuration(buffer.duration);
    } catch {
      // A missing waveform must never prevent an otherwise playable note from playing.
      if (!controller.signal.aborted) decodeRef.current = null;
    }
  }, [peaks, url]);

  useEffect(() => {
    // A local draft already lives on this device: show its waveform while the sender reviews it.
    if (compact && url?.startsWith('blob:')) void loadWaveform();
  }, [compact, url, loadWaveform]);

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio || disabled) return;
    if (!audio.paused || loading) {
      requestRef.current += 1;
      audio.pause();
      setLoading(false);
      releaseVoicePlayback(audio);
      return;
    }
    claimVoicePlayback(audio);
    const request = ++requestRef.current;
    setFailed(false);
    setLoading(true);
    if (audio.error) audio.load();
    audio.playbackRate = rate;
    try {
      // Keep play() directly in the click handler for Safari's user-activation requirement.
      const started = audio.play();
      void loadWaveform();
      await started;
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    } catch (error) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setLoading(false);
      setPlaying(false);
      releaseVoicePlayback(audio);
      if (error?.name !== 'AbortError') setFailed(true);
    }
  };

  const seek = (event) => {
    const audio = audioRef.current;
    const total = (knownMs ?? 0) / 1000;
    if (!audio || !Number.isFinite(total) || total <= 0) return;
    const next = (Number(event.target.value) / 1000) * total;
    setCurrent(next);
    if (!audio.readyState) {
      pendingSeekRef.current = next;
      audio.load();
      return;
    }
    try { audio.currentTime = next; }
    catch { pendingSeekRef.current = next; }
  };

  const metadata = (event) => {
    const audio = event.currentTarget;
    if (Number.isFinite(audio.duration) && audio.duration > 0) setMediaDuration(audio.duration);
    if (pendingSeekRef.current !== null) {
      try {
        audio.currentTime = pendingSeekRef.current;
        pendingSeekRef.current = null;
      } catch { /* Some streamed containers become seekable only once playback starts. */ }
    }
  };

  const changeRate = () => {
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
    if (audioRef.current) audioRef.current.playbackRate = next;
    setRate(next);
  };

  const wave = bars.map((height, index) => (
    <rect key={index} x={index * 4 + 0.5} y={20 - height * 17} width={2.5} height={Math.max(3, height * 34)} rx={1.25} />
  ));

  return (
    <div className="voice-note" data-own={mine} data-compact={compact} data-playing={active} data-disabled={disabled}>
      <audio
        ref={audioRef}
        src={url}
        preload="none"
        onPlay={(event) => {
          if (!ownsVoicePlayback(event.currentTarget)) { event.currentTarget.pause(); return; }
          setPlaying(true);
        }}
        onPlaying={() => setLoading(false)}
        onWaiting={() => { if (ownsVoicePlayback(audioRef.current)) setLoading(true); }}
        onPause={() => {
          setPlaying(false);
          setLoading(false);
          releaseVoicePlayback(audioRef.current);
        }}
        onEnded={() => {
          setPlaying(false);
          setLoading(false);
          setCurrent(0);
          releaseVoicePlayback(audioRef.current);
        }}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onLoadedMetadata={metadata}
        onDurationChange={metadata}
        onCanPlay={metadata}
        onError={() => { setFailed(true); setLoading(false); setPlaying(false); }}
      />
      <button type="button" className="voice-note-toggle" onClick={toggle} disabled={disabled || !url}
        aria-label={failed ? 'Retry voice note' : active ? 'Pause voice note' : 'Play voice note'} title={failed ? 'Retry' : active ? 'Pause' : 'Play'}>
        {loading ? <Loader2 size={25} className="voice-note-spinner" aria-hidden="true" />
          : failed ? <RotateCcw size={23} aria-hidden="true" />
          : playing ? <Pause size={25} fill="currentColor" aria-hidden="true" /> : <Play size={25} fill="currentColor" aria-hidden="true" />}
      </button>
      <div className="voice-note-body">
        <div className="voice-note-waveform" style={{ '--voice-progress': `${fraction * 100}%` }}>
          <svg className="voice-note-wave voice-note-wave-rest" viewBox={`0 0 ${bars.length * 4} 40`} preserveAspectRatio="none" aria-hidden="true">{wave}</svg>
          <svg className="voice-note-wave voice-note-wave-played" viewBox={`0 0 ${bars.length * 4} 40`} preserveAspectRatio="none" aria-hidden="true">{wave}</svg>
          <input type="range" className="voice-note-range" min={0} max={1000} step={1}
            value={Math.round(fraction * 1000)} onChange={seek} disabled={disabled || !knownMs || failed}
            aria-label="Voice note position" aria-valuetext={`${formatVoiceDuration(current * 1000)} of ${formatVoiceDuration(knownMs)}`} />
        </div>
        <div className="voice-note-details">
          <span className="voice-note-time">{formatVoiceDuration(current * 1000)}</span>
          <span className="voice-note-length"><Mic size={11} aria-hidden="true" />{formatVoiceDuration(knownMs)}</span>
        </div>
      </div>
      <button type="button" className="voice-note-rate" onClick={changeRate} disabled={disabled}
        aria-label={`Playback speed ${rate} times. Change to ${rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1} times.`} title="Change playback speed">{rate}×</button>
      {loading && <span className="voice-note-status" role="status">Loading audio…</span>}
      {failed && <p className="voice-note-failed" role="status"><AlertTriangle size={13} aria-hidden="true" />Unable to play this voice note. Tap retry.</p>}
    </div>
  );
}
