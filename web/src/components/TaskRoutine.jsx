// The same things every day.
//
// Most of a shift is not projects — it is a handful of duties that come back tomorrow. Those are
// not tasks (a task is a thing you finish), so they are not on the board: a routine is defined once
// and ticked daily (0107). At 163 staff, filing them as tasks would have been 815 new rows and 815
// notifications every morning.
//
// Two audiences, one screen. Somebody doing the work sees their list for today with checkboxes. A
// head sees their team, ordered so the people who still owe something are at the top — a completion
// board is read to find who has NOT finished.
import React, { useState } from 'react';
import { CheckSquare, Square, Loader2, AlertTriangle, Plus, X, Trash2, PenLine } from 'lucide-react';
import {
  useRoutineItems, useRoutineTicks, useSetRoutineTick, useSaveRoutineItem, useRetireRoutineItem,
} from '../data/routines';
import { routineForDay, routineProgress, teamRoutineSummary } from '../lib/routines';
import { istToday } from '../lib/dates';
import { humanDbError } from '../lib/dbErrors';
import { usePermissions } from '../auth/usePermissions';
import { useAuth } from '../auth/AuthContext';
import { btnClass } from './ui/Btn';
import FormSection from './ui/FormSection';
import Pagination, { usePagination } from './ui/Pagination';

const INPUT =
  'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971] transition-colors';

