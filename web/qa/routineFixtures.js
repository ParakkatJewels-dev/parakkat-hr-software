// Isolated recurring routine scenarios. SQL tests cover authorization and recurrence correctness;
// these in-memory replies exercise the real forms, Home widgets, filters, pagination and refetches.
import { fixture, tables, today, mobileFixtures } from './fixtures';
import { addDays } from '../src/lib/dateRange';

export const routineFixtures = new URL(window.location.href).searchParams.has('qa-routines');
const stamp = () => new Date().toISOString();
const historyStart = addDays(today, -30);
tables.routine_sets ??= [];

if (routineFixtures) {
  const ownCompany = fixture.employees[0].entity_id;
  const people = fixture.employees.filter(person => person.entity_id === ownCompany).slice(0, 34);
  const designations = [{ id: 'qa-des-sales', title: 'Sales Associate' }, { id: 'qa-des-cashier', title: 'Cashier' }];
  for (const [index, person] of people.entries()) Object.assign(person, { designation_id: designations[index % 2].id, designation: designations[index % 2] });
  const make = (person, id, title, frequency, jobs, extra = {}) => {
    const set = { id, batch_id: 'qa-routine-batch', employee_id: person.id, employee: person,
      entity_id: person.entity_id, zone_id: person.zone_id, branch_id: person.branch_id, department_id: person.department_id,
      title, detail: 'Synthetic checklist for recurring routine verification.', frequency,
      start_date: addDays(today, -6), end_date: null, weekdays: [1, 2, 3, 4, 5], month_day: 31, interval_days: 3,
      retired_on: null, history_start_date: historyStart, created_at: stamp(), ...extra };
    tables.routine_sets.push(set);
    jobs.forEach((title, index) => tables.routine_items.push({ id: `${id}-job-${index}`, routine_id: id, employee_id: person.id,
      title, detail: index === 0 ? 'Confirm the check before marking this job complete.' : null, sort_order: index, is_active: true }));
    return set;
  };
  tables.routine_items = []; tables.routine_ticks = [];
  people.forEach((person, index) => {
    const set = make(person, `qa-set-${String(index).padStart(2, '0')}`, 'Daily opening checklist', 'daily', ['Check opening stock', 'Prepare the handover notes', 'Verify the safety checklist']);
    for (let day = -6; day <= 0; day++) for (let job = 0; job < (index % 3 === 0 ? 3 : 1); job++) {
      tables.routine_ticks.push({ id: `${set.id}-tick-${day}-${job}`, routine_item_id: `${set.id}-job-${job}`, employee_id: person.id, on_date: addDays(today, day), done_at: stamp() });
    }
  });
  // The signed-in employee has jobs left to complete on Home.
  tables.routine_ticks = tables.routine_ticks.filter(tick => !(tick.employee_id === people[0].id && tick.on_date === today && !tick.routine_item_id.endsWith('-0')));
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay() || 7;
  make(people[0], 'qa-weekly-own', 'Weekly stock review', 'weekly', ['Count high-value stock', 'Submit the weekly stock report'], { weekdays: [weekday] });
  make(people[0], 'qa-monthly-own', 'Monthly reconciliation', 'monthly', ['Reconcile the stock ledger'], { month_day: Number(today.slice(8)) });
  make(people[0], 'qa-future-own', 'Quarterly review preparation', 'once', ['Prepare review documents'], { start_date: addDays(today, 5) });
} else if (mobileFixtures) {
  const employees = [...new Set(tables.routine_items.filter(row => row.is_active).map(row => row.employee_id))];
  employees.forEach(employeeId => {
    const employee = fixture.employees.find(person => person.id === employeeId);
    tables.routine_sets.push({ id: `qa-daily-${employeeId}`, employee_id: employeeId, employee, title: 'Daily duties',
      frequency: 'daily', start_date: today, end_date: null, retired_on: null, history_start_date: today });
    tables.routine_items.filter(row => row.employee_id === employeeId && row.is_active).forEach(row => { row.routine_id = `qa-daily-${employeeId}`; });
  });
}

function due(set, day) {
  if (!day || day < set.start_date || (set.end_date && day > set.end_date) || (set.retired_on && day > set.retired_on)) return false;
  const date = new Date(`${day}T12:00:00Z`);
  if (set.frequency === 'once') return day === set.start_date;
  if (set.frequency === 'weekly') return (set.weekdays ?? []).includes(date.getUTCDay() || 7);
  if (set.frequency === 'monthly') return date.getUTCDate() === Math.min(Number(set.month_day), new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate());
  if (set.frequency === 'interval') return Math.round((date - new Date(`${set.start_date}T12:00:00Z`)) / 86400000) % Number(set.interval_days) === 0;
  return true;
}

