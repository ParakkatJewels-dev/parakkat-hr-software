// The role you are working as, where you can actually see it: in the header, on the chip that
// already tells you which one it is.
//
// This used to be a card most of the way down Settings. That is a long way to travel for something
// you do several times a day, and worse, it hid the answer to "why am I looking at this?" behind
// three clicks — the chip in the corner said HR Manager while the menu said something else, and
// the only place to reconcile them was a screen you had to go and find. The control now lives on
// the thing it changes: read the chip, tap the chip, pick, done.
//
// NOT A PRIVILEGE SWITCH. Nothing here changes what the database will hand over; RLS answers to the
// signed-in user and nothing else. See lib/viewRole.js.
import React, { useEffect, useRef, useState } from 'react';
import { Shield, Check, ChevronDown } from 'lucide-react';
import { appNameFor } from '../../lib/appName';

const pretty = (key) => key.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

export default function RoleSwitcher({ viewRole, trueRole, heldRoles, roleLabel, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const roles = heldRoles ?? [];

  // Close on a click outside or on Escape — the two ways anybody dismisses a menu without meaning
  // to choose something.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // One role is not a choice. Render the same chip, without the affordance to open something that
  // would have a single item in it.
  if (roles.length < 2) {
    return (
      <span className="role-chip is-static" title={roleLabel}>
        <Shield size={11} />
        <span className="role-chip-label">{roleLabel}</span>
      </span>
    );
  }

  return (
    <div className="role-switch" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Working as ${pretty(viewRole)} — tap to switch`}
        className="role-chip"
      >
        <Shield size={11} />
        <span className="role-chip-label">{roleLabel}</span>
        <ChevronDown size={11} className="role-chip-caret" aria-hidden="true" />
      </button>

      {open && (
        <div className="role-menu" role="menu" aria-label="Work as">
          <p className="role-menu-title">Work as</p>
          {roles.map((role) => {
            const active = role === viewRole;
            return (
              <button
                key={role}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  // null means "follow my most senior role" rather than pinning a choice, so a
                  // later promotion is picked up instead of being masked by a stale preference.
                  onChange(role === trueRole ? null : role);
                  setOpen(false);
                }}
                className={active ? 'is-active' : undefined}
              >
                <span className="role-menu-copy">
                  <strong>{pretty(role)}</strong>
                  <em>
                    {appNameFor(role)}
                    {role === trueRole ? ' · your usual view' : ''}
                  </em>
                </span>
                {active && <Check size={13} aria-hidden="true" />}
              </button>
            );
          })}
          <p className="role-menu-foot">
            Changes the menu and the dashboard. Not what you are allowed to see.
          </p>
        </div>
      )}
    </div>
  );
}
