// The "put this on your home screen" nudge.
//
// WHAT IS AND IS NOT POSSIBLE
// A web app cannot install itself. Chromium fires `beforeinstallprompt`, which App.jsx keeps, and
// replaying it opens the real install dialog — but only from a genuine user gesture, so the most
// this can do is put the button in front of somebody rather than leave it in a browser menu.
// Safari has no install API at all: Add to Home Screen lives in the share sheet, and only a person
// can reach it. So this shows one of two things, and both still end in a tap by the user.
//
// It appears once the app has settled rather than on first paint, sits above the bottom nav, and
// stays gone for a fortnight after a dismissal.
import React, { useEffect, useState } from 'react';
import { Download, X, Share, SquarePlus, Smartphone } from 'lucide-react';
import { installOffer, isIosDevice, installPromptHidden, hideInstallPrompt } from '../lib/pwa';

export default function InstallPrompt({ deferredPrompt, standalone, onInstall }) {
  const [dismissed, setDismissed] = useState(() => installPromptHidden(window.localStorage));
  const [shown, setShown] = useState(false);

  // A beat after arrival. Thrown up during the first paint it reads as an ad; after the dashboard
  // has drawn, it reads as an offer.
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 2500);
    return () => clearTimeout(t);
  }, []);

  const offer = installOffer({
    standalone,
    deferredPrompt,
    ios: isIosDevice(),
  });

  if (dismissed || !shown || offer === 'none') return null;

  const close = () => {
    hideInstallPrompt(window.localStorage);
    setDismissed(true);
  };

  return (
    <div className="install-prompt" role="dialog" aria-labelledby="install-prompt-title">
      <span className="install-prompt-icon"><Smartphone size={18} /></span>

      <div className="install-prompt-copy">
        <strong id="install-prompt-title">Add Parakkat HR to your home screen</strong>
        {offer === 'prompt' ? (
          <em>Opens full screen, starts faster, and keeps working when the signal drops.</em>
        ) : (
          // No API here — the only honest thing is to say where the button is.
          <em className="install-prompt-steps">
            Tap <Share size={12} aria-label="the Share button" /> Share, then
            <SquarePlus size={12} aria-hidden="true" /> <b>Add to Home Screen</b>.
          </em>
        )}
      </div>

      <div className="install-prompt-actions">
        {offer === 'prompt' && (
          <button type="button" className="install-prompt-go" onClick={onInstall}>
            <Download size={13} /> Install
          </button>
        )}
        <button type="button" className="install-prompt-close" onClick={close} aria-label="Not now">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
