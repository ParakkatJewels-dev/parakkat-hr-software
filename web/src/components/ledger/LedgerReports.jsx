// Reports: pick a period, read the report, then prepare the share text — edit it, copy it or share it.
import React, { useState } from 'react';
import { Copy, RotateCcw, Share2 } from 'lucide-react';
import { useLedgerReport } from '../../data/workLedger';
import { istToday } from '../../lib/dates';
import { humanDbError } from '../../lib/dbErrors';
import { addDays, longDate, monthDay, periodArgument, periodLabel, PERIOD_TITLES } from '../../lib/ledger/periods.js';
import { buildShareText } from '../../lib/ledger/shareText.js';
import { copyText, shareText } from '../../lib/ledger/share.js';
import Drawer from './Drawer';

const PERIOD_CHOICES = [
  { id: 'day', label: 'Today' }, { id: 'week', label: 'Pick a week' }, { id: 'month', label: 'Pick a month' },
  { id: 'all', label: 'Overall to date' }, { id: 'range', label: 'Custom period' },
];
const money = (value) => `₹${Math.round(Number(value) || 0).toLocaleString('en-IN')}`;

export default function LedgerReports({ owner = null }) {
  const today = istToday();
  const [period, setPeriod] = useState('day');
  const [day, setDay] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const rangeInvalid = period === 'range' && (!from || !to || to < from);
  const date = periodArgument(period, { day, month, from, to });
  const report = useLedgerReport({ owner, period: rangeInvalid ? null : period, date });
  const key = `${period}:${date}`;
  // The edited draft is kept for this period until Regenerate or another period is loaded.
  const [draft, setDraft] = useState(null);
  const [drawer, setDrawer] = useState(false);
  const [status, setStatus] = useState('');
  const data = report.data;

  const openDraft = () => {
    if (!data) return;
    if (draft?.key !== key) setDraft({ key, text: buildShareText(data) });
    setStatus('');
    setDrawer(true);
  };
  const regenerate = () => { setDraft({ key, text: buildShareText(data) }); setStatus('Regenerated from the report.'); };
  const act = async (how) => {
    const result = how === 'share' ? await shareText(draft.text, { title: `${PERIOD_TITLES[data.period]} report` }) : await copyText(draft.text);
    setStatus({ shared: 'Shared.', copied: 'Copied — paste it into WhatsApp or Slack.', cancelled: '', failed: 'Copy is blocked in this browser. Select the text and copy it by hand.' }[result]);
  };

  return (
    <div className="ledger-reports">
      <div className="ledger-toolbar">
        <div className="ledger-segmented" role="radiogroup" aria-label="Report period">
          {PERIOD_CHOICES.map((choice) => (
            <button key={choice.id} type="button" role="radio" aria-checked={period === choice.id}
              className="ledger-segment" onClick={() => setPeriod(choice.id)}>{choice.label}</button>
          ))}
        </div>
        <div className="ledger-pickers">
          {period === 'day' && <label>Day <input type="date" value={day} max={today} onChange={(e) => setDay(e.target.value || today)} /></label>}
          {period === 'week' && <label>Any day in the week <input type="date" value={day} onChange={(e) => setDay(e.target.value || today)} /></label>}
          {period === 'month' && <label>Month <input type="month" value={month} onChange={(e) => setMonth(e.target.value || today.slice(0, 7))} /></label>}
          {period === 'range' && <>
            <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </>}
        </div>
        <button type="button" className="ledger-button ledger-button-primary" disabled={!data} onClick={openDraft}>Prepare report to share</button>
      </div>
      {rangeInvalid && <p className="ledger-alert" role="alert">Choose a start date on or before the end date.</p>}
      {report.error && <p className="ledger-alert" role="alert">{humanDbError(report.error) || 'The report could not be loaded.'}</p>}
      {report.isLoading && !rangeInvalid && <p className="ledger-quiet" aria-live="polite">Gathering the report…</p>}
      {data && <ReportView report={data} />}

      {drawer && draft && (
        <Drawer title="Report draft" subtitle={`${PERIOD_TITLES[data.period]} · ${periodLabel(data)}`} onClose={() => setDrawer(false)}
          initialFocus="textarea"
          footer={<>
            <button type="button" className="ledger-button" onClick={regenerate}><RotateCcw size={15} /> Regenerate</button>
            <button type="button" className="ledger-button" onClick={() => act('copy')}><Copy size={15} /> Copy</button>
            <button type="button" className="ledger-button ledger-button-primary" onClick={() => act('share')}><Share2 size={15} /> Share</button>
          </>}>
          <label className="sr-only" htmlFor="ledger-draft">Report text</label>
          <textarea id="ledger-draft" className="ledger-draft" value={draft.text} spellCheck="true"
            onChange={(e) => setDraft({ key, text: e.target.value })} />
          <p className="ledger-quiet" role="status">{status || 'Edit freely; your changes stay until you regenerate or pick another period.'}</p>
        </Drawer>
      )}
    </div>
  );
}

function Section({ title, count, children }) {
  return (
    <section className="ledger-section">
      <h3>{title}{count !== undefined && <span className="ledger-count">{count}</span>}</h3>
      {children}
    </section>
  );
}

function Notes({ notes, report }) {
  if (!notes?.length) return null;
  return (
    <ul className="ledger-notes">
      {notes.map((note, index) => (
        <li key={index}>{(!report.single_day || note.date !== report.from) && <span className="ledger-date">{monthDay(note.date)}</span>}{note.note}
          {note.minutes ? <span className="ledger-quiet"> · {note.minutes}m</span> : null}</li>
      ))}
    </ul>
  );
}

