// A status, as a rounded pill with a dot (2026 redesign). The tone comes from the status word via
// lib/statusTone unless the screen passes one. The dot is decorative; the word carries the meaning,
// so colour is never the only signal.
import React from 'react';
import { toneForStatus } from '../../lib/statusTone';
import './statusPill.css';

export default function StatusPill({ status, tone, children, dot = true, className = '', title }) {
  const resolved = tone ?? toneForStatus(status);
  return (
    <span className={`state-pill ${className}`} data-tone={resolved} title={title}>
      {dot && <span className="state-pill-dot" aria-hidden="true" />}
      {children ?? status}
    </span>
  );
}
