// Attendance administration: shifts, holidays, leave types, device mapping and sync monitoring.
//
// The Devices & Mapping tab is the important one. BioTime emp_codes are device enrolment numbers
// and do not match employee_code, so until a code is mapped to a person their punches sit in
// raw_punches unattached. This is where that gets resolved — confirming a suggested match also
// adopts the historical punches and recomputes the affected dates.
import React, { useMemo, useState } from 'react';
import {
  Clock, CalendarDays, Fingerprint, Activity, Loader2, Plus, Trash2, Check, X,
  RefreshCw, AlertTriangle, Search, Server, Wifi, WifiOff, Download, Palmtree,
} from 'lucide-react';
import { useShifts, useSaveShift, useDeleteShift, WEEKDAYS } from '../data/shifts';
import { useHolidayCalendars, useHolidays, useSaveHoliday, useDeleteHoliday } from '../data/holidays';
import { useLeaveTypes, useSaveLeaveType } from '../data/leaveTypes';
import {
  useDevices, useSaveDevice, useDeviceMappings, useMappingCounts, useLinkDeviceCode,
  useRefreshSuggestions, useEmployeeSearch, LINK_STATUS_LABELS, LINK_STATUS_STYLES,
} from '../data/devices';
import {
  useServiceStatus, useSyncState, useSyncRuns, useTriggerSync, useTriggerBackfill,
  useSyncHealth, useServiceCommands, SYNC_LEVEL, RUN_STATUS_STYLES, relativeTime,
} from '../data/syncStatus';
import { useOrg } from '../data/org';
import { todayIso } from '../data/attendance';
import { usePermissions } from '../auth/usePermissions';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';
import { useUrlTab } from '../lib/useUrlTab';

const TABS = [
  { id: 'mapping', label: 'Devices & mapping', icon: Fingerprint, perm: 'device.manage' },
  { id: 'shifts', label: 'Shifts', icon: Clock, perm: 'shift.manage' },
  { id: 'holidays', label: 'Holidays', icon: Palmtree, perm: 'holiday.manage' },
  { id: 'leaveTypes', label: 'Leave types', icon: CalendarDays, perm: 'leave.manage' },
  { id: 'sync', label: 'Sync status', icon: Activity, perm: 'device.manage' },
];

const input =
  'bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 px-3 py-1.5 rounded-xl text-xs w-full';
const label = 'block text-2xs uppercase tracking-wider text-neutral-500';
const btnPrimary = btnClass('primary');
const btnGhost =
  'px-3 py-2 rounded-xl bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 text-xs font-bold flex items-center gap-1.5 disabled:opacity-50';

function Note({ error, success }) {
  if (error) {
    return (
      <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        <span>{error.message || String(error)}</span>
      </div>
    );
  }
  if (success) return <p className="text-xs text-emerald-600 dark:text-emerald-400">{success}</p>;
  return null;
}

// ---------------------------------------------------------------------------
// Devices & mapping
// ---------------------------------------------------------------------------