export default function TaskRoutine({ employees = [] }) {
  const today = istToday();
  const { employee } = useAuth();
  const { canBeyondSelf, canAny } = usePermissions();
  const canDefine = canAny('task.create');
  const seesTeam = canBeyondSelf('task.read');

  const { data: items = [], isLoading, error } = useRoutineItems();
  const { data: ticks = [] } = useRoutineTicks(today);
  const setTick = useSetRoutineTick();
  const retire = useRetireRoutineItem();
  const [editing, setEditing] = useState(null);   // { id?, employeeId }

  const mine = routineForDay(items, ticks, employee?.id, today);
  const mineProgress = routineProgress(mine);
  const team = teamRoutineSummary(items, ticks, today);
  const others = team.filter((g) => g.employeeId !== employee?.id);
  // Ten people per page. Each card is a whole checklist, so this is already a long scroll.
  const teamPager = usePagination(others, 10);
  const mutationError = humanDbError(setTick.error || retire.error, 'routine_ticks');

  if (isLoading) return <div className="flex justify-center py-16 text-[#0ea971]"><Loader2 size={22} className="animate-spin" /></div>;

  if (error) {
    return (
      <div className="premium-card p-5 flex items-start gap-3 text-xs text-amber-700 dark:text-amber-300">
        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold">Couldn't load routines.</p>
          <p className="text-neutral-500 dark:text-neutral-400 mt-1">
            {error.message}. If it mentions <code>routine_items</code>, run migration <code>0107</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          The same duties every day. Ticks reset overnight — today is <span className="font-mono">{today}</span>.
        </p>
        {canDefine && (
          <button onClick={() => setEditing({ employeeId: employee?.id ?? '' })} className={btnClass('primary')}>
            <Plus size={14} /> <span>Add a duty</span>
          </button>
        )}
      </div>

      {mutationError && (
        <div role="alert" className="flex items-start gap-2 text-xs text-red-600 dark:text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{mutationError}</span>
        </div>
      )}

      {editing && (
        <DutyForm
          employees={employees}
          initial={editing}
          onClose={() => setEditing(null)}
          onDone={() => setEditing(null)}
        />
      )}

      {/* Yours first: you came here to tick things off. */}
      {employee?.id && (
        <section className="space-y-2.5">
          <div className="flex items-center justify-between gap-2 px-1">
            <h2 className="text-2xs font-bold uppercase tracking-widest text-neutral-450 dark:text-neutral-500">
              My routine today
            </h2>
            <Progress {...mineProgress} />
          </div>
          {mine.length === 0 ? (
            <p className="premium-card p-6 text-center text-xs text-neutral-500">
              You have no daily duties set. {canDefine ? 'Add one above.' : 'Your department head sets these.'}
            </p>
          ) : (
            <div className="premium-card p-0 overflow-hidden divide-y divide-neutral-100 dark:divide-neutral-900/60">
              {mine.map((i) => (
                <DutyRow key={i.id} item={i} today={today} onTick={setTick}
                  canEdit={canDefine} onEdit={() => setEditing({ id: i.id, employeeId: i.employee_id, title: i.title, detail: i.detail, sortOrder: i.sort_order })}
                  onRetire={() => retire.mutate(i.id)} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* Then the team, worst first. */}
      {seesTeam && others.length > 0 && (
        <section className="space-y-2.5">
          <h2 className="text-2xs font-bold uppercase tracking-widest text-neutral-450 dark:text-neutral-500 px-1">
            The team today <span className="font-mono opacity-70">· {others.length}</span>
          </h2>
          {/* Paged by PERSON, never by duty: a card is one person's whole day, and splitting one
              across a page boundary would show half a checklist and a progress bar that disagrees
              with it. Fifty people at ten duties each is five hundred rows in one screen. */}
          {teamPager.slice.map((g) => (
            <div key={g.employeeId} className="premium-card space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-sm text-neutral-800 dark:text-slate-100">
                  {g.employee?.full_name ?? 'Someone'}
                  <span className="font-mono text-2xs text-neutral-500"> · {g.employee?.employee_code}</span>
                </span>
                <Progress {...g} />
              </div>
              <div className="divide-y divide-neutral-100 dark:divide-neutral-900/60">
                {g.list.map((i) => (
                  <DutyRow key={i.id} item={i} today={today} onTick={setTick} compact
                    canEdit={canDefine}
                    onEdit={() => setEditing({ id: i.id, employeeId: i.employee_id, title: i.title, detail: i.detail, sortOrder: i.sort_order })}
                    onRetire={() => retire.mutate(i.id)} />
                ))}
              </div>
            </div>
          ))}
          <Pagination {...teamPager} noun="people" />
        </section>
      )}

      {mine.length === 0 && others.length === 0 && !editing && (
        <div className="premium-card p-10 text-center text-xs text-neutral-500 space-y-1.5">
          <p className="font-semibold text-neutral-700 dark:text-neutral-300">No daily routines yet.</p>
          <p>
            {canDefine
              ? 'Add the duties somebody does every day — check the mould temperature, log the scrap weight.'
              : 'Your department head sets these.'}
          </p>
        </div>
      )}
    </div>
  );
}

function Progress({ done, total, complete, pct }) {
  if (!total) return null;
  return (
    <span className={`text-2xs font-mono font-bold px-2 py-0.5 rounded-full border shrink-0 ${
      complete
        ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900/30'
        : pct === 0
        ? 'bg-neutral-100 text-neutral-500 border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800'
        : 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/30'
    }`}>
      {done}/{total}
    </span>
  );
}

/** One duty. The checkbox IS the control — no dropdown, no status, just done or not. */
function DutyRow({ item, today, onTick, canEdit, onEdit, onRetire, compact = false }) {
  const Icon = item.done ? CheckSquare : Square;
  return (
    <div className={`flex items-center justify-between gap-3 ${compact ? 'py-2' : 'px-4 py-3'}`}>
      <button
        type="button"
        onClick={() => onTick.mutate({ itemId: item.id, employeeId: item.employee_id, onDate: today, done: !item.done })}
        aria-pressed={item.done}
        aria-label={`${item.done ? 'Untick' : 'Tick'} ${item.title}`}
        className="flex items-center gap-2.5 min-w-0 text-left cursor-pointer group"
      >
        <Icon size={17} className={`shrink-0 ${item.done ? 'text-[#0ea971]' : 'text-neutral-300 dark:text-neutral-600 group-hover:text-neutral-500'}`} />
        <span className="min-w-0">
          <span className={`block text-sm font-semibold truncate ${item.done ? 'text-neutral-400 line-through' : 'text-neutral-800 dark:text-neutral-200'}`}>
            {item.title}
          </span>
          {item.detail && <span className="block text-2xs text-neutral-500 truncate">{item.detail}</span>}
        </span>
      </button>
      {canEdit && (
        <span className="flex items-center gap-1 shrink-0">
          <button type="button" onClick={onEdit} title="Edit duty" aria-label={`Edit ${item.title}`}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-900 dark:hover:text-white cursor-pointer">
            <PenLine size={12} />
          </button>
          <button type="button" onClick={onRetire} title="Retire duty" aria-label={`Retire ${item.title}`}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-red-500 cursor-pointer">
            <Trash2 size={12} />
          </button>
        </span>
      )}
    </div>
  );
}

function DutyForm({ employees, initial, onClose, onDone }) {
  const save = useSaveRoutineItem();
  const [employeeId, setEmployeeId] = useState(initial.employeeId ?? '');
  const [title, setTitle] = useState(initial.title ?? '');
  const [detail, setDetail] = useState(initial.detail ?? '');
  const [sortOrder, setSortOrder] = useState(initial.sortOrder ?? 0);
  const [q, setQ] = useState('');

  const chosen = employees.find((e) => e.id === employeeId);
  // Was `.slice(0, 8)`: a search matching thirty people showed eight of them and said nothing
  // about the other twenty-two, so the right person simply was not there. Page instead of truncate.
  const results = q.trim()
    ? employees.filter((e) => (e.full_name || '').toLowerCase().includes(q.trim().toLowerCase())
        || (e.employee_code || '').toLowerCase().includes(q.trim().toLowerCase()))
    : [];
  const resultsPager = usePagination(results, 8);

  return (
    <FormSection
      title={initial.id ? 'Edit duty' : 'Add a daily duty'}
      subtitle="Something that comes back tomorrow. Ticks reset overnight."
      icon={CheckSquare}
      onClose={onClose}
      onSubmit={async (e) => {
        e.preventDefault();
        try { await save.mutateAsync({ id: initial.id, employeeId, title, detail, sortOrder }); onDone(); }
        catch { /* shown */ }
      }}
      submitLabel={initial.id ? 'Save duty' : 'Add duty'}
      busy={save.isPending}
      error={humanDbError(save.error, 'routine_items')}
      disabled={!employeeId || !title.trim()}
    >
      <div className="space-y-3">
        <div className="space-y-1">
          <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">Whose routine</label>
          {chosen ? (
            <div className="flex items-center justify-between rounded-xl bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 px-3 py-2 text-xs">
              <span className="font-semibold text-neutral-800 dark:text-neutral-200">
                {chosen.full_name}<span className="font-mono text-2xs text-neutral-500"> · {chosen.employee_code}</span>
              </span>
              {!initial.id && (
                <button type="button" onClick={() => { setEmployeeId(''); setQ(''); }} className="text-neutral-400 hover:text-red-500 cursor-pointer"><X size={14} /></button>
              )}
            </div>
          ) : (
            <>
              <input className={INPUT} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or code…" />
              {results.length > 0 && (
                <div className="mt-1 border border-neutral-200 dark:border-neutral-850 rounded-xl divide-y divide-neutral-150 dark:divide-neutral-850/60">
                  {resultsPager.slice.map((e) => (
                    <button key={e.id} type="button" onClick={() => setEmployeeId(e.id)}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900 flex justify-between cursor-pointer">
                      <span className="font-semibold text-neutral-800 dark:text-neutral-200">{e.full_name}</span>
                      <span className="font-mono text-2xs text-neutral-500">{e.employee_code}</span>
                    </button>
                  ))}
                </div>
              )}
              {results.length > 0 && <Pagination {...resultsPager} noun="people" />}
            </>
          )}
        </div>

        <div className="space-y-1">
          <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">The duty</label>
          <input autoFocus className={INPUT} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Check the mould temperature" required />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1 sm:col-span-2">
            <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">Detail (optional)</label>
            <input className={INPUT} value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Before the first run of the shift" />
          </div>
          <div className="space-y-1">
            <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">Order</label>
            <input type="number" className={INPUT} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
          </div>
        </div>
      </div>
    </FormSection>
  );
}