export function routineRpc(name, args, { employee, role, allows, event, canWrite }) {
  const person = id => fixture.employees.find(row => row.id === id);
  const scope = set => ({ ...set, ...person(set.employee_id), employee_id: set.employee_id });
  const readable = () => tables.routine_sets.filter(set => allows('task.read', scope(set)));
  const jobs = id => tables.routine_items.filter(job => job.routine_id === id && job.is_active !== false);
  const sets = () => readable().map(set => ({ ...set, employee: person(set.employee_id), jobs: jobs(set.id), can_manage: allows('task.create', scope(set)) }));
  const dayRows = day => sets().filter(set => due(set, day)).flatMap(set => set.jobs.map(job => ({ ...job,
    routine_name: set.title, employee: set.employee, frequency: set.frequency, weekdays: set.weekdays,
    month_day: set.month_day, interval_days: set.interval_days, start_date: set.start_date, end_date: set.end_date,
    on_date: day, can_manage: set.can_manage,
    done: tables.routine_ticks.some(tick => tick.routine_item_id === job.id && tick.on_date === day),
    can_tick: day <= today && (role !== 'employee' || day === today) && allows('task.update', scope(set)),
  })));
  if (name === 'list_routine_sets') return { rows: sets().filter(set => (!args._employee_id || set.employee_id === args._employee_id)
    && (args._include_retired || ((!set.retired_on || set.retired_on >= today) && (!set.end_date || set.end_date >= today)
      && (set.frequency !== 'once' || set.start_date >= today)))) };
  if (name === 'routine_day') return { rows: dayRows(args._on_date).filter(row => !args._employee_id || row.employee_id === args._employee_id) };
  if (name === 'routine_completion_stats') {
    const end = args._to < today ? args._to : today;
    if (!args._from || !args._to || args._from > args._to || new Date(`${args._to}T12:00:00Z`) - new Date(`${args._from}T12:00:00Z`) > 365 * 86400000) return { error: { message: 'Choose a date range of up to 366 days.' } };
    const rows = sets().filter(set => !args._employee_ids || args._employee_ids.includes(set.employee_id)).map(set => {
      let scheduled = 0, completed = 0, missed = 0, pending = 0;
      for (let day = args._from; day <= end; day = addDays(day, 1)) {
        if (!due(set, day)) continue;
        for (const job of set.jobs) {
          scheduled++;
          if (tables.routine_ticks.some(tick => tick.routine_item_id === job.id && tick.on_date === day)) completed++;
          else if (day < today) missed++; else pending++;
        }
      }
      return { id: set.id, routine_id: set.id, routine_name: set.title, employee_id: set.employee_id, employee: set.employee,
        frequency: set.frequency, scheduled, completed, missed, pending, total_jobs: scheduled, done_jobs: completed,
        pct: scheduled ? Math.round(completed / scheduled * 100) : 0, history_start_date: set.history_start_date, unscored_done_jobs: 0 };
    });
    return { rows: rows.filter(row => row.scheduled) };
  }
  const writes = ['create_routine_set', 'replace_routine_set', 'retire_routine_set', 'set_routine_job_tick'];
  if (!writes.includes(name)) return undefined;
  if (!(routineFixtures || mobileFixtures) || !canWrite) return { error: { message: 'QA mode: this write is intentionally blocked.' } };
  if (name === 'set_routine_job_tick') {
    const job = dayRows(args._on_date).find(row => row.id === args._item_id);
    if (!job?.can_tick) return { error: { message: 'This job is not due or cannot be changed by this account.' } };
    const existing = tables.routine_ticks.find(row => row.routine_item_id === job.id && row.on_date === args._on_date);
    if (args._done && !existing) {
      const tick = { id: crypto.randomUUID(), routine_item_id: job.id, employee_id: job.employee_id, on_date: args._on_date, done_at: stamp(), done_by: employee.id };
      tables.routine_ticks.push(tick); event('routine_ticks', 'INSERT', tick);
    } else if (!args._done && existing) {
      tables.routine_ticks.splice(tables.routine_ticks.indexOf(existing), 1); event('routine_ticks', 'DELETE', {}, existing);
    }
    return { one: true, rows: [], mutated: true };
  }
  const previous = sets().find(set => set.id === args._id);
  if (name !== 'create_routine_set' && !previous?.can_manage) return { error: { message: 'This routine is outside your assignment scope.' } };
  if (name === 'retire_routine_set') {
    const row = tables.routine_sets.find(set => set.id === previous.id);
    row.retired_on = today; event('routine_sets', 'UPDATE', row, previous);
    return { one: true, rows: [], mutated: true };
  }
  const ids = name === 'create_routine_set' ? [...new Set(args._employee_ids ?? [])] : [previous.employee_id];
  if (!ids.length || !args._title?.trim() || !args._jobs?.length || !args._schedule?.start_date
      || ids.some(id => !person(id) || !allows('task.create', { ...person(id), employee_id: id }))) return { error: { message: 'Choose valid jobs and employees in your assignment scope.' } };
  if (args._schedule.start_date < (previous ? addDays(today, 1) : today)) return { error: { message: 'Choose an available start date.' } };
  if (previous) {
    const row = tables.routine_sets.find(set => set.id === previous.id);
    row.retired_on = addDays(args._schedule.start_date, -1); event('routine_sets', 'UPDATE', row, previous);
  }
  const batchId = crypto.randomUUID(); const routineIds = [];
  for (const id of ids) {
    const set = { id: crypto.randomUUID(), batch_id: batchId, employee_id: id, employee: person(id), title: args._title,
      detail: args._detail, ...args._schedule, retired_on: null, history_start_date: args._schedule.start_date, created_at: stamp() };
    tables.routine_sets.push(set); routineIds.push(set.id);
    args._jobs.forEach((job, index) => tables.routine_items.push({ id: crypto.randomUUID(), routine_id: set.id, employee_id: id,
      title: job.title, detail: job.detail, sort_order: job.sort_order ?? index, is_active: true }));
    event('routine_sets', 'INSERT', set);
  }
  return { one: true, rows: [previous ? routineIds[0] : { batch_id: batchId, routine_ids: routineIds, assigned_count: ids.length }], mutated: true };
}
