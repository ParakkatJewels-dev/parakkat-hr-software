// Settings: Google Calendar for reminders, the chime, and the keyboard shortcuts.
import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { CalendarCheck } from 'lucide-react';
import { connectGoogleCalendar, disconnectGoogleCalendar, syncGoogleCalendar, useGoogleStatus, useRefreshLedger } from '../../data/workLedger';
import { readSound, saveSound } from '../../data/work';
import { humanDbError } from '../../lib/dbErrors';
import { SHORTCUTS, chime, dateLabel } from './ui';
import { btnClass } from '../ui/Btn';

export default function LedgerSettings() {
  return (
    <div className="ledger-settings">
      <GoogleSection />
      <SoundSection />
      <section className="ledger-section">
        <h3>What Home points out</h3>
        <ul className="ledger-list ledger-list-compact">
          <li><strong>Overdue</strong> — your open tasks past their due date.</li>
          <li><strong>Stale</strong> — a task that has not moved for 7 days.</li>
          <li><strong>Too much in progress</strong> — a warning when more than 3 of your tasks are in progress at once.</li>
          <li><strong>Waiting for your approval</strong> — when someone sends you work for approval you get a notification; when you ask for changes or approve, they do.</li>
        </ul>
      </section>
      <section className="ledger-section">
        <h3>Keyboard shortcuts</h3>
        <p className="ledger-quiet">Shortcuts are ignored while you are typing in a field.</p>
        <table className="ledger-table ledger-shortcuts"><tbody>{SHORTCUTS.map(([keys, what]) => <tr key={keys}><td><kbd className="ledger-kbd">{keys}</kbd></td><td>{what}</td></tr>)}</tbody></table>
      </section>
    </div>
  );
}

const GOOGLE_RESULTS = {
  connected: 'Google Calendar is connected. New reminders will appear there with pop-up alerts.',
  cancelled: 'Google sign-in was cancelled. Nothing was changed.',
  expired: 'That sign-in took too long or came from another window. Try Connect again.',
  unavailable: 'Google Calendar is not set up on this server yet. Ask the administrator to add the Google settings.',
  scope: 'Google did not give access to your calendar. Try again and leave the calendar permission ticked.',
};

function GoogleSection() {
  const { search } = useLocation();
  const result = new URLSearchParams(search).get('google');
  const status = useGoogleStatus();
  const refresh = useRefreshLedger();
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(result ? GOOGLE_RESULTS[result] ?? 'Google Calendar could not be connected. Try again.' : '');
  const google = status.data ?? { connected: false, status: 'disconnected' };
  const run = async (label, work, done) => {
    setBusy(label); setMessage('');
    try { const outcome = await work(); if (outcome?.reconnect) setMessage('Google asked to be connected again.'); else if (done) setMessage(done(outcome)); refresh(); }
    catch (error) { setMessage(humanDbError(error) || error.message || 'That did not work. Try again.'); }
    finally { setBusy(''); }
  };
  return (
    <section className="ledger-section" aria-labelledby="ledger-google-title">
      <h3 id="ledger-google-title"><CalendarCheck size={17} /> Google Calendar</h3>
      <p>Reminders become real calendar events with pop-ups at the time and 10 minutes before, and your meetings show in today’s schedule.</p>
      {status.isLoading ? <p className="ledger-quiet">Checking…</p> : google.connected ? (
        <p className="ledger-note">Connected{google.email ? ` as ${google.email}` : ''}{google.connected_at ? ` since ${dateLabel(google.connected_at)}` : ''}.</p>
      ) : google.status === 'needs_reconnect' ? (
        <p className="ledger-alert">Google stopped accepting the connection (the password may have changed, or access was removed). Reconnect to keep reminders in your calendar.</p>
      ) : <p className="ledger-quiet">Not connected. Reminders still work inside the ledger.</p>}
      <div className="ledger-actions">
        {!google.connected && <button type="button" className={btnClass('primary')} disabled={Boolean(busy)}
          onClick={() => run('connect', connectGoogleCalendar)}>{google.status === 'needs_reconnect' ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}</button>}
        {google.connected && <>
          <button type="button" className={btnClass('ghost')} disabled={Boolean(busy)} onClick={() => run('sync', syncGoogleCalendar,
            (outcome) => (outcome?.failed ? `${outcome.failed} change${outcome.failed === 1 ? '' : 's'} could not reach Google; they will be retried.`
              : `Calendar is up to date${outcome?.synced ? ` (${outcome.synced} change${outcome.synced === 1 ? '' : 's'} sent)` : ''}.`))}>Sync now</button>
          <button type="button" className={btnClass('ghost')} disabled={Boolean(busy)} onClick={() => {
            if (window.confirm('Disconnect Google Calendar? Events already created stay in your calendar.')) run('disconnect', disconnectGoogleCalendar, () => 'Disconnected.');
          }}>Disconnect</button>
        </>}
      </div>
      {busy && <p className="ledger-quiet" role="status">Working…</p>}
      {message && <p className="ledger-quiet" role="status">{message}</p>}
      <p className="ledger-quiet">On a company Google Workspace account this works straight away. A personal Gmail account works too, but until Google finishes reviewing the app it may ask you to reconnect every week.</p>
    </section>
  );
}

function SoundSection() {
  const [on, setOn] = useState(readSound);
  return (
    <section className="ledger-section">
      <h3>Sound</h3>
      <label className="ledger-check"><input type="checkbox" checked={on}
        onChange={(event) => { setOn(event.target.checked); saveSound(event.target.checked); if (event.target.checked) chime(); }} />
        Play a short chime when a reminder is due or a meeting is 10 minutes away (this device only)</label>
    </section>
  );
}
