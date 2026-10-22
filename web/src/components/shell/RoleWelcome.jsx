// A short welcome when you switch the role you work as (round 2): the brand, "Welcome, Asha", the
// view you are now in and what changed, then it fades away by itself (or on a tap). It changes
// nothing — the switch has already happened underneath it.
import React, { useEffect } from 'react';
import BrandMark from '../ui/BrandMark';
import './roleWelcome.css';

export const ROLE_WELCOME_MS = 2100;

export default function RoleWelcome({ name, roleTitle, onDone }) {
  useEffect(() => {
    const timer = setTimeout(onDone, ROLE_WELCOME_MS);
    return () => clearTimeout(timer);
  }, [onDone]);
  return (
    <div className="role-welcome" role="status" aria-live="polite" onClick={onDone}>
      <div className="role-welcome-card">
        <span className="role-welcome-mark" aria-hidden="true"><BrandMark size={34} /></span>
        <p className="role-welcome-hello">Welcome{name ? `, ${name}` : ''}</p>
        <h2 className="role-welcome-title">{roleTitle} view</h2>
        <p className="role-welcome-sub">Your menu and Home now show what you work with as {roleTitle}.</p>
        <span className="role-welcome-bar" aria-hidden="true"><span /></span>
      </div>
    </div>
  );
}
