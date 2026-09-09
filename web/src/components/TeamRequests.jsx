// Asking another department for a hand.
//
// Work does not respect the org chart, and until now there was no way to ask: filing a task on
// somebody else's employee is refused by tasks_insert, and rightly — nobody should put work on a
// stranger's board without their head knowing. So the ask is its own thing. One head describes the
// work and, if they have someone in mind, names them. The other head accepts (taking the
// suggestion or choosing differently) or declines. Accepting is what creates the task.
//
// The requester keeps sight of it afterwards: 0101 widens tasks_select by one clause so a task that
// exists because you asked for it stays readable to you, even though it lives on another team.
import React, { useState, useDeferredValue } from 'react';
import {
  HandHelping, Send, Check, X, Loader2, AlertTriangle, Search, ArrowRight, Clock,
} from 'lucide-react';
import {
  useHelpRequests, useDepartments, useDepartmentPeople,
  useRequestHelp, useRespondToHelpRequest, useCancelHelpRequest, useUpdateHelpRequest,
} from '../data/helpRequests';
import { humanDbError } from '../lib/dbErrors';
import {
  incomingRequests, outgoingRequests, preferenceOutcome, sortRequests,
} from '../lib/helpRequests';
import { TASK_PRIORITIES } from '../lib/taskBoard';
import { relativeTime } from '../lib/dates';
import { btnClass } from './ui/Btn';
import FormSection from './ui/FormSection';
import IconInput from './ui/IconInput';

const INPUT =
  'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971] transition-colors';

const statusClass = (s) =>
  s === 'Accepted' ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900/30'
  : s === 'Declined' ? 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900/30'
  : s === 'Cancelled' ? 'bg-neutral-100 text-neutral-400 border-neutral-200 dark:bg-neutral-900 dark:text-neutral-500 dark:border-neutral-800'
  : 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/30';

function Pill({ status }) {
  return (
    <span className={`text-2xs px-2 py-0.5 rounded-full font-mono font-bold uppercase tracking-wider border shrink-0 ${statusClass(status)}`}>
      {status}
    </span>
  );
}

