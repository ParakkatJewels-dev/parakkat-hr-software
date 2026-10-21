// Quick add (/): plain text searches every task this person may see and the deliverables on them;
// a `task:`, `help:` or `remind:` prefix (and `idea:` for the creative team) adds straight away,
// with a live preview of what was understood. Tasks land in Task Management's own records.
import React, { useEffect, useId, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { useCreateTask } from '../../data/tasks';
import { newId, syncGoogleCalendar } from '../../data/workLedger';
import { searchWork, useWorkRpc, useWorkWrite } from '../../data/work';
import { useCreativeWrite } from '../../data/creative';
import { describeCapture, parseQuickCapture } from '../../lib/ledger/quickCapture.js';
import { StatusPill, dateLabel, errorText, useLedger } from './ui';
import { btnClass } from '../ui/Btn';

const EXAMPLES = ['task: Diwali hoarding !high by fri', 'help: reviewed reel cuts for Priya 20m', 'remind: call the printer tomorrow 10am'];
const CREATIVE_EXAMPLE = 'idea: monsoon stay offer @munnar #offers';

export default function CommandBar({ initial = '', onClose }) {
  const { today, open, creative } = useLedger();
  const { employee } = useAuth();
  const createTask = useCreateTask();
  const write = useWorkWrite();
  const call = useWorkRpc();
  const creativeWrite = useCreativeWrite();
  const pending = createTask.isPending || write.isPending || call.isPending || creativeWrite.isPending;
  const failure = createTask.error || write.error || call.error || creativeWrite.error;
  const [text, setText] = useState(initial);
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [saved, setSaved] = useState('');
  const input = useRef(null);
  const restoreTo = useRef(null);
  const labelId = useId();
  const parsed = parseQuickCapture(text, { today });
  const capturing = parsed.kind !== 'search';
  const ideaBlocked = parsed.kind === 'idea' && !creative;
  const ready = !ideaBlocked && (parsed.kind === 'task' ? Boolean(parsed.title) : parsed.kind === 'help' ? Boolean(parsed.title)
    : parsed.kind === 'remind' ? Boolean(parsed.text && parsed.dueAt) : Boolean(parsed.text));
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
      searchWork(query).then((data) => { if (live) setResults(data); }).catch(() => { if (live) setResults({ tasks: [], deliverables: [], failed: true }); })
        .finally(() => { if (live) setSearching(false); });
    }, 220);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);

  const submit = async (event) => {
    event.preventDefault();
    if (!capturing || !ready || pending) return;
    setSaved('');
    try {
      if (parsed.kind === 'task') {
        await createTask.mutateAsync({ title: parsed.title, description: null, priority: parsed.priority, due_date: parsed.deadline || null,
          employee_id: employee?.id, assigneeIds: [employee?.id], checklist: [], attachments: { files: [], links: [] },
          assigned_by: employee?.id ?? null, parent_task_id: null });
        setSaved('Task added to your work.');
      } else if (parsed.kind === 'help') {
        await write.mutateAsync({ op: 'help', what: parsed.title, for_whom: parsed.forWhom, minutes: parsed.minutes, kind: parsed.supportType, date: parsed.date });
        setSaved('Help logged.');
      } else if (parsed.kind === 'remind') {
        const result = await call.mutateAsync({ name: 'ledger_add_reminder', args: { _id: newId(), _r: { text: parsed.text, due_at: parsed.dueAt, repeat: parsed.repeat } } });
        if (result?.calendar) syncGoogleCalendar().catch(() => {});
        setSaved('Reminder set.');
      } else if (parsed.kind === 'idea') {
        await creativeWrite.mutateAsync({ op: 'add-idea', text: parsed.text, brand: parsed.brand ?? null, tags: parsed.tags ?? [] });
        setSaved('Idea saved to the team’s inbox.');
      }
      setText('');
    } catch { /* shown below */ }
  };
  const fullForm = () => {
    onClose();
    if (parsed.kind === 'task') open('new-task');
    else if (parsed.kind === 'help') open('help', { what: parsed.title, for_whom: parsed.forWhom, kind: parsed.supportType, minutes: parsed.minutes ?? '', date: parsed.date });
    else if (parsed.kind === 'remind') open('reminder', { text: parsed.text, date: parsed.dueAt?.slice(0, 10), time: parsed.dueAt?.slice(11, 16), repeat: parsed.repeat ?? '' });
  };
  const chips = capturing ? describeCapture(parsed) : [];

  return (
    <div className="ledger-command-backdrop" onClick={onClose}>
      <div className="ledger-command" role="dialog" aria-modal="true" aria-labelledby={labelId} onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
        <h2 id={labelId} className="sr-only">Search or quick add</h2>
        <form onSubmit={submit} className="ledger-command-form">
          <Search size={17} aria-hidden="true" />
          <input ref={input} className="ledger-command-input" aria-label="Search, or type task:, idea:, help: or remind: to add" value={text} maxLength={500}
            placeholder={creative ? 'Search, or type task: · help: · remind: · idea:' : 'Search, or type task: · help: · remind:'} onChange={(event) => { setText(event.target.value); setSaved(''); }} />
          <kbd>Esc</kbd>
        </form>
        <div className="ledger-command-body">
          {capturing && (
            <div className="ledger-capture" aria-live="polite">
              <p className="ledger-chips">{chips.map((chip) => <span key={chip} className="ledger-chip-flag">{chip}</span>)}</p>
              <p className="ledger-capture-title">{parsed.title ?? parsed.text ?? ''}{!ready && <span className="ledger-quiet">
                {ideaBlocked ? 'Ideas are for the creative team.' : parsed.kind === 'remind' && !parsed.dueAt ? 'Add a time, e.g. tomorrow 10am' : 'Keep typing…'}</span>}</p>
              <div className="ledger-actions">
                <button type="button" className={btnClass('primary')} disabled={!ready || pending} onClick={submit}>Save · Enter</button>
                {parsed.kind !== 'idea' && <button type="button" className={btnClass('ghost')} onClick={fullForm}>Open the full form</button>}
              </div>
            </div>)}
          {failure && <p className="ledger-alert" role="alert">{errorText(failure)}</p>}
          {saved && <p className="ledger-note" role="status">{saved}</p>}
          {!capturing && query.length < 2 && !saved && (
            <div className="ledger-command-help">
              <p className="ledger-quiet">Type two letters to search every task and deliverable. Or add something straight away:</p>
              <ul className="ledger-plain-list">{[...EXAMPLES, ...(creative ? [CREATIVE_EXAMPLE] : [])].map((example) => (
                <li key={example}><button type="button" className="ledger-text-button ledger-mono" onClick={() => { setText(example.replace(/:.*/, ': ')); input.current?.focus(); }}>{example}</button></li>))}</ul>
            </div>)}
          {!capturing && query.length >= 2 && (
            <div aria-live="polite" aria-busy={searching}>
              {results?.failed && <p className="ledger-alert" role="alert">Search did not work. Try again.</p>}
              {results && !results.failed && !results.tasks.length && !results.deliverables.length && <p className="ledger-quiet">Nothing matches “{query}”.</p>}
              {results?.tasks?.length > 0 && <>
                <h3 className="ledger-command-heading">Tasks</h3>
                <ul className="ledger-plain-list">{results.tasks.map((task) => (
                  <li key={task.id}><button type="button" className="ledger-command-result" onClick={() => { onClose(); open('task', task.id); }}>
                    <span className="ledger-item-title">{task.title}</span> <StatusPill status={task.step} />
                    <span className="ledger-quiet">{[task.assignee_name, dateLabel(task.created_at)].filter(Boolean).join(' · ')}</span></button></li>))}</ul>
              </>}
              {results?.deliverables?.length > 0 && <>
                <h3 className="ledger-command-heading">Deliverables</h3>
                <ul className="ledger-plain-list">{results.deliverables.map((item) => (
                  <li key={item.id}><button type="button" className="ledger-command-result" onClick={() => { onClose(); open('task', item.task_id); }}>
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
