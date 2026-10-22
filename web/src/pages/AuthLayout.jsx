// The frame for signing in, resetting and choosing a password (2026 redesign): a forest-green brand
// panel with coral rings beside a white card. On a phone the panel becomes a green band at the top
// and the card slides up over it.
import React from 'react';
import BrandMark from '../components/ui/BrandMark';
import './auth.css';

function BrandLockup() {
  return (
    <div className="auth-lockup">
      <span className="auth-lockup-mark" aria-hidden="true"><BrandMark size={44} title="Parakkat" /></span>
      <span className="auth-lockup-words">
        <strong>PARAKKAT</strong>
        <span>GROUP</span>
        <em>HRMS</em>
      </span>
    </div>
  );
}

export default function AuthLayout({ children, footnote }) {
  return (
    <div className="auth-screen">
      <div className="auth-shell">
        <section className="auth-brand" aria-label="Parakkat HRMS">
          <span className="auth-ring auth-ring-top" aria-hidden="true" />
          <span className="auth-ring auth-ring-bottom" aria-hidden="true" />
          <span className="auth-ring-line auth-ring-line-top" aria-hidden="true" />
          <span className="auth-ring-line auth-ring-line-bottom" aria-hidden="true" />
          <BrandLockup />
          <div className="auth-brand-copy">
            <p className="auth-headline">One workspace <br />for <span>every team.</span></p>
            <p className="auth-tagline">People. Processes. Progress. <br />All in one place.</p>
          </div>
          <p className="auth-brand-foot">Simpler HR. Happier teams. <br />At Parakkat Group.</p>
        </section>

        <main className="auth-main">
          <div className="auth-card">{children}</div>
          {footnote && <p className="auth-footnote">{footnote}</p>}
        </main>
      </div>
    </div>
  );
}