export default function TeamRequests({ myDepartments = [] }) {
  const myIds = myDepartments.map((d) => d.id);
  const { data: requests = [], isLoading, error } = useHelpRequests();
  const [asking, setAsking] = useState(false);
  // The request being corrected. A request was write-once: getting the title wrong meant
  // withdrawing and re-raising, which loses the thread the other head is already reading.
  const [editingRequest, setEditingRequest] = useState(null);

  const respond = useRespondToHelpRequest();
  const cancel = useCancelHelpRequest();

  const incoming = sortRequests(incomingRequests(requests, myIds));
  const outgoing = sortRequests(outgoingRequests(requests, myIds));
  const mutationError = respond.error || cancel.error;

  if (isLoading) {
    return <div className="flex justify-center py-16 text-[#0ea971]"><Loader2 size={22} className="animate-spin" /></div>;
  }

  if (error) {
    return (
      <div className="premium-card p-5 flex items-start gap-3 text-xs text-amber-700 dark:text-amber-300">
        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold">Couldn't load requests.</p>
          <p className="text-neutral-500 dark:text-neutral-400 mt-1">
            {error.message}. If it mentions <code>help_requests</code>, run migration <code>0101</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Need somebody outside your department? Ask their head. They decide who does it.
        </p>
        <button onClick={() => setAsking(true)} className={btnClass('primary')}>
          <HandHelping size={14} /> <span>Ask another department</span>
        </button>
      </div>

      {mutationError && (
        <div role="alert" className="flex items-start gap-2 text-xs text-red-600 dark:text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{humanDbError(mutationError, 'help_requests')}</span>
        </div>
      )}

      {asking && (
        <AskPanel
          myDepartments={myDepartments}
          onClose={() => setAsking(false)}
          onDone={() => setAsking(false)}
        />
      )}

      {editingRequest && (
        <AskPanel
          key={editingRequest.id}
          myDepartments={myDepartments}
          request={editingRequest}
          onClose={() => setEditingRequest(null)}
          onDone={() => setEditingRequest(null)}
        />
      )}

      <Group
        title="Waiting on you"
        empty="Nobody has asked your team for help."
        requests={incoming}
        render={(r) => (
          <IncomingCard
            key={r.id}
            request={r}
            busy={respond.isPending}
            onRespond={(args) => { respond.reset(); return respond.mutateAsync({ requestId: r.id, ...args }); }}
          />
        )}
      />

      <Group
        title="You asked for"
        empty="You haven't asked another department for anything yet."
        requests={outgoing}
        render={(r) => (
          <OutgoingCard
            key={r.id}
            request={r}
            busy={cancel.isPending}
            onCancel={() => { cancel.reset(); return cancel.mutateAsync(r.id).catch(() => {}); }}
            onEdit={() => setEditingRequest(r)}
          />
        )}
      />

    </div>
  );
}

function Group({ title, empty, requests, render }) {
  return (
    <section className="space-y-2.5">
      <h2 className="text-2xs font-bold uppercase tracking-widest text-neutral-450 dark:text-neutral-500 px-1">
        {title} {requests.length > 0 && <span className="font-mono opacity-70">· {requests.length}</span>}
      </h2>
      {requests.length === 0
        ? <p className="premium-card p-6 text-center text-xs text-neutral-500">{empty}</p>
        : <div className="space-y-2.5">{requests.map(render)}</div>}
    </section>
  );
}

/** Shared header: what was asked, by whom, and where it stands. */
function RequestHead({ request, otherLabel, otherName }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-bold text-sm text-neutral-850 dark:text-slate-100 truncate">{request.title}</span>
        <span className="text-2xs font-bold uppercase font-mono text-neutral-400">{request.priority}</span>
      </div>
      {request.description && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400 line-clamp-2">{request.description}</p>
      )}
      <div className="flex items-center gap-3 flex-wrap text-2xs text-neutral-500 dark:text-neutral-400">
        <span className="font-mono">{otherLabel} {otherName}</span>
        {request.due_date && <span className="font-mono">· due {request.due_date}</span>}
        <span className="font-mono">· {relativeTime(request.created_at)}</span>
      </div>
    </div>
  );
}

/** A request addressed to a department this person runs. */
function IncomingCard({ request, busy, onRespond }) {
  const [choosing, setChoosing] = useState(false);
  const [note, setNote] = useState('');
  const pending = request.status === 'Pending';

  return (
    <div className="premium-card space-y-3">
      <div className="mobile-list-row flex items-start justify-between gap-3">
        <RequestHead request={request} otherLabel="from" otherName={request.from_department?.name ?? 'another department'} />
        <Pill status={request.status} />
      </div>

      {request.preferred && (
        <p className="text-xs text-neutral-600 dark:text-neutral-300">
          They suggested <span className="font-semibold">{request.preferred.full_name}</span>
          <span className="font-mono text-2xs text-neutral-500"> · {request.preferred.employee_code}</span>
          {pending && <span className="text-neutral-500"> — you can accept that or pick somebody else on your team.</span>}
        </p>
      )}

      {!pending && request.assignee && (
        <p className="text-xs text-neutral-500">
          Given to <span className="font-semibold text-neutral-700 dark:text-neutral-300">{request.assignee.full_name}</span>
          {request.task?.status && <span className="font-mono text-2xs"> · now {request.task.status}</span>}
        </p>
      )}
      {!pending && request.decision_note && (
        <p className="text-xs text-neutral-500 italic">“{request.decision_note}”</p>
      )}

      {pending && !choosing && (
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setChoosing(true)} disabled={busy} className={btnClass('primary')}>
            <Check size={13} /> <span>Accept &amp; assign</span>
          </button>
          <button
            onClick={() => onRespond({ accept: false, note: note.trim() || null }).catch(() => {})}
            disabled={busy}
            className={btnClass('dangerGhost')}
          >
            <X size={13} /> <span>Decline</span>
          </button>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note (optional)…"
            aria-label="Note to the requesting head"
            className={INPUT + ' flex-1 min-w-[12rem]'}
          />
        </div>
      )}

      {pending && choosing && (
        <AssignPanel
          request={request}
          busy={busy}
          note={note}
          onNote={setNote}
          onCancel={() => setChoosing(false)}
          onAssign={(assigneeId, priority) =>
            onRespond({ accept: true, assigneeId, priority, note: note.trim() || null })
              .then(() => setChoosing(false))
              .catch(() => {})}
        />
      )}
    </div>
  );
}

