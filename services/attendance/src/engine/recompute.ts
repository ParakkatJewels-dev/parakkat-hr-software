// Engine orchestration: load everything a date range needs, run the rules, write the results.
//
// Idempotent by contract — recomputing a range overwrites those rows cleanly, so rules can change
// and history can be re-derived. The only rows it will not touch are ones flagged is_locked,
// which is how a finalized payroll month is protected from a later rule change.
//
// Written as a batch loader rather than a per-day query loop: a month for 250 staff is ~7,750
// employee-dates, and doing four queries each would be 31,000 round trips.
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { eachWorkDate, punchWindowBounds, toWorkDate, resolveRecomputeRange } from './windows';
import { todayWorkDate } from '../lib/time';
import { processDay } from './processDay';
import { punchWindow } from './processDay';
import type { DayInput, DayResult, LeaveOverlay, PunchRecord, ShiftDefinition } from './types';
import { SyncRun } from '../sync/runLog';

export interface RecomputeScope {
  from: string;
  to: string;
  /** Restrict to specific employees; omit for everyone active. */
  employeeIds?: string[];
  /** Recompute even rows marked is_locked. Off by default and never on by accident. */
  includeLocked?: boolean;
}

export interface RecomputeSummary {
  employees: number;
  dates: number;
  rowsWritten: number;
  skippedLocked: number;
  durationMs: number;
  statusCounts: Record<string, number>;
}

interface EmployeeRow {
  id: string;
  entity_id: string;
  branch_id: string | null;
  /** 'yyyy-MM-dd', or null when nobody has recorded when this person started. */
  join_date: string | null;
}

interface AssignmentRow {
  employee_id: string;
  shift_id: string;
  effective_from: Date;
  effective_to: Date | null;
}

// ---------------------------------------------------------------------------
// loaders
// ---------------------------------------------------------------------------

async function loadShifts(): Promise<Map<string, ShiftDefinition>> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      code: string;
      name: string;
      start_time: string;
      end_time: string;
      crosses_midnight: boolean;
      grace_in_minutes: number;
      grace_out_minutes: number;
      break_minutes: number;
      break_policy: string;
      weekly_offs: number[];
      full_day_minutes: number;
      half_day_minutes: number;
      ot_after_minutes: number;
      min_ot_minutes: number;
      missed_punch_policy: string;
      late_absent_minutes: number;
      early_absent_minutes: number;
      ot_basis: string;
      is_flexible: boolean;
      short_day_tolerance_minutes: number;
    }>
  >`
    select id, code, name,
           start_time::text  as start_time,
           end_time::text    as end_time,
           crosses_midnight, grace_in_minutes, grace_out_minutes, break_minutes, break_policy,
           weekly_offs, full_day_minutes, half_day_minutes, ot_after_minutes, min_ot_minutes, ot_basis,
           missed_punch_policy, late_absent_minutes, early_absent_minutes, is_flexible,
           short_day_tolerance_minutes
      from public.shifts
     where is_active
  `;

  const map = new Map<string, ShiftDefinition>();
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      code: r.code,
      name: r.name,
      startTime: r.start_time,
      endTime: r.end_time,
      crossesMidnight: r.crosses_midnight,
      graceInMinutes: r.grace_in_minutes,
      graceOutMinutes: r.grace_out_minutes,
      breakMinutes: r.break_minutes,
      breakPolicy:
        r.break_policy === 'actual' || r.break_policy === 'actual_over_allowance' || r.break_policy === 'excess'
          ? r.break_policy
          : 'fixed',
      weeklyOffs: Array.isArray(r.weekly_offs) ? r.weekly_offs : [],
      fullDayMinutes: r.full_day_minutes,
      halfDayMinutes: r.half_day_minutes,
      otAfterMinutes: r.ot_after_minutes,
      minOtMinutes: r.min_ot_minutes,
      missedPunchPolicy: r.missed_punch_policy === 'present' ? 'present' : 'exception',
      lateAbsentMinutes: r.late_absent_minutes,
      earlyAbsentMinutes: r.early_absent_minutes,
      otBasis: r.ot_basis === 'worked' ? 'worked' : 'schedule',
      isFlexible: r.is_flexible === true,
      shortDayToleranceMinutes: r.short_day_tolerance_minutes ?? 30,
    });
  }
  return map;
}

