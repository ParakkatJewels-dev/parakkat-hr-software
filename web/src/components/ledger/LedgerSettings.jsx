// Settings: Google Calendar for reminders, the chime, the keyboard shortcuts, and (for a super admin)
// which departments are the creative team.
import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { CalendarCheck } from 'lucide-react';
import { connectGoogleCalendar, disconnectGoogleCalendar, syncGoogleCalendar, useGoogleStatus, useRefreshLedger } from '../../data/workLedger';
import { readSound, saveSound } from '../../data/work';
import { useCreativeSettings, useCreativeWrite } from '../../data/creative';
import { useDepartments } from '../../data/helpRequests';
import { humanDbError } from '../../lib/dbErrors';
import { SHORTCUTS, chime, dateLabel } from './ui';
import { btnClass } from '../ui/Btn';

export default function LedgerSettings() {
  return (
    <div className="ledger-settings">
      <GoogleSection />
      <SoundSection />
      <CreativeTeamSection />
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

/** Who gets Campaigns, Ideas and Library. Members see which departments; a super admin chooses them. */
function CreativeTeamSection() {
  const settings = useCreativeSettings();
  const data = settings.data;
  if (!data || (!data.member && !data.can_configure)) return null;
  return (
    <section className="ledger-section" aria-labelledby="ledger-creative-team-title">
      <h3 id="ledger-creative-team-title">Creative team</h3>
      <p>The creative team shares Campaigns, Ideas and the Library, and sees brand, campaign, vendor and cost on tasks.
        Managers whose area covers one of these departments get them too.</p>
      {data.can_configure ? <CreativeDepartmentsPicker chosen={data.departments} />
        : <p className="ledger-quiet">Departments: {data.departments.map((d) => d.name).join(', ') || 'none chosen yet'}.</p>}
    </section>
  );
}

function CreativeDepartmentsPicker({ chosen }) {
  const departments = useDepartments();
  const write = useCreativeWrite();
  const [picked, setPicked] = useState(null);
  const [saved, setSaved] = useState('');
  const current = picked ?? chosen.map((d) => d.id);
  const toggle = (id) => { setSaved(''); setPicked(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]); };
  const save = async () => {
    try { await write.mutateAsync({ op: 'departments', departments: current }); setPicked(null); setSaved('Saved. Members see the creative tabs the next time the Ledger opens.'); }
    catch { /* shown below */ }
  };
  if (departments.isLoading) return <p className="ledger-quiet">Loading departments…</p>;
  return (
    <>
      <fieldset className="ledger-check-list">
        <legend className="ledger-quiet">Choose the departments (only super admins can change this)</legend>
        {(departments.data ?? []).map((d) => (
          <label key={d.id} className="ledger-check"><input type="checkbox" checked={current.includes(d.id)} onChange={() => toggle(d.id)} />
            {d.name}{d.code ? <span className="ledger-quiet"> · {d.code}</span> : null}</label>))}
      </fieldset>
      <div className="ledger-actions">
        <button type="button" className={btnClass('primary')} disabled={picked === null || write.isPending} onClick={save}>Save creative team</button>
      </div>
      {write.error ? <p className="ledger-alert" role="alert">{humanDbError(write.error) || 'That did not save. Try again.'}</p>
        : saved && <p className="ledger-quiet" role="status">{saved}</p>}
    </>
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