/** Choosing who actually does it — the suggestion is offered first, but it is only a suggestion. */
function AssignPanel({ request, busy, note, onNote, onCancel, onAssign }) {
  // Starts at what they asked for, because that is the useful default — but it is the receiving
  // head's call. "Urgent" means something different on the board that has to absorb it, and they
  // are the one who knows what else is on it this week. See 0103.
  const [priority, setPriority] = useState(request.priority ?? 'Medium');
  const [q, setQ] = useState('');
  const deferredQ = useDeferredValue(q);
  const { data: people = [], isLoading } = useDepartmentPeople(request.to_department_id, deferredQ);

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-850 p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs font-bold uppercase tracking-widest text-neutral-450">Who will do it?</span>
        <button type="button" onClick={onCancel} className="text-neutral-400 hover:text-neutral-700 dark:hover:text-white cursor-pointer">
          <X size={14} />
        </button>
      </div>

      <div className="space-y-1">
        <label className="block text-2xs font-bold uppercase tracking-widest text-neutral-450">
          Priority on your board
          {priority !== request.priority && (
            <span className="ml-1.5 font-normal normal-case tracking-normal text-neutral-400">
              (they asked for {request.priority})
            </span>
          )}
        </label>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} className={INPUT}>
          {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {request.preferred && (
        <button
          type="button" disabled={busy} onClick={() => onAssign(request.preferred.id, priority)}
          className="w-full text-left rounded-lg border border-[#0ea971]/40 bg-[#0ea971]/5 px-3 py-2 text-xs hover:border-[#0ea971] cursor-pointer disabled:opacity-50 flex items-center justify-between gap-2"
        >
          <span>
            <span className="font-semibold text-neutral-800 dark:text-neutral-200">{request.preferred.full_name}</span>
            <span className="font-mono text-2xs text-neutral-500"> · {request.preferred.employee_code}</span>
          </span>
          <span className="text-2xs font-mono text-[#0c9765] dark:text-[#10b981] shrink-0">the one they asked for</span>
        </button>
      )}

      <IconInput
        icon={Search} value={q} onChange={(e) => setQ(e.target.value)}
        aria-label="Search your team" placeholder="…or somebody else on your team"
        inputClassName={INPUT}
      />

      {isLoading ? (
        <div className="flex justify-center py-4 text-[#0ea971]"><Loader2 size={16} className="animate-spin" /></div>
      ) : (
        <div className="max-h-52 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-850 divide-y divide-neutral-150 dark:divide-neutral-850/60">
          {people.filter((p) => p.id !== request.preferred?.id).map((p) => (
            <button
              key={p.id} type="button" disabled={busy} onClick={() => onAssign(p.id, priority)}
              className="w-full text-left px-3 py-2 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900 cursor-pointer disabled:opacity-50 flex justify-between gap-2"
            >
              <span className="font-semibold text-neutral-800 dark:text-neutral-200">{p.full_name}</span>
              <span className="font-mono text-2xs text-neutral-500">{p.employee_code}</span>
            </button>
          ))}
        </div>
      )}

      <input
        value={note} onChange={(e) => onNote(e.target.value)}
        placeholder="Add a note (optional)…" aria-label="Note to the requesting head"
        className={INPUT}
      />
    </div>
  );
}