function SuggestionRow({ mapping, onLink, isPending }) {
  const [search, setSearch] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const { data: results = [] } = useEmployeeSearch(search);

  const suggestions = Array.isArray(mapping.match_suggestions) ? mapping.match_suggestions : [];

  return (
    <tr>
      <td className="font-mono font-bold">{mapping.emp_code}</td>
      <td>
        <div className="font-semibold text-neutral-800 dark:text-neutral-100">{mapping.full_name ?? '—'}</div>
        <div className="text-2xs text-neutral-400">
          {[mapping.department_name, mapping.area_name].filter(Boolean).join(' · ')}
        </div>
      </td>
      <td>
        <span className={`badge ${LINK_STATUS_STYLES[mapping.link_status] ?? 'badge-muted'}`}>
          {LINK_STATUS_LABELS[mapping.link_status] ?? mapping.link_status}
        </span>
      </td>
      <td>
        {mapping.employee ? (
          <div>
            <div className="font-semibold text-emerald-700 dark:text-emerald-400">{mapping.employee.full_name}</div>
            <div className="text-2xs text-neutral-400 font-mono">{mapping.employee.employee_code}</div>
          </div>
        ) : (
          <span className="text-xs text-neutral-400">Not mapped</span>
        )}
      </td>
      <td>
        <div className="space-y-1">
          {!showSearch && suggestions.slice(0, 3).map((s) => (
            <button
              key={s.employee_id}
              onClick={() => onLink({ empCode: mapping.emp_code, employeeId: s.employee_id })}
              disabled={isPending}
              className="w-full text-left px-2 py-1 rounded-lg bg-neutral-100 dark:bg-neutral-900 hover:bg-emerald-100 dark:hover:bg-emerald-950/40 text-xs flex items-center justify-between gap-2 disabled:opacity-50"
              title={`Match reason: ${s.reason}`} aria-label={`Match reason: ${s.reason}`}
            >
              <span className="truncate">{s.full_name}</span>
              <span className="font-mono text-2xs text-neutral-400 shrink-0">
                {Math.round((s.score ?? 0) * 100)}%
              </span>
            </button>
          ))}

          {!showSearch && suggestions.length === 0 && (
            <span className="text-xs text-neutral-400">No name match found</span>
          )}

          {showSearch && (
            <div className="space-y-1">
              <div className="relative">
                <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search employee…"
                  className="w-full bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 pl-7 pr-2 py-1 rounded-lg text-xs"
                />
              </div>
              {results.slice(0, 5).map((emp) => (
                <button
                  key={emp.id}
                  onClick={() => onLink({ empCode: mapping.emp_code, employeeId: emp.id })}
                  disabled={isPending}
                  className="w-full text-left px-2 py-1 rounded-lg bg-neutral-100 dark:bg-neutral-900 hover:bg-emerald-100 dark:hover:bg-emerald-950/40 text-xs truncate disabled:opacity-50"
                >
                  {emp.full_name}
                  <span className="text-neutral-400 font-mono ml-1">{emp.employee_code}</span>
                </button>
              ))}
            </div>
          )}

          <button
            onClick={() => setShowSearch(!showSearch)}
            className="text-2xs text-neutral-500 hover:text-emerald-600 underline"
          >
            {showSearch ? 'Show suggestions' : 'Search manually'}
          </button>
        </div>
      </td>
      <td className="text-right whitespace-nowrap">
        {mapping.employee_id && (
          <button
            onClick={() => onLink({ empCode: mapping.emp_code, employeeId: null })}
            disabled={isPending}
            className="px-2 py-1 rounded-lg bg-neutral-200 dark:bg-neutral-800 text-2xs font-bold mr-1 disabled:opacity-50"
            title="Remove the link" aria-label="Remove the link"
          >
            Unlink
          </button>
        )}
        {mapping.link_status !== 'ignored' && (
          <button
            onClick={() => onLink({ empCode: mapping.emp_code, employeeId: null, ignore: true })}
            disabled={isPending}
            className="px-2 py-1 rounded-lg bg-neutral-200 dark:bg-neutral-800 text-2xs font-bold disabled:opacity-50"
            title="A device-only enrolment (guard, test finger, ex-staff)" aria-label="A device-only enrolment (guard, test finger, ex-staff)"
          >
            Ignore
          </button>
        )}
      </td>
    </tr>
  );
}

