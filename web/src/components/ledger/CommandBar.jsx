// The command bar (/ or Ctrl K): plain text searches every task and deliverable; a `task:`,
// `idea:`, `help:` or `remind:` prefix turns the line into a quick capture with a live preview.
import React, { useEffect, useId, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { newId, searchLedger, syncGoogleCalendar, useLedgerAction } from '../../data/workLedger';
import { describeCapture, parseQuickCapture } from '../../lib/ledger/quickCapture.js';
import { BrandMark, StatusPill, dateLabel, errorText, useLedger } from './ui';
import { btnClass } from '../ui/Btn';

const EXAMPLES = ['task: Diwali hoarding @jewels !high by fri', 'help: reviewed reel cuts for Priya 20m', 'idea: monsoon stay offer @munnar #offers',
  'remind: call the printer tomorrow 10am'];

function captureCall(parsed) {
  if (parsed.kind === 'task') {
    return { name: 'ledger_add_task', args: { _id: newId(), _entry: { task: parsed.title, brand: parsed.brand ?? 'General', priority: parsed.priority,
      deadline: parsed.deadline, repeat: parsed.repeat, status: 'Brief' } }, ready: Boolean(parsed.title), done: 'Task added.' };
  }
  if (parsed.kind === 'idea') {
    return { name: 'ledger_add_idea', args: { _id: newId(), _text: parsed.text, _brand: parsed.brand ?? null, _tags: parsed.tags ?? [] },
      ready: Boolean(parsed.text), done: 'Idea saved.' };
  }
  if (parsed.kind === 'help') {
    return { name: 'ledger_log_support', args: { _id: newId(), _entry: { what: parsed.title, for_whom: parsed.forWhom, brand: parsed.brand ?? 'General',
      type: parsed.supportType, minutes: parsed.minutes, date: parsed.date } }, ready: Boolean(parsed.title), done: 'Help logged.' };
  }
  return { name: 'ledger_add_reminder', args: { _id: newId(), _r: { text: parsed.text, due_at: parsed.dueAt, repeat: parsed.repeat } },
    ready: Boolean(parsed.text && parsed.dueAt), done: 'Reminder set.' };
}

export default function CommandBar({ initial = '', onClose }) {
  const { owner, readOnly, today, open } = useLedger();
  const act = useLedgerAction();
  const [text, setText] = useState(initial);
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [saved, setSaved] = useState('');
  const input = useRef(null);
  const restoreTo = useRef(null);
  const labelId = useId();
  const parsed = parseQuickCapture(text, { today });
  const capturing = parsed.kind !== 'search' && !readOnly;
  const query = parsed.kind === 'search' ? parsed.query : '';

  useEffect(() => {
    restoreTo.current = document.activeElement;
    const field = input.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
    return () => { if (restoreTo.current instanceof HTMLElement) restoreTo.current.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    if (query.length < 2) { setResults(null); return undefined; }
    let live = true;
    setSearching(true);
    const timer = setTimeout(() => {
      searchLedger(query, owner).then((data) => { if (live) setResults(data); }).catch(() => { if (live) setResults({ tasks: [], deliverables: [], failed: true }); })
        .finally(() => { if (live) setSearching(false); });
    }, 220);
    return () => { live = false; clearTimeout(timer); };
  }, [query, owner]);

  const submit = async (event) => {
    event.preventDefault();
    if (!capturing) return;
    const call = captureCall(parsed);
    if (!call.ready) return;
    setSaved('');
    try {
      const result = await act.mutateAsync({ name: call.name, args: call.args });
      if (parsed.kind === 'remind' && result?.calendar) syncGoogleCalendar().catch(() => {});
      setSaved(call.done);
      setText('');
    } catch { /* shown below */ }
  };
  const fullForm = () => {
    onClose();
    if (parsed.kind === 'task') open('task', { task: parsed.title, brand: parsed.brand ?? 'General', priority: parsed.priority, deadline: parsed.deadline ?? '', repeat: parsed.repeat ?? '' });
    else if (parsed.kind === 'help') open('help', { what: parsed.title, for_whom: parsed.forWhom, brand: parsed.brand ?? 'General', type: parsed.supportType,
      minutes: parsed.minutes ?? '', date: parsed.date });
    else if (parsed.kind === 'remind') open('reminder', { text: parsed.text, date: parsed.dueAt?.slice(0, 10), time: parsed.dueAt?.slice(11, 16), repeat: parsed.repeat ?? '' });
  };
  const chips = capturing ? describeCapture(parsed) : [];
  const call = capturing ? captureCall(parsed) : null;

  return (
    <div className="ledger-command-backdrop" onClick={onClose}>
      <div className="ledger-command" role="dialog" aria-modal="true" aria-labelledby={labelId} onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
        <h2 id={labelId} className="sr-only">Search or quick add</h2>
        <form onSubmit={submit} className="ledger-command-form">
          <Search size={17} aria-hidden="true" />
          <input ref={input} className="ledger-command-input" aria-label="Search, or type task:, idea:, help: or remind: to add" value={text} maxLength={500}
            placeholder={readOnly ? 'Search this ledger' : 'Search, or type task: · idea: · help: · remind:'} onChange={(event) => { setText(event.target.value); setSaved(''); }} />
          <kbd>Esc</kbd>
        </form>
        <div className="ledger-command-body">
          {capturing && (
            <div className="ledger-capture" aria-live="polite">
              <p className="ledger-chips">{chips.map((chip) => <span key={chip} className="ledger-chip-flag">{chip}</span>)}</p>
              <p className="ledger-capture-title">{parsed.title ?? parsed.text ?? ''}{!call.ready && <span className="ledger-quiet">
                {parsed.kind === 'remind' && !parsed.dueAt ? 'Add a time, e.g. tomorrow 10am' : 'Keep typing…'}</span>}</p>
              <div className="ledger-actions">
                <button type="button" className={btnClass('primary')} disabled={!call.ready || act.isPending} onClick={submit}>Save · Enter</button>
                {parsed.kind !== 'idea' && <button type="button" className={btnClass('ghost')} onClick={fullForm}>Open the full form</button>}
              </div>
            </div>)}
          {act.error && <p className="ledger-alert" role="alert">{errorText(act.error)}</p>}
          {saved && <p className="ledger-note" role="status">{saved}</p>}
          {!capturing && query.length < 2 && !saved && (
            <div className="ledger-command-help">
              <p className="ledger-quiet">Type two letters to search every task and deliverable.{!readOnly && ' Or add something straight away:'}</p>
              {!readOnly && <ul className="ledger-plain-list">{EXAMPLES.map((example) => (
                <li key={example}><button type="button" className="ledger-text-button ledger-mono" onClick={() => { setText(example.replace(/:.*/, ': ')); input.current?.focus(); }}>{example}</button></li>))}</ul>}
            </div>)}
          {!capturing && query.length >= 2 && (
            <div aria-live="polite" aria-busy={searching}>
              {results?.failed && <p className="ledger-alert" role="alert">Search did not work. Try again.</p>}
              {results && !results.failed && !results.tasks.length && !results.deliverables.length && <p className="ledger-quiet">Nothing matches “{query}”.</p>}
              {results?.tasks?.length > 0 && <>
                <h3 className="ledger-command-heading">Tasks</h3>
                <ul className="ledger-plain-list">{results.tasks.map((task) => (
                  <li key={task.id}><button type="button" className="ledger-command-result" onClick={() => { onClose(); open('edit', task.id); }}>
                    <span className="ledger-item-title">{task.title}</span> <BrandMark label={task.brand_label} /> <StatusPill status={task.status} />
                    <span className="ledger-quiet">{dateLabel(task.work_date ?? task.logged_at)}</span></button></li>))}</ul>
              </>}
              {results?.deliverables?.length > 0 && <>
                <h3 className="ledger-command-heading">Deliverables</h3>
                <ul className="ledger-plain-list">{results.deliverables.map((item) => (
                  <li key={item.id}><button type="button" className="ledger-command-result" onClick={() => { onClose(); open('edit', item.task_id); }}>
                    <span className="ledger-item-title">{[item.type, item.version].filter(Boolean).join(' · ') || 'Deliverable'}</span>
                    <span className="ledger-quiet"> — {item.task_title}{item.used_where ? ` · ${item.used_where}` : ''}</span></button>
                    {item.link && <a className="ledger-link" href={item.link} target="_blank" rel="noopener noreferrer">open</a>}</li>))}</ul>
              </>}
            </div>)}
        </div>
      </div>
    </div>
  );
}