/** A request this person raised. */
function OutgoingCard({ request, busy, onCancel, onEdit }) {
  const outcome = preferenceOutcome(request);
  return (
    <div className="premium-card space-y-2">
      <div className="mobile-list-row flex items-start justify-between gap-3">
        <RequestHead request={request} otherLabel="to" otherName={request.to_department?.name ?? 'another department'} />
        <Pill status={request.status} />
      </div>

      {request.preferred && request.status === 'Pending' && (
        <p className="text-xs text-neutral-500">
          You suggested <span className="font-semibold text-neutral-700 dark:text-neutral-300">{request.preferred.full_name}</span>.
        </p>
      )}

      {request.status === 'Accepted' && request.assignee && (
        <p className="text-xs text-neutral-600 dark:text-neutral-300 flex items-center gap-1.5 flex-wrap">
          <ArrowRight size={11} className="text-[#0ea971] shrink-0" />
          <span className="font-semibold">{request.assignee.full_name}</span> is on it
          {request.task?.status && (
            <span className="font-mono text-2xs text-neutral-500">· {request.task.status}</span>
          )}
          {/* Worth saying plainly: you asked for one person and got another. */}
          {outcome === 'overridden' && (
            <span className="text-2xs text-amber-600 dark:text-amber-300">
              — not {request.preferred?.full_name}, who you suggested
            </span>
          )}
        </p>
      )}

      {request.status === 'Declined' && (
        <p className="text-xs text-neutral-500">
          Declined{request.decider?.full_name ? ` by ${request.decider.full_name}` : ''}.
          {request.decision_note && <span className="italic"> “{request.decision_note}”</span>}
        </p>
      )}

      {request.status === 'Pending' && (
        <div className="flex items-center gap-2 pt-0.5">
          <span className="text-2xs text-neutral-400 font-mono flex items-center gap-1">
            <Clock size={10} /> waiting for an answer
          </span>
          <button onClick={onEdit} className={btnClass('ghost', 'sm')}>
            Edit
          </button>
          <button onClick={onCancel} disabled={busy} className={btnClass('dangerGhost', 'sm')}>
            Withdraw
          </button>
        </div>
      )}
    </div>
  );
}