export function ReportView({ report }) {
  const worked = report.worked_on ?? [];
  const delivered = report.delivered ?? [];
  const support = report.support ?? [];
  const open = report.pending_now ?? [];
  const nothing = !worked.length && !delivered.length && !support.length;
  return (
    <article className="ledger-report" aria-label={`${PERIOD_TITLES[report.period]} report, ${periodLabel(report)}`}>
      <header className="ledger-report-head">
        <h2>{PERIOD_TITLES[report.period]} report</h2>
        <p>{periodLabel(report)}</p>
        <p className="ledger-summary">
          {worked.length} worked on · {delivered.length} delivered · {support.length} support
          {report.support_minutes ? ` (${report.support_minutes}m)` : ''} · {(report.overdue ?? []).length} overdue · {(report.ideas_captured ?? []).length} ideas
        </p>
      </header>
      {nothing && <p className="ledger-empty">Nothing logged in this period yet.</p>}
      {worked.length > 0 && <Section title="Worked on" count={worked.length}>
        <ul className="ledger-list">{worked.map((item) => (
          <li key={item.id}><span className="ledger-item-title">{item.title}</span> <span className="ledger-brand">{item.brand_label}</span>
            {item.event && <span className="ledger-event">→ {item.event}</span>}{item.is_new && <span className="ledger-tag">new</span>}
            <Notes notes={item.notes} report={report} /></li>
        ))}</ul>
      </Section>}
      {support.length > 0 && <Section title="Support & reviews" count={support.length}>
        <ul className="ledger-list">{support.map((item) => (
          <li key={item.id}><span className="ledger-item-title">{item.title}</span>{item.for_whom && <> — for {item.for_whom}</>}
            {item.minutes ? <span className="ledger-quiet"> ({item.minutes}m)</span> : null}</li>
        ))}</ul>
        {(report.support_by_person ?? []).length > 1 && <p className="ledger-quiet">
          By person: {report.support_by_person.map((p) => `${p.person} ${p.count}${p.minutes ? ` (${p.minutes}m)` : ''}`).join(' · ')}</p>}
      </Section>}
      {delivered.length > 0 && <Section title="Delivered" count={delivered.length}>
        <ul className="ledger-list">{delivered.map((item) => (
          <li key={item.id}><span className="ledger-item-title">{item.title}</span> <span className="ledger-brand">{item.brand_label}</span>
            {item.outcome && <> — {item.outcome}</>}<Notes notes={item.notes} report={report} /></li>
        ))}</ul>
      </Section>}
      {report.single_day && open.length > 0 && <Section title="Still open" count={open.length}>
        <ul className="ledger-list ledger-list-compact">{open.map((item) => (
          <li key={item.id} data-untouched={item.untouched || undefined}><span className="ledger-item-title">{item.title}</span> <span className="ledger-brand">{item.brand_label}</span>
            <span className="ledger-quiet"> · {item.status}{item.untouched ? ' · not touched today' : ''}</span></li>
        ))}</ul>
      </Section>}
      {(report.wins ?? []).length > 0 && <Section title="Wins & outcomes">
        <ul className="ledger-list">{report.wins.map((item) => <li key={item.id}><span className="ledger-item-title">{item.title}</span> — {item.outcome}</li>)}</ul>
      </Section>}
      <div className="ledger-breakdowns">
        {(report.by_brand ?? []).length > 0 && <Section title="By brand"><Table rows={report.by_brand.map((r) => [r.label ?? r.brand, `${r.items}`, `${r.done} done`])} /></Section>}
        {(report.by_campaign ?? []).length > 0 && <Section title="By campaign"><Table rows={report.by_campaign.map((r) => [r.campaign, `${r.done}/${r.total} done`, Number(r.spend) > 0 ? money(r.spend) : ''])} /></Section>}
        {(report.by_type ?? []).length > 0 && <Section title="By type"><Table rows={report.by_type.map((r) => [r.type, `${r.items}`, `${r.done} done`])} /></Section>}
        {(Number(report.cost?.est) > 0 || Number(report.cost?.actual) > 0) && <Section title="Spend">
          <p>Estimated {money(report.cost.est)} · actual {money(report.cost.actual)}</p></Section>}
      </div>
      {(report.blocked ?? []).length > 0 && <Section title="Blocked / in review" count={report.blocked.length}>
        <ul className="ledger-list">{report.blocked.map((item) => (
          <li key={item.id}><span className="ledger-item-title">{item.title}</span> <span className="ledger-quiet">({item.status}{item.waiting_on ? `, waiting on ${item.waiting_on}` : ''}{item.since ? ` · since ${longDate(item.since)}` : ''})</span></li>
        ))}</ul>
      </Section>}
      {(report.overdue ?? []).length > 0 && <Section title="Overdue" count={report.overdue.length}>
        <ul className="ledger-list ledger-list-warning">{report.overdue.map((item) => (
          <li key={item.id}><span className="ledger-item-title">{item.title}</span> <span className="ledger-brand">{item.brand_label}</span> — since {longDate(item.deadline)}</li>
        ))}</ul>
      </Section>}
      {(report.ideas_captured ?? []).length > 0 && <Section title="Ideas captured" count={report.ideas_captured.length}>
        <ul className="ledger-list ledger-list-compact">{report.ideas_captured.map((idea) => <li key={idea.id}>{idea.text}</li>)}</ul>
      </Section>}
    </article>
  );
}

function Table({ rows }) {
  return (
    <table className="ledger-table"><tbody>
      {rows.map((cells, index) => <tr key={index}>{cells.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}
    </tbody></table>
  );
}
