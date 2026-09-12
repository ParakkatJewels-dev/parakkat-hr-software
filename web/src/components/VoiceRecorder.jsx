import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Pause, Send, Square, Trash2, X } from 'lucide-react';
import { createVoiceRecording } from '../lib/voiceRecording';
import { formatVoiceDuration } from '../lib/conversations';
import { pauseVoicePlayback } from '../lib/voicePlayback';
import './voiceRecorder.css';

const EMPTY_LEVELS = Array(40).fill(0.06);

export default function VoiceRecorder({ disabled, onRecorded, onError, onActiveChange }) {
  const [status, setStatus] = useState('idle');
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState(EMPTY_LEVELS);
  const sessionRef = useRef(null);
  const startButtonRef = useRef(null);
  const activeButtonRef = useRef(null);
  const previousStatusRef = useRef('idle');
  const callbacksRef = useRef({ onRecorded, onError, onActiveChange });
  callbacksRef.current = { onRecorded, onError, onActiveChange };
  const active = status !== 'idle';
  const waiting = status === 'requesting' || status === 'stopping';
  const paused = status === 'paused';

  useEffect(() => () => sessionRef.current?.dispose(), []);

  useEffect(() => {
    if (status === 'idle' && previousStatusRef.current !== 'idle') startButtonRef.current?.focus();
    if (status === 'requesting' || (status === 'recording' && previousStatusRef.current === 'requesting')) {
      activeButtonRef.current?.focus();
    }
    previousStatusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (status !== 'recording' && status !== 'paused') return;
    const timer = setInterval(() => setElapsed(sessionRef.current?.elapsedMs() ?? 0), 100);
    return () => clearInterval(timer);
  }, [status]);

  // Draw measured microphone levels. The analyser has no connection to the speakers.
  useEffect(() => {
    const stream = sessionRef.current?.stream;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (status !== 'recording' || !stream || !AudioContext) return;
    let context, source, timer;
    try {
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      context.resume().catch(() => {});
      timer = setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
        setLevels((previous) => [...previous.slice(1), Math.max(0.06, level)]);
      }, 100);
    } catch { /* Recording remains available when audio analysis is unsupported. */ }
    return () => {
      clearInterval(timer);
      source?.disconnect();
      context?.close().catch(() => {});
    };
  }, [status]);

  const start = () => {
    if (disabled || (sessionRef.current && sessionRef.current.status !== 'idle')) return;
    pauseVoicePlayback();
    callbacksRef.current.onError(null);
    setElapsed(0);
    setLevels(EMPTY_LEVELS);
    sessionRef.current?.dispose();
    const session = createVoiceRecording({
      onChange(next) {
        setStatus(next);
        callbacksRef.current.onActiveChange?.(next !== 'idle');
      },
      onReady(file, durationMs, options) {
        callbacksRef.current.onRecorded(file, durationMs, options);
      },
      onError(message) { callbacksRef.current.onError(new Error(message)); },
    });
    sessionRef.current = session;
    session.start();
  };

  if (!active) {
    return <button ref={startButtonRef} type="button" onClick={start} disabled={disabled} className="messages-voice"
      aria-label="Record a voice note" title="Voice note"><Mic size={21} /></button>;
  }

  return (
    <div className="voice-recorder" data-paused={paused ? 'true' : 'false'} aria-label="Voice recording"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); sessionRef.current?.cancel(); }
      }}>
      {status === 'requesting' ? <div className="voice-recorder-permission">
        <Loader2 size={20} className="animate-spin" aria-hidden="true" />
        <span role="status">Allow microphone access to start recording</span>
        <button ref={activeButtonRef} type="button" className="messages-icon-button" aria-label="Cancel microphone request"
          onClick={() => sessionRef.current?.cancel()}><X size={20} /></button>
      </div> : <>
        <div className="voice-recorder-meter">
          <Mic size={18} className="voice-recorder-mic" aria-hidden="true" />
          <span className="voice-recorder-time" aria-label="Recording duration">{formatVoiceDuration(elapsed)}</span>
          <div className="voice-recorder-wave" aria-hidden="true">
            {levels.map((level, index) => <span key={index} style={{ height: `${3 + level * 27}px` }} />)}
          </div>
        </div>
        <div className="voice-recorder-actions">
          <button type="button" className="messages-icon-button voice-recorder-delete" aria-label="Delete recording"
            disabled={status === 'stopping'} onClick={() => sessionRef.current?.cancel()}><Trash2 size={21} /></button>
          <span className="voice-recorder-status" role="status">{status === 'stopping' ? 'Preparing voice note…' : paused ? 'Recording paused' : 'Recording…'}</span>
          <button ref={activeButtonRef} type="button" className="voice-recorder-pause" disabled={waiting}
            aria-label={paused ? 'Resume recording' : 'Pause recording'} title={paused ? 'Resume recording' : 'Pause recording'}
            onClick={() => paused ? sessionRef.current?.resume() : sessionRef.current?.pause()}>
            {paused ? <Mic size={21} /> : <Pause size={21} fill="currentColor" />}
          </button>
          <button type="button" className="messages-icon-button voice-recorder-preview" disabled={waiting}
            aria-label="Preview voice note" title="Stop and preview" onClick={() => sessionRef.current?.finish(false)}>
            <Square size={18} fill="currentColor" />
          </button>
          <button type="button" className="messages-send" disabled={waiting} aria-label="Send voice note" title="Send voice note"
            onClick={() => sessionRef.current?.finish(true)}>
            {status === 'stopping' ? <Loader2 size={21} className="animate-spin" /> : <Send size={21} fill="currentColor" />}
          </button>
        </div>
      </>}
    </div>
  );
}
