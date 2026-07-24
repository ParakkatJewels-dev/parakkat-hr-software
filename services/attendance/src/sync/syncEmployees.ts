// Employee and device roster sync.
//
// The rule that governs this whole file: BioTime is the DEVICE layer, and public.employees is
// owned by HR. Nothing here inserts, updates or deactivates an employee. BioTime's view of a
// person lands in biotime_employees, and the only thing that crosses over is a LINK.
//
// Link policy:
//   - an exact, unambiguous employee_code match auto-links
//   - two employees sharing a code -> 'ambiguous', HR decides
//   - no code match -> 'unmatched', with ranked name suggestions for the HR mapping screen
//   - a human's 'manual' or 'ignored' decision is never overwritten
import { prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { fetchAllEmployees, fetchAllTerminals, type NormalizedBiotimeEmployee } from '../biotime/employees';
import { rankCandidates, type Candidate, type ScoredCandidate } from './matching';
import { SyncRun } from './runLog';
import { markSuccess, recordFailure } from './cursor';

/** HR employees considered for linking, loaded once per run. */
async function loadCandidates(): Promise<Candidate[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      full_name: string;
      employee_code: string | null;
      department_name: string | null;
      branch_name: string | null;
    }>
  >`
    select e.id,
           e.full_name,
           e.employee_code,
           d.name as department_name,
           b.name as branch_name
      from public.employees e
      left join public.departments d on d.id = e.department_id
      left join public.branches    b on b.id = e.branch_id
     where e.status = 'Active'
  `;

  return rows.map((r) => ({
    employeeId: r.id,
    fullName: r.full_name,
    employeeCode: r.employee_code,
    departmentName: r.department_name,
    branchName: r.branch_name,
  }));
}

/**
 * Decide the link for one device record.
 * Returns the employee id when it may be auto-linked, plus the suggestions to store either way.
 */
function decideLink(
  device: NormalizedBiotimeEmployee,
  candidates: Candidate[]
): { employeeId: string | null; linkStatus: string; suggestions: ScoredCandidate[] } {
  const exact = candidates.filter(
    (c) => c.employeeCode && c.employeeCode.toLowerCase() === device.empCode.toLowerCase()
  );

  if (exact.length === 1) {
    const only = exact[0]!;
    return {
      employeeId: only.employeeId,
      linkStatus: 'auto',
      suggestions: [
        {
          employee_id: only.employeeId,
          full_name: only.fullName,
          employee_code: only.employeeCode,
          score: 1,
          reason: 'exact code',
        },
      ],
    };
  }

  const ranked = rankCandidates(
    {
      empCode: device.empCode,
      fullName: device.fullName,
      departmentName: device.departmentName,
      areaName: device.areaName,
    },
    candidates
  );

  if (exact.length > 1) {
    // The same code in two entities — exactly the case employee_code's per-entity uniqueness allows.
    return { employeeId: null, linkStatus: 'ambiguous', suggestions: ranked };
  }

  return { employeeId: null, linkStatus: 'unmatched', suggestions: ranked };
}

export interface EmployeeSyncResult {
  fetched: number;
  created: number;
  updated: number;
  autoLinked: number;
  unmatched: number;
  ambiguous: number;
  punchesAdopted: number;
}

export async function syncEmployees(signal?: AbortSignal): Promise<EmployeeSyncResult> {
  const run = await SyncRun.start('employees');

  const result: EmployeeSyncResult = {
    fetched: 0,
    created: 0,
    updated: 0,
    autoLinked: 0,
    unmatched: 0,
    ambiguous: 0,
    punchesAdopted: 0,
  };

  try {
    const [devicePeople, candidates] = await Promise.all([fetchAllEmployees(signal), loadCandidates()]);

    result.fetched = devicePeople.length;
    run.counters.recordsFetched = devicePeople.length;
    run.counters.pagesFetched = 1;

    logger.info(
      { biotimeEmployees: devicePeople.length, hrEmployees: candidates.length },
      'roster sync: comparing BioTime enrolments against HR employees'
    );

    for (const person of devicePeople) {
      const existing = await prisma.biotimeEmployee.findUnique({
        where: { empCode: person.empCode },
        select: { id: true, linkStatus: true, employeeId: true },
      });

      // A human decision is final until a human changes it.
      const humanDecided = existing?.linkStatus === 'manual' || existing?.linkStatus === 'ignored';

      const decision = humanDecided
        ? { employeeId: existing.employeeId, linkStatus: existing.linkStatus, suggestions: [] as ScoredCandidate[] }
        : decideLink(person, candidates);

      const deviceFields = {
        biotimeId: person.biotimeId,
        firstName: person.firstName,
        lastName: person.lastName,
        fullName: person.fullName,
        departmentName: person.departmentName,
        areaName: person.areaName,
        positionName: person.positionName,
        hireDate: person.hireDate,
        isActive: person.isActive,
        raw: person.raw as object,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      };

      const linkFields = humanDecided
        ? {}
        : {
            employeeId: decision.employeeId,
            linkStatus: decision.linkStatus,
            matchSuggestions: decision.suggestions as unknown as object,
            ...(decision.employeeId && decision.linkStatus === 'auto' ? { linkedAt: new Date() } : {}),
          };

      if (existing) {
        await prisma.biotimeEmployee.update({
          where: { empCode: person.empCode },
          data: { ...deviceFields, ...linkFields },
        });
        result.updated += 1;
      } else {
        await prisma.biotimeEmployee.create({
          data: { empCode: person.empCode, ...deviceFields, ...linkFields },
        });
        result.created += 1;
      }

      if (!humanDecided) {
        if (decision.linkStatus === 'auto') result.autoLinked += 1;
        else if (decision.linkStatus === 'ambiguous') result.ambiguous += 1;
        else result.unmatched += 1;
      }

      // Newly linked? Adopt any punches already sitting unassigned under this code.
      const nowLinked = decision.employeeId && existing?.employeeId !== decision.employeeId;
      if (nowLinked) {
        const adopted = await resolvePunchLinks(person.empCode);
        result.punchesAdopted += adopted.punchesLinked;
      }
    }

    run.counters.recordsInserted = result.created;
    run.counters.unmatchedCodes = result.unmatched + result.ambiguous;
    run.addDetail(result as unknown as Record<string, unknown>);

    await syncDevices(signal);
    await markSuccess('employees');
    await run.finish('success');

    if (result.unmatched + result.ambiguous > 0) {
      logger.warn(
        { unmatched: result.unmatched, ambiguous: result.ambiguous },
        'device codes still need mapping to employees — HR > Devices & Mapping'
      );
    }

    return result;
  } catch (err) {
    await recordFailure('employees', err);
    await run.finish('failed', { error: err });
    throw err;
  }
}