async function loadEmployees(employeeIds?: string[]): Promise<EmployeeRow[]> {
  if (employeeIds && employeeIds.length === 0) return [];

  return employeeIds && employeeIds.length
    ? prisma.$queryRaw<EmployeeRow[]>`
        select id, entity_id, branch_id, to_char(join_date, 'YYYY-MM-DD') as join_date
          from public.employees
         where id = any(${employeeIds}::uuid[])
      `
    : prisma.$queryRaw<EmployeeRow[]>`
        select id, entity_id, branch_id, to_char(join_date, 'YYYY-MM-DD') as join_date
          from public.employees
         where status = 'Active'
      `;
}

/** employee -> their effective-dated assignments, newest first. */
async function loadAssignments(from: string, to: string): Promise<Map<string, AssignmentRow[]>> {
  const rows = await prisma.$queryRaw<AssignmentRow[]>`
    select employee_id, shift_id, effective_from, effective_to
      from public.employee_shift_assignments
     where effective_from <= ${to}::date
       and (effective_to is null or effective_to >= ${from}::date)
     order by effective_from desc
  `;

  const map = new Map<string, AssignmentRow[]>();
  for (const r of rows) {
    const list = map.get(r.employee_id) ?? [];
    list.push(r);
    map.set(r.employee_id, list);
  }
  return map;
}

/** entity_id (or '' for the global fallback) -> default shift id. */
async function loadDefaultShifts(): Promise<Map<string, string>> {
  const rows = await prisma.$queryRaw<Array<{ entity_id: string | null; id: string }>>`
    select entity_id, id from public.shifts where is_default and is_active
  `;
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.entity_id ?? '', r.id);
  return map;
}

/** employee -> calendar id, resolved once per run rather than per day. */
async function loadCalendarByEmployee(employeeIds: string[]): Promise<Map<string, string>> {
  if (employeeIds.length === 0) return new Map();

  const rows = await prisma.$queryRaw<Array<{ id: string; calendar_id: string | null }>>`
    select e.id, public.calendar_for_employee(e.id) as calendar_id
      from public.employees e
     where e.id = any(${employeeIds}::uuid[])
  `;

  const map = new Map<string, string>();
  for (const r of rows) if (r.calendar_id) map.set(r.id, r.calendar_id);
  return map;
}

/** 'calendarId|yyyy-MM-dd' -> holiday name. Optional holidays are excluded: they are not days off. */
async function loadHolidays(from: string, to: string): Promise<Map<string, string>> {
  const rows = await prisma.$queryRaw<Array<{ calendar_id: string; holiday_date: Date; name: string }>>`
    select calendar_id, holiday_date, name
      from public.holidays
     where holiday_date between ${from}::date and ${to}::date
       and not is_optional
  `;

  const map = new Map<string, string>();
  for (const r of rows) {
    const d = r.holiday_date.toISOString().slice(0, 10);
    map.set(`${r.calendar_id}|${d}`, r.name);
  }
  return map;
}

/** 'employeeId|yyyy-MM-dd' -> the approved leave covering it. */
async function loadLeaves(from: string, to: string, employeeIds: string[]): Promise<Map<string, LeaveOverlay>> {
  if (employeeIds.length === 0) return new Map();

  // leave_types / day_fraction arrive in 0014; left-joined so this works before that migration and
  // degrades to "approved leave = a full paid day".
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      employee_id: string;
      start_date: Date;
      end_date: Date;
      type: string;
      is_lop: boolean | null;
      is_paid: boolean | null;
      day_fraction: number | null;
    }>
  >`
    select l.id, l.employee_id, l.start_date, l.end_date, l.type,
           coalesce(l.is_lop, false)                as is_lop,
           coalesce(lt.is_paid, true)               as is_paid,
           coalesce(l.day_fraction, 1)::float8      as day_fraction
      from public.leaves l
      left join public.leave_types lt on lt.code = l.type
     where l.status = 'Approved'
       and l.employee_id = any(${employeeIds}::uuid[])
       and l.start_date <= ${to}::date
       and l.end_date   >= ${from}::date
  `;

  const map = new Map<string, LeaveOverlay>();
  for (const r of rows) {
    for (const d of eachWorkDate(
      r.start_date.toISOString().slice(0, 10),
      r.end_date.toISOString().slice(0, 10)
    )) {
      if (d < from || d > to) continue;
      map.set(`${r.employee_id}|${d}`, {
        id: r.id,
        type: r.type,
        dayFraction: Number(r.day_fraction ?? 1),
        isLop: Boolean(r.is_lop),
        isPaid: r.is_paid !== false,
      });
    }
  }
  return map;
}