function MappingTab() {
  const [status, setStatus] = useState('unmatched');
  const { data: mappings = [], isLoading } = useDeviceMappings(status || undefined);
  const { data: counts } = useMappingCounts();
  const link = useLinkDeviceCode();
  const refreshSuggestions = useRefreshSuggestions();
  const syncEmployees = useTriggerSync();

  const { data: devices = [] } = useDevices();
  const saveDevice = useSaveDevice();
  const { data: org } = useOrg();
  const branches = org?.branches ?? [];

  // Branch mapping only decides something when two terminals could report the same device code.
  // With one terminal it is a 48-option dropdown whose every answer is equally meaningless — so
  // show it once a second terminal appears, or if somebody has already mapped one.
  const showBranchMapping = devices.length > 1 || devices.some((d) => d.branch_id);

  // Device mappings scale with headcount — 242 people means 242 rows to reconcile.
  const pager = usePagination(mappings);

  const filters = [
    { id: 'unmatched', label: `Needs mapping (${counts?.unmatched ?? 0})` },
    { id: 'ambiguous', label: `Ambiguous (${counts?.ambiguous ?? 0})` },
    { id: 'manual', label: `Confirmed (${(counts?.manual ?? 0) + (counts?.auto ?? 0)})` },
    { id: 'ignored', label: `Ignored (${counts?.ignored ?? 0})` },
    { id: '', label: `All (${counts?.total ?? 0})` },
  ];

  return (
    <div className="space-y-4">
      <div className="premium-card space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => syncEmployees.mutate('employees')} disabled={syncEmployees.isPending} className={btnPrimary}>
            {syncEmployees.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Pull roster from BioTime
          </button>
          <button onClick={() => refreshSuggestions.mutate()} disabled={refreshSuggestions.isPending} className={btnGhost}>
            {refreshSuggestions.isPending ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
            Recompute suggestions
          </button>
        </div>

        <p className="text-xs text-neutral-500">
          BioTime device codes are enrolment numbers, not HR employee codes, so they have to be
          matched to people once. Suggestions are ranked by name similarity — confirming one also
          attaches every punch already stored under that code and recomputes those dates.
        </p>

        <Note error={syncEmployees.error || refreshSuggestions.error || link.error} />
        {link.isSuccess && (
          <Note success={`Mapped. ${link.data?.punchesAdopted ?? 0} historical punches attached${link.data?.recomputedFrom ? ` (${link.data.recomputedFrom} … ${link.data.recomputedTo} recomputing)` : ''}.`} />
        )}

        <div className="flex flex-wrap gap-1.5">
          {filters.map((f) => (
            <button
              key={f.id || 'all'}
              onClick={() => setStatus(f.id)}
              className={`chip text-xs ${status === f.id ? 'ring-1 ring-emerald-500 text-emerald-700 dark:text-emerald-300' : ''}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="premium-card overflow-hidden">
        {isLoading ? (
          <div className="p-10 flex justify-center text-neutral-400"><Loader2 className="animate-spin" size={18} /></div>
        ) : mappings.length === 0 ? (
          <div className="p-10 text-center text-xs text-neutral-500">
            Nothing here. If this is the first run, pull the roster from BioTime above.
          </div>
        ) : (
          <div className="table-scroll">
            <div className="table-scroll -mx-1 px-1"><table className="premium-table w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left">Code</th>
                  <th className="text-left">BioTime name</th>
                  <th className="text-left">Status</th>
                  <th className="text-left">Mapped to</th>
                  <th className="text-left">Suggestions</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pager.slice.map((m) => (
                  <SuggestionRow key={m.id} mapping={m} onLink={link.mutate} isPending={link.isPending} />
                ))}
                <Pagination {...pager} noun="mappings" />
              </tbody>
            </table></div>
          </div>
        )}
      </div>

      <div className="premium-card space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-200 flex items-center gap-1.5">
          <Server size={13} /> Terminals
        </h3>
        {/* Everything here is reported by the terminal itself. The branch column is ours, not the
            device's, and a dropdown of 48 branches against a single terminal is 47 wrong answers
            and a lot of noise — so it only appears once there is more than one terminal, which is
            the only situation where mapping one to a branch decides anything. */}
        <p className="text-xs text-neutral-500">
          {showBranchMapping
            ? 'As reported by Easy Time Pro. Map each terminal to its branch so the same device code in two companies cannot be confused for one person.'
            : 'As reported by Easy Time Pro. Connect a second terminal and a branch column appears here for telling them apart.'}
        </p>

        {devices.length === 0 ? (
          <p className="text-xs text-neutral-500">No terminals seen yet.</p>
        ) : (
          <div className="table-scroll">
            <div className="table-scroll -mx-1 px-1"><table className="premium-table w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left">Serial</th>
                  <th className="text-left">Name</th>
                  <th className="text-left">Area</th>
                  <th className="text-left">Address</th>
                  <th className="text-left">Last punch</th>
                  <th className="text-left">Last seen</th>
                  {showBranchMapping && <th className="text-left">Branch</th>}
                  <th className="text-left">State</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id}>
                    <td className="font-mono text-2xs">{d.serial_number}</td>
                    <td>{d.alias ?? '—'}</td>
                    <td className="text-neutral-500">{d.area_name ?? '—'}</td>
                    <td className="font-mono text-2xs text-neutral-500">{d.ip_address ?? '—'}</td>
                    <td className="text-neutral-500">{relativeTime(d.last_punch_at)}</td>
                    <td className="text-neutral-500">{relativeTime(d.last_seen_at)}</td>
                    {showBranchMapping && (
                      <td>
                        <select
                          value={d.branch_id ?? ''}
                          aria-label={`Branch for terminal ${d.serial_number}`}
                          onChange={(e) =>
                            saveDevice.mutate({
                              id: d.id,
                              branch_id: e.target.value || null,
                              entity_id: branches.find((b) => b.id === e.target.value)?.entity_id ?? null,
                            })
                          }
                          className="bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 px-2 py-1 rounded-lg text-xs"
                        >
                          <option value="">— unmapped —</option>
                          {branches.map((b) => (
                            <option key={b.id} value={b.id}>{b.name ?? b.code}</option>
                          ))}
                        </select>
                      </td>
                    )}
                    <td>
                      {d.is_active ? (
                        <span className="badge badge-green flex items-center gap-1 w-fit"><Wifi size={10} /> active</span>
                      ) : (
                        <span className="badge badge-muted flex items-center gap-1 w-fit"><WifiOff size={10} /> inactive</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

const BLANK_SHIFT = {
  code: '', name: '', start_time: '09:30', end_time: '18:30',
  grace_in_minutes: 15, grace_out_minutes: 15, break_minutes: 60,
  weekly_offs: [0], full_day_minutes: 480, half_day_minutes: 240,
  ot_after_minutes: 30, min_ot_minutes: 30, is_default: false, is_active: true,
};

function ShiftsTab() {
  const { data: shifts = [], isLoading } = useShifts();
  const save = useSaveShift();
  const remove = useDeleteShift();
  const [form, setForm] = useState(null);

  // Mirrors the shifts_full_day_reachable_check constraint, so the user sees the problem while
  // typing instead of getting a database error on save.
  const reachable = useMemo(() => {
    if (!form) return { max: 0, ok: true };
    const toMin = (t) => {
      const [h = 0, m = 0] = String(t).split(':').map(Number);
      return h * 60 + m;
    };
    const start = toMin(form.start_time);
    const end = toMin(form.end_time);
    const span = end <= start ? end - start + 1440 : end - start;
    const max = span - (Number(form.break_minutes) || 0);
    return { max, ok: (Number(form.full_day_minutes) || 0) <= max };
  }, [form]);

  const submit = (e) => {
    e.preventDefault();
    save.mutate(form, { onSuccess: () => setForm(null) });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-xs text-neutral-500 max-w-2xl">
          A shift defines the scheduled window, the grace either side, the unpaid break, and the
          weekly offs. Employees without an explicit assignment fall back to the default shift.
        </p>
        <button onClick={() => setForm({ ...BLANK_SHIFT })} className={btnPrimary}>
          <Plus size={13} /> New shift
        </button>
      </div>

      {form && (
        <form onSubmit={submit} className="premium-card space-y-3 animate-fade-in">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className={label}>Code
              <input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} className={input} />
            </label>
            <label className={label}>Name
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} />
            </label>
            <label className={label}>Start
              <input required type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} className={input} />
            </label>
            <label className={label}>End
              <input required type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} className={input} />
            </label>
            <label className={label}>Grace in (min)
              <input type="number" value={form.grace_in_minutes} onChange={(e) => setForm({ ...form, grace_in_minutes: e.target.value })} className={input} />
            </label>
            <label className={label}>Grace out (min)
              <input type="number" value={form.grace_out_minutes} onChange={(e) => setForm({ ...form, grace_out_minutes: e.target.value })} className={input} />
            </label>
            <label className={label}>Unpaid break (min)
              <input type="number" value={form.break_minutes} onChange={(e) => setForm({ ...form, break_minutes: e.target.value })} className={input} />
            </label>
            <label className={label}>Full day (min)
              <input type="number" value={form.full_day_minutes} onChange={(e) => setForm({ ...form, full_day_minutes: e.target.value })}
                className={`${input} ${reachable.ok ? '' : 'border-red-400 dark:border-red-700'}`} />
            </label>
            <label className={label}>Half day (min)
              <input type="number" value={form.half_day_minutes} onChange={(e) => setForm({ ...form, half_day_minutes: e.target.value })} className={input} />
            </label>
            <label className={label}>OT starts after (min)
              <input type="number" value={form.ot_after_minutes} onChange={(e) => setForm({ ...form, ot_after_minutes: e.target.value })} className={input} />
            </label>
            <label className={label}>Minimum OT (min)
              <input type="number" value={form.min_ot_minutes} onChange={(e) => setForm({ ...form, min_ot_minutes: e.target.value })} className={input} />
            </label>
          </div>

          {!reachable.ok && (
            <Note error={{ message: `A full day of ${form.full_day_minutes} min is impossible in this shift — only ${reachable.max} min are workable once the break is deducted. Everyone on it would be marked Half Day.` }} />
          )}

          <div>
            <span className={label}>Weekly offs</span>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {WEEKDAYS.map((d, i) => {
                const on = (form.weekly_offs ?? []).includes(i);
                return (
                  <button key={d} type="button"
                    onClick={() => setForm({
                      ...form,
                      weekly_offs: on ? form.weekly_offs.filter((x) => x !== i) : [...(form.weekly_offs ?? []), i].sort(),
                    })}
                    className={`chip text-xs ${on ? 'ring-1 ring-emerald-500 text-emerald-700 dark:text-emerald-300' : ''}`}>
                    {d}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} />
            Default shift (used when an employee has no assignment)
          </label>

          <Note error={save.error} />

          <div className="flex gap-2">
            <button type="submit" disabled={save.isPending || !reachable.ok} className={btnPrimary}>
              {save.isPending ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
            </button>
            <button type="button" onClick={() => setForm(null)} className={btnGhost}><X size={13} /> Cancel</button>
          </div>
        </form>
      )}

      <div className="premium-card overflow-hidden">
        {isLoading ? (
          <div className="p-10 flex justify-center text-neutral-400"><Loader2 className="animate-spin" size={18} /></div>
        ) : (
          <div className="table-scroll">
            <div className="table-scroll -mx-1 px-1"><table className="premium-table w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left">Code</th>
                  <th className="text-left">Name</th>
                  <th className="text-left">Window</th>
                  <th className="text-left">Grace</th>
                  <th className="text-left">Break</th>
                  <th className="text-left">Weekly offs</th>
                  <th className="text-left">Full day</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {shifts.map((s) => (
                  <tr key={s.id}>
                    <td className="font-mono font-bold">
                      {s.code}
                      {s.is_default ? <span className="badge badge-green ml-1.5">default</span> : null}
                    </td>
                    <td>{s.name}</td>
                    <td className="font-mono">
                      {String(s.start_time).slice(0, 5)}–{String(s.end_time).slice(0, 5)}
                      {s.crosses_midnight ? <span className="text-2xs text-amber-600 ml-1">+1d</span> : null}
                    </td>
                    <td className="font-mono">{s.grace_in_minutes}/{s.grace_out_minutes}m</td>
                    <td className="font-mono">{s.break_minutes}m</td>
                    <td>{(s.weekly_offs ?? []).map((d) => WEEKDAYS[d]).join(', ') || '—'}</td>
                    <td className="font-mono">{s.full_day_minutes}m</td>
                    <td className="text-right whitespace-nowrap">
                      <button onClick={() => setForm({ ...s, start_time: String(s.start_time).slice(0, 5), end_time: String(s.end_time).slice(0, 5) })}
                        className="px-2 py-1 rounded-lg bg-neutral-200 dark:bg-neutral-800 text-2xs font-bold mr-1">Edit</button>
                      <button onClick={() => { if (confirm(`Delete shift ${s.code}?`)) remove.mutate(s.id); }}
                        className="px-2 py-1 rounded-lg bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-2xs font-bold">
                        <Trash2 size={10} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}
        <Note error={remove.error} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

function HolidaysTab() {
  const year = new Date().getFullYear();
  const [activeYear, setActiveYear] = useState(year);
  const { data: calendars = [] } = useHolidayCalendars();
  const [calendarId, setCalendarId] = useState('');
  const effectiveCalendar = calendarId || calendars.find((c) => c.is_default)?.id || calendars[0]?.id || '';

  const { data: holidays = [], isLoading } = useHolidays(effectiveCalendar || undefined, activeYear);
  const save = useSaveHoliday();
  const remove = useDeleteHoliday();
  const [form, setForm] = useState(null);

  const submit = (e) => {
    e.preventDefault();
    save.mutate({ ...form, calendar_id: effectiveCalendar }, { onSuccess: () => setForm(null) });
  };

  return (
    <div className="space-y-4">
      <div className="premium-card flex flex-wrap items-end gap-3">
        <label className={label}>Calendar
          <select value={effectiveCalendar} onChange={(e) => setCalendarId(e.target.value)} className={`${input} min-w-50`}>
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.entity ? ` (${c.entity.code})` : ''}</option>
            ))}
          </select>
        </label>
        <label className={label}>Year
          <input type="number" value={activeYear} onChange={(e) => setActiveYear(Number(e.target.value))} className={`${input} w-24`} />
        </label>
        <button onClick={() => setForm({ holiday_date: `${activeYear}-01-01`, name: '', is_optional: false })} className={btnPrimary}>
          <Plus size={13} /> Add holiday
        </button>
      </div>

      {form && (
        <form onSubmit={submit} className="premium-card space-y-3 animate-fade-in">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className={label}>Date
              <input required type="date" value={form.holiday_date} onChange={(e) => setForm({ ...form, holiday_date: e.target.value })} className={input} />
            </label>
            <label className={label}>Name
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Onam" className={input} />
            </label>
            <label className="flex items-end gap-2 text-xs pb-1.5">
              <input type="checkbox" checked={form.is_optional} onChange={(e) => setForm({ ...form, is_optional: e.target.checked })} />
              Optional / restricted
            </label>
          </div>
          <p className="text-2xs text-neutral-500">
            Optional holidays are treated as normal working days by the engine unless the employee
            takes leave for them.
          </p>
          <Note error={save.error} />
          <div className="flex gap-2">
            <button type="submit" disabled={save.isPending} className={btnPrimary}>
              {save.isPending ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
            </button>
            <button type="button" onClick={() => setForm(null)} className={btnGhost}><X size={13} /> Cancel</button>
          </div>
        </form>
      )}

      <div className="premium-card overflow-hidden">
        {isLoading ? (
          <div className="p-10 flex justify-center text-neutral-400"><Loader2 className="animate-spin" size={18} /></div>
        ) : holidays.length === 0 ? (
          <div className="p-10 text-center text-xs text-neutral-500">No holidays defined for {activeYear}.</div>
        ) : (
          <div className="table-scroll">
            <div className="table-scroll -mx-1 px-1"><table className="premium-table w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left">Date</th>
                  <th className="text-left">Day</th>
                  <th className="text-left">Name</th>
                  <th className="text-left">Type</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {holidays.map((h) => (
                  <tr key={h.id}>
                    <td className="font-mono">{h.holiday_date}</td>
                    <td className="text-neutral-500">
                      {new Date(`${h.holiday_date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' })}
                    </td>
                    <td className="font-semibold">{h.name}</td>
                    <td>
                      <span className={`badge ${h.is_optional ? 'badge-muted' : 'badge-green'}`}>
                        {h.is_optional ? 'Optional' : 'Company'}
                      </span>
                    </td>
                    <td className="text-right">
                      <button onClick={() => setForm(h)} className="px-2 py-1 rounded-lg bg-neutral-200 dark:bg-neutral-800 text-2xs font-bold mr-1">Edit</button>
                      <button onClick={() => { if (confirm(`Delete ${h.name}?`)) remove.mutate(h.id); }}
                        className="px-2 py-1 rounded-lg bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-2xs font-bold">
                        <Trash2 size={10} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leave types
// ---------------------------------------------------------------------------

const BLANK_TYPE = {
  code: '', name: '', annual_quota: 12, is_paid: true, allow_half_day: true,
  carry_forward: false, max_carry_forward: 0, requires_approval: true,
  deducts_balance: true, colour: '#0ea971', sort_order: 0, is_active: true,
};

function LeaveTypesTab() {
  const { data: types = [], isLoading } = useLeaveTypes();
  const save = useSaveLeaveType();
  const [form, setForm] = useState(null);

  const submit = (e) => {
    e.preventDefault();
    save.mutate(form, { onSuccess: () => setForm(null) });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-xs text-neutral-500 max-w-2xl">
          When an approved leave exceeds the available balance, the excess automatically becomes
          loss of pay rather than being rejected.
        </p>
        <button onClick={() => setForm({ ...BLANK_TYPE })} className={btnPrimary}><Plus size={13} /> New type</button>
      </div>

      {form && (
        <form onSubmit={submit} className="premium-card space-y-3 animate-fade-in">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className={label}>Code
              <input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} className={input} />
            </label>
            <label className={label}>Name
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} />
            </label>
            <label className={label}>Annual quota (days)
              <input type="number" step="0.5" value={form.annual_quota} onChange={(e) => setForm({ ...form, annual_quota: e.target.value })} className={input} />
            </label>
            <label className={label}>Max carry forward
              <input type="number" step="0.5" value={form.max_carry_forward} onChange={(e) => setForm({ ...form, max_carry_forward: e.target.value })} className={input} />
            </label>
          </div>
          <div className="flex flex-wrap gap-4 text-xs">
            {[
              ['is_paid', 'Paid'],
              ['allow_half_day', 'Allows half day'],
              ['carry_forward', 'Carries forward'],
              ['deducts_balance', 'Draws on a balance'],
              ['requires_approval', 'Needs approval'],
            ].map(([key, text]) => (
              <label key={key} className="flex items-center gap-1.5">
                <input type="checkbox" checked={Boolean(form[key])} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} />
                {text}
              </label>
            ))}
          </div>
          <Note error={save.error} />
          <div className="flex gap-2">
            <button type="submit" disabled={save.isPending} className={btnPrimary}>
              {save.isPending ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
            </button>
            <button type="button" onClick={() => setForm(null)} className={btnGhost}><X size={13} /> Cancel</button>
          </div>
        </form>
      )}

      <div className="premium-card overflow-hidden">
        {isLoading ? (
          <div className="p-10 flex justify-center text-neutral-400"><Loader2 className="animate-spin" size={18} /></div>
        ) : (
          <div className="table-scroll">
            <div className="table-scroll -mx-1 px-1"><table className="premium-table w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left">Code</th>
                  <th className="text-left">Name</th>
                  <th className="text-left">Quota</th>
                  <th className="text-left">Paid</th>
                  <th className="text-left">Half day</th>
                  <th className="text-left">Carry fwd</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.id}>
                    <td className="font-mono font-bold" style={t.colour ? { color: t.colour } : undefined}>{t.code}</td>
                    <td>{t.name}</td>
                    <td className="font-mono">{t.annual_quota}</td>
                    <td>{t.is_paid ? <span className="badge badge-green">paid</span> : <span className="badge badge-muted">unpaid</span>}</td>
                    <td>{t.allow_half_day ? 'Yes' : 'No'}</td>
                    <td>{t.carry_forward ? `Up to ${t.max_carry_forward}` : 'No'}</td>
                    <td className="text-right">
                      <button onClick={() => setForm(t)} className="px-2 py-1 rounded-lg bg-neutral-200 dark:bg-neutral-800 text-2xs font-bold">Edit</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

/** One readable line from a command's result, whatever shape that command returns. */
function summariseResult(r) {
  if (!r || typeof r !== 'object') return '';
  const bits = [];
  if (r.inserted != null) bits.push(`${r.inserted} new punches`);
  if (r.fetched != null && r.inserted == null) bits.push(`${r.fetched} fetched`);
  if (r.created != null) bits.push(`${r.created} created`);
  if (r.updated != null) bits.push(`${r.updated} updated`);
  if (r.autoLinked != null) bits.push(`${r.autoLinked} auto-linked`);
  if (r.rowsWritten != null) bits.push(`${r.rowsWritten} days rebuilt`);
  if (r.employees != null) bits.push(`${r.employees} employees`);
  // A kind whose result shape nothing above recognises still deserves to show something.
  return bits.join(' · ') || JSON.stringify(r).slice(0, 120);
}

function SyncTab() {
  const { data: status, error: statusError } = useServiceStatus();
  const { data: health } = useSyncHealth();
  const { data: commands = [] } = useServiceCommands(6);
  const { data: state = [] } = useSyncState();
  const { data: runs = [] } = useSyncRuns(25);
  const level = SYNC_LEVEL[health?.level] ?? {
    label: 'Checking…', tone: 'text-neutral-400', hint: '',
  };
  const trigger = useTriggerSync();
  const backfill = useTriggerBackfill();

  // Dates in IST, not toISOString() (UTC): between 00:00 and 05:30 IST the UTC date is yesterday.
  const [range, setRange] = useState(() => {
    const to = todayIso();
    const from = new Date(`${to}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 30);
    return { from: from.toISOString().slice(0, 10), to };
  });

  const punchState = state.find((s) => s.key === 'transactions');

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* Judged from what reached the database, not from whether this browser can reach the HR
            laptop. The two are different questions and only one of them matters. */}
        <div className="premium-card">
          <div className="text-xs font-bold uppercase tracking-wider text-neutral-500">Easy Time Pro sync</div>
          <div className={`mt-2 text-sm font-bold ${level.tone}`}>{level.label}</div>
          <div className="text-2xs text-neutral-400 mt-0.5">{level.hint}</div>
        </div>
        <div className="premium-card">
          <div className="text-xs font-bold uppercase tracking-wider text-neutral-500">Last punch sync</div>
          <div className="mt-2 text-sm font-bold">{relativeTime(health?.lastSuccess)}</div>
          {health?.consecutiveFailures > 0 ? (
            <div className="text-2xs text-red-500 mt-0.5">{health.consecutiveFailures} consecutive failures</div>
          ) : health?.lastPunchTime ? (
            <div className="text-2xs text-neutral-400 mt-0.5">newest punch {relativeTime(health.lastPunchTime)}</div>
          ) : null}
        </div>
        <div className="premium-card">
          <div className="text-xs font-bold uppercase tracking-wider text-neutral-500">Punches today</div>
          <div className="mt-2 text-2xl font-black font-mono">{health?.punchesToday ?? '—'}</div>
        </div>
        <div className="premium-card">
          <div className="text-xs font-bold uppercase tracking-wider text-neutral-500">Unmapped punches</div>
          <div className={`mt-2 text-2xl font-black font-mono ${health?.punchesUnmapped ? 'text-amber-600 dark:text-amber-400' : ''}`}>
            {health?.punchesUnmapped ?? '—'}
          </div>
        </div>
      </div>

      {/* The buttons below post to the service directly, which needs to be on the same network.
          Say so once, here, instead of letting every button fail with a bare network error. */}
      {statusError && health?.level === 'ok' ? (
        <div className="premium-card border-amber-300 dark:border-amber-900/60">
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Syncing normally, but this browser cannot reach the sync service directly
            {status?.biotime?.url ? '' : ''} — so the manual buttons below (sync now, backfill,
            recompute) will not work from here. They need a browser on the office network. Nothing
            is broken: punches are arriving on their own.
          </p>
        </div>
      ) : null}

      {health?.lastError ? (
        <div className="premium-card border-red-300 dark:border-red-900/60">
          <div className="text-xs font-bold uppercase tracking-wider text-red-600 dark:text-red-400 mb-1">Last error</div>
          <p className="text-xs font-mono text-red-700 dark:text-red-300 break-words">{health.lastError}</p>
        </div>
      ) : null}

      {punchState?.last_error && punchState.last_error !== health?.lastError ? (
        <div className="premium-card border-red-300 dark:border-red-900/60">
          <div className="text-xs font-bold uppercase tracking-wider text-red-600 dark:text-red-400 mb-1">Last error</div>
          <p className="text-xs font-mono text-red-700 dark:text-red-300 break-words">{punchState.last_error}</p>
        </div>
      ) : null}

      <div className="premium-card space-y-3">
        <div className="flex flex-wrap gap-2">
          <button onClick={() => trigger.mutate('transactions')} disabled={trigger.isPending} className={btnPrimary}>
            {trigger.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Sync punches now
          </button>
          <button onClick={() => trigger.mutate('employees')} disabled={trigger.isPending} className={btnGhost}>
            <RefreshCw size={13} /> Sync roster
          </button>
        </div>

        <div className="soft-divider" />

        <div className="flex flex-wrap items-end gap-3">
          <label className={label}>Backfill from
            <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className={input} />
          </label>
          <label className={label}>To
            <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className={input} />
          </label>
          <button onClick={() => backfill.mutate({ ...range, recompute: true })} disabled={backfill.isPending} className={btnGhost}>
            {backfill.isPending ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Backfill history
          </button>
        </div>

        <Note error={trigger.error || backfill.error} />
        {/* These no longer run in the request — they are queued for the service, which collects
            them within about twenty seconds. So the confirmation says "asked for", and the outcome
            arrives in the list below rather than here. */}
        {(trigger.isSuccess || backfill.isSuccess) && (
          <Note success="Queued. The service picks this up within about 20 seconds — the result appears below." />
        )}
      </div>

      {/* Requests and what became of them.
          Without this the queue was invisible: three commands sat pending for forty minutes because
          the service was running a build with no command worker, and the only symptom anyone saw
          was the button refusing to work with "already queued or running". */}
      <div className="premium-card space-y-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-200">
          Requests
        </h3>
        {commands.length === 0 ? (
          <p className="text-xs text-neutral-500">Nothing requested yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {commands.map((c) => {
              const waiting = c.status === 'pending' || c.status === 'running';
              return (
                <li key={c.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                  <span className={`badge ${RUN_STATUS_STYLES[c.status === 'done' ? 'success' : c.status === 'failed' ? 'failed' : 'running']}`}>
                    {c.status === 'pending' ? 'queued' : c.status}
                  </span>
                  <span className="font-semibold text-neutral-800 dark:text-neutral-100">
                    {c.kind.replace(/_/g, ' ')}
                  </span>
                  <span className="text-neutral-400">{relativeTime(c.requested_at)}</span>
                  {waiting && <Loader2 size={11} className="animate-spin text-neutral-400" />}
                  {c.error_message && (
                    <span className="text-red-600 dark:text-red-400 basis-full">{c.error_message}</span>
                  )}
                  {c.status === 'done' && c.result && (
                    <span className="text-neutral-500 basis-full font-mono text-2xs">
                      {summariseResult(c.result)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="premium-card overflow-hidden">
        <div className="p-4 pb-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-200">Recent sync runs</h3>
        </div>
        {runs.length === 0 ? (
          <div className="p-10 text-center text-xs text-neutral-500">No runs recorded yet.</div>
        ) : (
          <div className="table-scroll">
            <div className="table-scroll -mx-1 px-1"><table className="premium-table w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left">Started</th>
                  <th className="text-left">Kind</th>
                  <th className="text-left">Status</th>
                  <th className="text-left">Fetched</th>
                  <th className="text-left">Inserted</th>
                  <th className="text-left">Skipped</th>
                  <th className="text-left">Duration</th>
                  <th className="text-left">Error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="text-neutral-500">{relativeTime(r.started_at)}</td>
                    <td className="font-mono">{r.kind}</td>
                    <td><span className={`badge ${RUN_STATUS_STYLES[r.status] ?? 'badge-muted'}`}>{r.status}</span></td>
                    <td className="font-mono">{r.records_fetched}</td>
                    <td className="font-mono text-emerald-600 dark:text-emerald-400">{r.records_inserted}</td>
                    <td className="font-mono text-neutral-400">{r.records_skipped}</td>
                    <td className="font-mono">{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                    <td className="max-w-55 truncate text-red-600 dark:text-red-400" title={r.error_message ?? ''} aria-label={r.error_message ?? ''}>
                      {r.error_message ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function AttendanceAdmin() {
  const { canAny } = usePermissions();
  const visible = TABS.filter((t) => !t.perm || canAny(t.perm));
  // In the URL, so a refresh comes back to the tab you were reading. Validated against the
  // tabs this user can actually see, so a link to one they lack permission for lands on the
  // first they do rather than on an empty page.
  const [tab, setTab] = useUrlTab(visible[0]?.id ?? 'mapping', visible.map((t) => t.id));

  if (visible.length === 0) {
    return (
      <div className="page-shell premium-card p-10 text-center text-xs text-neutral-500">
        You do not have permission to administer attendance.
      </div>
    );
  }

  return (
    <div className="page-shell space-y-5 animate-slide-up py-3">
      <div>
        <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">Attendance setup</h1>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
          Shifts, holidays, leave types, and the BioTime device connection.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {visible.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`drawer-tab flex items-center gap-1.5 ${tab === t.id ? 'drawer-tab-active' : ''}`}>
              <Icon size={13} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'mapping' ? <MappingTab /> : null}
      {tab === 'shifts' ? <ShiftsTab /> : null}
      {tab === 'holidays' ? <HolidaysTab /> : null}
      {tab === 'leaveTypes' ? <LeaveTypesTab /> : null}
      {tab === 'sync' ? <SyncTab /> : null}
    </div>
  );
}