/**
 * Adopt orphaned punches for a code and report the affected dates.
 * Delegates to the SQL function so the ancestry re-stamp and the date range come from one place.
 */
export async function resolvePunchLinks(empCode: string): Promise<{
  punchesLinked: number;
  employeeId: string | null;
  firstDate: string | null;
  lastDate: string | null;
}> {
  const rows = await prisma.$queryRaw<
    Array<{ punches_linked: number; employee_id: string | null; first_date: Date | null; last_date: Date | null }>
  >`select * from public.resolve_punch_links(${empCode})`;

  const row = rows[0];
  if (!row) return { punchesLinked: 0, employeeId: null, firstDate: null, lastDate: null };

  const fmt = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

  if (row.punches_linked > 0) {
    logger.info(
      { empCode, punches: row.punches_linked, from: fmt(row.first_date), to: fmt(row.last_date) },
      'adopted previously unmapped punches'
    );
  }

  return {
    punchesLinked: Number(row.punches_linked ?? 0),
    employeeId: row.employee_id,
    firstDate: fmt(row.first_date),
    lastDate: fmt(row.last_date),
  };
}

/** Refresh the terminal list. Non-fatal: devices are also created lazily from incoming punches. */
export async function syncDevices(signal?: AbortSignal): Promise<number> {
  const terminals = await fetchAllTerminals(signal);
  if (terminals.length === 0) {
    logger.debug('no terminals returned by BioTime (endpoint may not exist on this build)');
    return 0;
  }

  let count = 0;
  for (const t of terminals) {
    try {
      await prisma.device.upsert({
        where: { serialNumber: t.serialNumber },
        create: {
          serialNumber: t.serialNumber,
          alias: t.alias,
          ipAddress: t.ipAddress,
          areaName: t.areaName,
          lastSeenAt: t.lastSeenAt,
          isActive: t.isActive,
          raw: t.raw as object,
        },
        update: {
          alias: t.alias,
          ipAddress: t.ipAddress,
          areaName: t.areaName,
          lastSeenAt: t.lastSeenAt,
          isActive: t.isActive,
          raw: t.raw as object,
          updatedAt: new Date(),
          // entityId / branchId deliberately absent — HR owns the physical mapping.
        },
      });
      count += 1;
    } catch (err) {
      logger.warn({ err, sn: t.serialNumber }, 'could not upsert terminal');
    }
  }

  logger.info({ count }, 'terminals synced');
  return count;
}

/**
 * Recompute suggestions for every code still awaiting a mapping.
 * Run after a roster import adds or renames employees, so the HR queue reflects the new names.
 */
export async function refreshSuggestions(): Promise<number> {
  const pending = await prisma.biotimeEmployee.findMany({
    where: { linkStatus: { in: ['unmatched', 'ambiguous'] } },
  });
  if (pending.length === 0) return 0;

  const candidates = await loadCandidates();
  let updated = 0;

  for (const p of pending) {
    const ranked = rankCandidates(
      { empCode: p.empCode, fullName: p.fullName, departmentName: p.departmentName, areaName: p.areaName },
      candidates
    );
    await prisma.biotimeEmployee.update({
      where: { id: p.id },
      data: { matchSuggestions: ranked as unknown as object, updatedAt: new Date() },
    });
    updated += 1;
  }

  logger.info({ updated }, 'refreshed match suggestions for unmapped codes');
  return updated;
}