/** 'employeeId|yyyy-MM-dd' -> approved regularization. */
async function loadRegularizations(
  from: string,
  to: string,
  employeeIds: string[]
): Promise<Map<string, { id: string; checkIn: Date | null; checkOut: Date | null }>> {
  if (employeeIds.length === 0) return new Map();

  try {
    const rows = await prisma.$queryRaw<
      Array<{ id: string; employee_id: string; work_date: Date; check_in: Date | null; check_out: Date | null }>
    >`
      select id, employee_id, work_date, check_in, check_out
        from public.attendance_regularizations
       where status = 'Approved'
         and employee_id = any(${employeeIds}::uuid[])
         and work_date between ${from}::date and ${to}::date
    `;

    const map = new Map<string, { id: string; checkIn: Date | null; checkOut: Date | null }>();
    for (const r of rows) {
      map.set(`${r.employee_id}|${r.work_date.toISOString().slice(0, 10)}`, {
        id: r.id,
        checkIn: r.check_in,
        checkOut: r.check_out,
      });
    }
    return map;
  } catch {
    // Table arrives in 0014; before then there is simply nothing to overlay.
    return new Map();
  }
}

/** employee -> punches in the whole (window-widened) range, sorted. */
async function loadPunches(from: Date, to: Date, employeeIds: string[]): Promise<Map<string, PunchRecord[]>> {
  if (employeeIds.length === 0) return new Map();

  const rows = await prisma.$queryRaw<
    Array<{
      id: bigint;
      employee_id: string;
      punch_time: Date;
      punch_state: string | null;
      terminal_sn: string | null;
      terminal_alias: string | null;
    }>
  >`
    select id, employee_id, punch_time, punch_state, terminal_sn, terminal_alias
      from public.raw_punches
     where employee_id = any(${employeeIds}::uuid[])
       and punch_time >= ${from}
       and punch_time <  ${to}
     order by employee_id, punch_time
  `;

  const map = new Map<string, PunchRecord[]>();
  for (const r of rows) {
    const list = map.get(r.employee_id) ?? [];
    list.push({
      id: r.id,
      punchTime: r.punch_time,
      punchState: r.punch_state,
      terminalSn: r.terminal_sn,
      terminalAlias: r.terminal_alias,
    });
    map.set(r.employee_id, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// writer
// ---------------------------------------------------------------------------

const WRITE_CHUNK = 400;

/**
 * Bulk upsert on (employee_id, work_date).
 *
 * `employee_id = excluded.employee_id` in the UPDATE set looks redundant but is load-bearing: the
 * ancestry trigger fires `before update of employee_id`, so touching that column is what re-stamps
 * entity/zone/branch/department when someone transfers branch. Without it, a transferred
 * employee's recomputed history keeps their old branch and disappears from their new manager's view.
 */
async function writeResults(results: DayResult[], includeLocked: boolean): Promise<{ written: number; skippedLocked: number }> {
  if (results.length === 0) return { written: 0, skippedLocked: 0 };

  let written = 0;

  for (let i = 0; i < results.length; i += WRITE_CHUNK) {
    const chunk = results.slice(i, i + WRITE_CHUNK);

    const values = chunk.map(
      (r) => Prisma.sql`(
        ${r.employeeId}::uuid, ${r.workDate}::date, ${r.shiftId}::uuid, ${r.status},
        ${r.dayType}, ${r.checkIn}, ${r.checkOut}, ${r.firstPunchAt}, ${r.lastPunchAt},
        ${r.punchCount}, ${r.scheduledIn}, ${r.scheduledOut}, ${r.hours},
        ${r.workedMinutes}, ${r.lateMinutes}, ${r.earlyExitMinutes}, ${r.otMinutes},
        ${r.isLate}, ${r.isEarlyExit}, ${r.isMissingPunch},
        ${r.leaveId}::uuid, ${r.leaveType}, ${r.isLop}, ${r.dayFraction},
        ${r.regularizationId}::uuid, ${r.source}, ${r.remarks}, now(),
        ${JSON.stringify(r.punches.map((d) => d.toISOString()))}::jsonb,
        ${r.breakMinutes}, ${r.breaksIncomplete},
        ${r.isShortDay}, ${r.isLongBreak}
      )`
    );

    const lockGuard = includeLocked ? Prisma.sql`` : Prisma.sql`where public.attendance.is_locked = false`;

    const affected = await prisma.$executeRaw`
      insert into public.attendance (
        employee_id, work_date, shift_id, status, day_type, check_in, check_out,
        first_punch_at, last_punch_at, punch_count, scheduled_in, scheduled_out, hours,
        worked_minutes, late_minutes, early_exit_minutes, ot_minutes,
        is_late, is_early_exit, is_missing_punch,
        leave_id, leave_type, is_lop, day_fraction, regularization_id, source, remarks, computed_at,
        punches, break_minutes, breaks_incomplete,
        is_short_day, is_long_break
      )
      values ${Prisma.join(values)}
      on conflict (employee_id, work_date) do update set
        employee_id        = excluded.employee_id,
        shift_id           = excluded.shift_id,
        status             = excluded.status,
        day_type           = excluded.day_type,
        check_in           = excluded.check_in,
        check_out          = excluded.check_out,
        first_punch_at     = excluded.first_punch_at,
        last_punch_at      = excluded.last_punch_at,
        punch_count        = excluded.punch_count,
        scheduled_in       = excluded.scheduled_in,
        scheduled_out      = excluded.scheduled_out,
        hours              = excluded.hours,
        worked_minutes     = excluded.worked_minutes,
        late_minutes       = excluded.late_minutes,
        early_exit_minutes = excluded.early_exit_minutes,
        ot_minutes         = excluded.ot_minutes,
        is_late            = excluded.is_late,
        is_early_exit      = excluded.is_early_exit,
        is_missing_punch   = excluded.is_missing_punch,
        leave_id           = excluded.leave_id,
        leave_type         = excluded.leave_type,
        is_lop             = excluded.is_lop,
        day_fraction       = excluded.day_fraction,
        regularization_id  = excluded.regularization_id,
        source             = excluded.source,
        remarks            = excluded.remarks,
        computed_at        = excluded.computed_at,
        punches            = excluded.punches,
        break_minutes      = excluded.break_minutes,
        breaks_incomplete  = excluded.breaks_incomplete,
        is_short_day       = excluded.is_short_day,
        is_long_break      = excluded.is_long_break
      ${lockGuard}
    `;

    written += affected;
  }

  return { written, skippedLocked: results.length - written };
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

export async function recompute(scope: RecomputeScope): Promise<RecomputeSummary> {
  const startedAt = Date.now();
  // The instant this whole run describes. Taken once so that a recompute spanning several minutes
  // does not have its first employee judged against a different "now" than its last.
  const runStartedAt = new Date(startedAt);

  // A day that has not happened cannot be attendance, and must never be scored as an absence.
  //
  // Nothing stopped it before: asking for `--month 2026-07` on the 29th wrote two more days of
  // "Absent" for all 162 employees, because a future date has no punches and no punches on a
  // working day is an absence. 324 rows saying the whole company failed to turn up tomorrow —
  // which then drag down every attendance rate that counts them.
  //
  // Clamped here rather than in processDay: the engine is pure, and giving it a hidden dependency
  // on the current time would make the same input stop producing the same result. The ordering and
  // clamping rules, and the two ways they have already gone wrong, live in resolveRecomputeRange.
  const { from, to } = resolveRecomputeRange(scope.from, scope.to, todayWorkDate());

  const dates = eachWorkDate(from, to);
  if (dates.length === 0) {
    throw new Error(`invalid date range: ${scope.from} .. ${scope.to}`);
  }

  const run = await SyncRun.start('engine', { from, to });

  try {
    const employees = await loadEmployees(scope.employeeIds);
    const employeeIds = employees.map((e) => e.id);

    if (employeeIds.length === 0) {
      await run.finish('success');
      return {
        employees: 0,
        dates: dates.length,
        rowsWritten: 0,
        skippedLocked: 0,
        durationMs: Date.now() - startedAt,
        statusCounts: {},
      };
    }

    const [shifts, assignments, defaultShifts, calendars, holidays, leaves, regularizations] =
      await Promise.all([
        loadShifts(),
        loadAssignments(from, to),
        loadDefaultShifts(),
        loadCalendarByEmployee(employeeIds),
        loadHolidays(from, to),
        loadLeaves(from, to, employeeIds),
        loadRegularizations(from, to, employeeIds),
      ]);

    // Widen the punch query to cover night shifts spilling past either end of the range.
    const { from: punchFrom, to: punchTo } = punchWindowBounds(from, to);
    const punchesByEmployee = await loadPunches(punchFrom, punchTo, employeeIds);

    // Results are flushed in batches: a full-year recompute would otherwise hold 264 x 365
    // objects (~100 MB) before the single write at the end.
    const FLUSH_AT = 5_000;
    let results: DayResult[] = [];
    const statusCounts: Record<string, number> = {};
    let written = 0;
    let skippedLocked = 0;
    let totalProcessed = 0;
    const flush = async (): Promise<void> => {
      if (results.length === 0) return;
      const r = await writeResults(results, scope.includeLocked ?? false);
      written += r.written;
      skippedLocked += r.skippedLocked;
      totalProcessed += results.length;
      results = [];
    };

    // Punches for an employee arrive sorted by punch_time (see loadPunches), so the window for a
    // day can be found by binary search instead of scanning every punch for every date — that
    // inner filter made a year-long recompute O(dates x punches): ~140M comparisons at this size.
    const lowerBound = (arr: PunchRecord[], t: Date): number => {
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid]!.punchTime < t) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };

    for (const employee of employees) {
      const empAssignments = assignments.get(employee.id) ?? [];
      const allPunches = punchesByEmployee.get(employee.id) ?? [];
      const calendarId = calendars.get(employee.id);

      for (const workDate of dates) {
        // Nobody is absent before they were hired.
        //
        // This only bites on a long backfill. The engine computes every active employee across the
        // requested range, so pulling a year of history would otherwise open an Absent row for
        // each of today's staff on every day back to the start — months of invented absence for
        // someone who joined in March, dragging their attendance rate down and filling the
        // exceptions list with days that never existed. A null join_date means we genuinely do not
        // know, and guessing a start date would be worse than computing the day.
        if (employee.join_date && workDate < employee.join_date) continue;

        // shift in force: assignment, else entity default, else global default
        const assignment = empAssignments.find(
          (a) =>
            a.effective_from.toISOString().slice(0, 10) <= workDate &&
            (a.effective_to === null || a.effective_to.toISOString().slice(0, 10) >= workDate)
        );

        const shiftId =
          assignment?.shift_id ?? defaultShifts.get(employee.entity_id) ?? defaultShifts.get('') ?? null;
        const shift = shiftId ? shifts.get(shiftId) ?? null : null;

        const holidayName = calendarId ? holidays.get(`${calendarId}|${workDate}`) ?? null : null;

        const { from: winFrom, to: winTo } = punchWindow(workDate, shift);
        const dayPunches = [];
        for (let i = lowerBound(allPunches, winFrom); i < allPunches.length; i++) {
          const p = allPunches[i]!;
          if (p.punchTime >= winTo) break;
          dayPunches.push(p);
        }

        const input: DayInput = {
          employeeId: employee.id,
          workDate,
          shift,
          dayType: holidayName ? 'holiday' : 'working',
          holidayName,
          punches: dayPunches,
          leave: leaves.get(`${employee.id}|${workDate}`) ?? null,
          regularization: regularizations.get(`${employee.id}|${workDate}`) ?? null,
          // Read once per run, not per day, so every row in one recompute describes the same
          // instant. The engine never reads a clock itself — see DayInput.asOf.
          asOf: runStartedAt,
        };

        const result = processDay(input);
        results.push(result);
        statusCounts[result.status] = (statusCounts[result.status] ?? 0) + 1;
      }

      if (results.length >= FLUSH_AT) await flush();
    }

    await flush();

    run.counters.recordsFetched = totalProcessed;
    run.counters.recordsInserted = written;
    run.counters.recordsSkipped = skippedLocked;
    run.addDetail({ from, to, employees: employees.length, statusCounts });

    await run.finish('success');

    const summary: RecomputeSummary = {
      employees: employees.length,
      dates: dates.length,
      rowsWritten: written,
      skippedLocked,
      durationMs: Date.now() - startedAt,
      statusCounts,
    };

    logger.info(summary, 'recompute complete');
    return summary;
  } catch (err) {
    await run.finish('failed', { error: err });
    throw err;
  }
}

/**
 * Drain the recompute queue: everything a leave approval, regularization or late punch-mapping
 * flagged since the last pass. Grouped into one recompute per contiguous scope for efficiency.
 */
export async function drainRecomputeQueue(limit = 5_000): Promise<RecomputeSummary | null> {
  const pending = await prisma.$queryRaw<Array<{ id: bigint; employee_id: string | null; work_date: Date }>>`
    select id, employee_id, work_date
      from public.attendance_recompute_queue
     where processed_at is null
     order by requested_at
     limit ${limit}
  `;

  if (pending.length === 0) return null;

  // The queue is collapsed into ONE range, so two unrelated entries (a backdated leave approval
  // and today's punch fix) would span every day between them. Cap the span and leave the rest for
  // the next tick, oldest first, rather than recomputing months inside a 5-minute cron.
  const MAX_SPAN_DAYS = 31;
  const sorted = [...pending].sort(
    (a, b) => toWorkDate(a.work_date).localeCompare(toWorkDate(b.work_date))
  );
  const from = toWorkDate(sorted[0]!.work_date);
  const spanEnd = new Date(`${from}T00:00:00Z`);
  spanEnd.setUTCDate(spanEnd.getUTCDate() + MAX_SPAN_DAYS);
  const cutoff = spanEnd.toISOString().slice(0, 10);

  const batch = sorted.filter((p) => toWorkDate(p.work_date) <= cutoff);
  const deferred = sorted.length - batch.length;
  const to = toWorkDate(batch[batch.length - 1]!.work_date);

  // A null employee_id means "everybody" — resolve it explicitly so the intent is visible in the
  // logs instead of silently widening the run to every active employee.
  const explicitIds = [...new Set(batch.map((p) => p.employee_id).filter((id): id is string => !!id))];
  const allEmployees = batch.some((p) => p.employee_id === null);

  logger.info(
    { items: batch.length, deferred, employees: allEmployees ? 'all' : explicitIds.length, from, to },
    'draining recompute queue'
  );

  const summary = await recompute({
    from,
    to,
    employeeIds: allEmployees || explicitIds.length === 0 ? undefined : explicitIds,
  });

  const ids = batch.map((p) => p.id);
  await prisma.$executeRaw`
    update public.attendance_recompute_queue
       set processed_at = now()
     where id = any(${ids}::bigint[])
  `;

  return summary;
}

/** Queue an employee-date range for recompute (used by API handlers and the sync worker). */
export async function enqueueRecompute(
  employeeId: string | null,
  from: string,
  to: string,
  reason: string
): Promise<void> {
  await prisma.$executeRaw`
    select public.enqueue_recompute(${employeeId}::uuid, ${from}::date, ${to}::date, ${reason})
  `;
}