/** Raising one. */
function AskPanel({ myDepartments, onClose, onDone, request = null }) {
  const editing = Boolean(request);
  const { data: departments = [] } = useDepartments();
  const ask = useRequestHelp();
  const save = useUpdateHelpRequest();
  const busy = editing ? save.isPending : ask.isPending;
  const error = humanDbError(editing ? save.error : ask.error, 'help_requests');

  const [fromId, setFromId] = useState(request?.from_department_id ?? myDepartments[0]?.id ?? '');
  const [toId, setToId] = useState(request?.to_department_id ?? '');
  const [title, setTitle] = useState(request?.title ?? '');
  const [description, setDescription] = useState(request?.description ?? '');
  const [priority, setPriority] = useState(request?.priority ?? 'Medium');
  const [dueDate, setDueDate] = useState(request?.due_date ?? '');
  const [preferredId, setPreferredId] = useState(request?.preferred?.id ?? '');
  const [q, setQ] = useState('');
  const deferredQ = useDeferredValue(q);

  const mine = new Set(myDepartments.map((d) => d.id));
  const fromEntity = departments.find((d) => d.id === fromId)?.entity_id;
  // Same company only — entities here are separate registered companies. And never yourself.
  const targets = departments.filter((d) => !mine.has(d.id) && (!fromEntity || d.entity_id === fromEntity));

  const { data: people = [] } = useDepartmentPeople(toId, deferredQ);
  // While editing, the person already chosen may not be in the current search results, so fall back
  // to what the request itself says rather than showing the field as empty.
  const preferred = people.find((p) => p.id === preferredId)
    ?? (editing && request.preferred?.id === preferredId ? request.preferred : null);

  const submit = async (e) => {
    e.preventDefault();
    if (!fromId || !toId || !title.trim()) return;
    try {
      if (editing) {
        // Which department is being asked is NOT editable: it is a different conversation with a
        // different head. Withdraw and raise a new one for that.
        await save.mutateAsync({
          requestId: request.id, title: title.trim(), description, priority,
          dueDate, preferredId,
          clearPreferred: !preferredId, clearDue: !dueDate,
        });
      } else {
        await ask.mutateAsync({
          fromDepartmentId: fromId, toDepartmentId: toId, title: title.trim(),
          description, preferredId, priority, dueDate,
        });
      }
      onDone();
    } catch { /* shown in the panel */ }
  };

  return (
    <FormSection
      title={editing ? 'Change your request' : 'Ask another department'}
      subtitle={editing
        ? 'They have not answered yet, so this is still yours to correct.'
        : 'Describe the work. Their head decides who picks it up.'}
      icon={Send}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={editing ? 'Save changes' : 'Send request'}
      busy={busy}
      error={error}
      disabled={!fromId || !toId || !title.trim()}
    >
      <div className="space-y-3">
        {!editing && myDepartments.length > 1 && (
          <div className="space-y-1">
            <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">Asking on behalf of</label>
            <select value={fromId} onChange={(e) => setFromId(e.target.value)} className={INPUT}>
              {myDepartments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        )}

        <div className="space-y-1">
          <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">Ask which department</label>
          <select
            disabled={editing}
            value={toId}
            onChange={(e) => { setToId(e.target.value); setPreferredId(''); setQ(''); }}
            className={INPUT}
          >
            <option value="">Choose a department…</option>
            {targets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>

        <div className="space-y-1">
          <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">What do you need?</label>
          <input autoFocus className={INPUT} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Re-seal the damaged batch" required />
        </div>

        <div className="space-y-1">
          <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">Detail (optional)</label>
          <textarea rows={2} className={INPUT + ' resize-none'} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="How long it should take, where, anything they need to know…" />
        </div>

        {toId && (
          <div className="space-y-1">
            <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">
              Anyone in mind? <span className="font-normal text-neutral-400">(optional — their head decides)</span>
            </label>
            {preferred ? (
              <div className="flex items-center justify-between rounded-xl bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 px-3 py-2 text-xs">
                <span className="font-semibold text-neutral-800 dark:text-neutral-200">
                  {preferred.full_name}
                  <span className="font-mono text-2xs text-neutral-500"> · {preferred.employee_code}</span>
                </span>
                <button type="button" onClick={() => { setPreferredId(''); setQ(''); }} className="text-neutral-400 hover:text-red-500 cursor-pointer">
                  <X size={14} />
                </button>
              </div>
            ) : (
              <>
                <IconInput
                  icon={Search} value={q} onChange={(e) => setQ(e.target.value)}
                  aria-label="Search that department" placeholder="Search their team by name or code…"
                  inputClassName={INPUT}
                />
                {people.length > 0 && (
                  <div className="mt-1 max-h-40 overflow-y-auto border border-neutral-200 dark:border-neutral-850 rounded-xl divide-y divide-neutral-150 dark:divide-neutral-850/60">
                    {people.map((p) => (
                      <button key={p.id} type="button" onClick={() => setPreferredId(p.id)}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900 flex justify-between cursor-pointer">
                        <span className="font-semibold text-neutral-800 dark:text-neutral-200">{p.full_name}</span>
                        <span className="font-mono text-2xs text-neutral-500">{p.employee_code}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">Priority</label>
            <select value={priority} onChange={(e) => setPriority(e.target.value)} className={INPUT}>
              {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">Needed by</label>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={INPUT} />
          </div>
        </div>
      </div>
    </FormSection>
  );
}
