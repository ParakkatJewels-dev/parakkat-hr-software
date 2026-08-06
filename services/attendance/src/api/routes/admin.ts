// Operations the frontend triggers: manual syncs, backfills, recomputes, and code mapping.
//
// The long-running ones (backfill, recompute) return 202 immediately and run in the background —
// a browser request should not be held open for four minutes while six months of history loads.
// Progress is visible through /api/status, which reads the same sync_runs rows.
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, jsonSafe } from '../../lib/db';
import { logger } from '../../lib/logger';
import { authenticate, requirePermission, resolveScopedEmployeeIds, resolveVisibleScope } from '../auth';
import { syncTransactions, catchUpTransactions, runTransactionSync } from '../../sync/syncTransactions';
import { syncEmployees, refreshSuggestions, resolvePunchLinks } from '../../sync/syncEmployees';
import { recompute, drainRecomputeQueue, enqueueRecompute } from '../../engine/recompute';
import { workDateStart, workDateEnd, todayWorkDate, eachWorkDate } from '../../lib/time';

export const adminRouter = Router();

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** Run work detached, logging failures rather than crashing the request. */
function background(label: string, fn: () => Promise<unknown>): void {
  void fn().catch((err) => logger.error({ err, task: label }, 'background task failed'));
}

/**
 * Guard for operations that cannot be narrowed to the caller's scope.
 *
 * Pulling punches off the terminal, or draining a queue somebody else filled, touches every branch
 * by construction — there is no per-branch version of it to run instead. requirePermission on its
 * own only asks whether the permission is held SOMEWHERE, and this service reads through a
 * connection that bypasses RLS, so without this a grant over one branch would drive the lot.
 *
 * Returns true when the caller was rejected, so handlers read: `if (await refuseUnlessOrgWide(...)) return;`
 */
async function refuseUnlessOrgWide(
  req: Request,
  res: Response,
  permission: string,
  what: string
): Promise<boolean> {
  const scope = await resolveVisibleScope(req.auth, [permission]);
  if (scope.all) return false;
  res.status(403).json({
    error: 'forbidden',
    message: `${what} affects every branch and needs an organisation-wide ${permission} grant.`,
  });
  return true;
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

adminRouter.post('/api/sync/transactions', authenticate, requirePermission('device.manage'), async (req, res) => {
  if (await refuseUnlessOrgWide(req, res, 'device.manage', 'A transaction sync')) return;
  try {
    const result = await syncTransactions();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: 'sync_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

adminRouter.post('/api/sync/employees', authenticate, requirePermission('device.manage'), async (req, res) => {
  if (await refuseUnlessOrgWide(req, res, 'device.manage', 'An employee sync')) return;
  try {
    const result = await syncEmployees();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: 'sync_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

adminRouter.post('/api/sync/catchup', authenticate, requirePermission('device.manage'), async (req, res) => {
  if (await refuseUnlessOrgWide(req, res, 'device.manage', 'A catch-up scan')) return;
  const days = Number(req.body?.days ?? 3);
  background('catchup', () => catchUpTransactions(Number.isFinite(days) ? days : 3));
  res.status(202).json({ ok: true, message: `Catch-up scan started for the last ${days} days.` });
});

// ---------------------------------------------------------------------------
// backfill
// ---------------------------------------------------------------------------

const backfillSchema = z.object({
  from: dateString,
  to: dateString.optional(),
  recompute: z.boolean().optional(),
});

adminRouter.post('/api/backfill', authenticate, requirePermission('device.manage'), async (req, res) => {
  if (await refuseUnlessOrgWide(req, res, 'device.manage', 'A backfill')) return;
  const parsed = backfillSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
    return;
  }

  const { from } = parsed.data;
  const to = parsed.data.to ?? todayWorkDate();

  if (from > to) {
    res.status(400).json({ error: 'invalid_range', message: '`from` is after `to`.' });
    return;
  }

  const days = eachWorkDate(from, to);

  background('backfill', async () => {
    // Weekly chunks, same reasoning as the CLI: keep each BioTime request small.
    for (let i = 0; i < days.length; i += 7) {
      const slice = days.slice(i, i + 7);
      await runTransactionSync({
        kind: 'backfill',
        source: 'backfill',
        startTime: workDateStart(slice[0]!),
        endTime: workDateEnd(slice[slice.length - 1]!),
        advanceCursorAfter: false,
        maxPages: 10_000,
      });
    }
    if (parsed.data.recompute) await recompute({ from, to });
  });

  res.status(202).json({
    ok: true,
    message: `Backfill started for ${from} .. ${to} (${days.length} days). Watch progress on the status page.`,
  });
});

// ---------------------------------------------------------------------------
// recompute
// ---------------------------------------------------------------------------

const recomputeSchema = z.object({
  from: dateString,
  to: dateString.optional(),
  employeeIds: z.array(z.string().uuid()).optional(),
  includeLocked: z.boolean().optional(),
});

adminRouter.post('/api/recompute', authenticate, requirePermission('attendance.manage'), async (req, res) => {
  const parsed = recomputeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
    return;
  }

  const { from, includeLocked } = parsed.data;
  const to = parsed.data.to ?? from;
  const days = eachWorkDate(from, to).length;

  // requirePermission only asked whether attendance.manage is held SOMEWHERE. A recompute rewrites
  // attendance rows, and this service bypasses RLS, so without this a branch manager's click would
  // rebuild every employee in the company. 0071 closed the equivalent hole on the RPC path; this is
  // the HTTP one. null means the whole organisation, which only a global grant or super admin gets.
  const scopedEmployeeIds = await resolveScopedEmployeeIds(
    req.auth,
    ['attendance.manage'],
    parsed.data.employeeIds
  );
  if (scopedEmployeeIds !== null && scopedEmployeeIds.length === 0) {
    res.status(403).json({
      error: 'forbidden',
      message:
        'No employees in your scope. A recompute needs attendance.manage over a branch, zone, ' +
        'entity or the whole organisation.',
    });
    return;
  }
  const employeeIds = scopedEmployeeIds ?? undefined;

  // A short range is fast enough to answer synchronously, which makes the UI feel immediate.
  // Anything larger goes to the background.
  if (days <= 31) {
    try {
      const summary = await recompute({ from, to, employeeIds, includeLocked });
      res.json({ ok: true, ...summary });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'recompute_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  background('recompute', () => recompute({ from, to, employeeIds, includeLocked }));
  res.status(202).json({ ok: true, message: `Recompute started for ${from} .. ${to} (${days} days).` });
});

// The queue holds whatever the sync enqueued, with no way to drain only one caller's share of it —
// so this takes an org-wide grant rather than being narrowed like /api/recompute above.
adminRouter.post('/api/recompute/queue', authenticate, requirePermission('attendance.manage'), async (req, res) => {
  if (await refuseUnlessOrgWide(req, res, 'attendance.manage', 'Draining the recompute queue')) return;
  const summary = await drainRecomputeQueue();
  res.json({ ok: true, drained: summary !== null, ...(summary ?? {}) });
});

// ---------------------------------------------------------------------------
// device code mapping
// ---------------------------------------------------------------------------

adminRouter.get('/api/mapping', authenticate, requirePermission('device.manage'), async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;

  const rows = await prisma.biotimeEmployee.findMany({
    where: status ? { linkStatus: status } : undefined,
    orderBy: [{ linkStatus: 'asc' }, { empCode: 'asc' }],
    take: 1000,
    include: { employee: { select: { id: true, fullName: true, employeeCode: true } } },
  });

  res.json(jsonSafe(rows));
});

const linkSchema = z.object({
  empCode: z.string().min(1),
  // null clears the link; 'ignored' marks a device-only enrolment.
  employeeId: z.string().uuid().nullable(),
  ignore: z.boolean().optional(),
});

/**
 * Map a device code to an employee.
 *
 * This is the step that makes historical punches meaningful, so it does three things atomically
 * from the caller's point of view: set the link, adopt the orphaned punches already stored under
 * that code, and queue those dates for recompute.
 */
adminRouter.post('/api/mapping/link', authenticate, requirePermission('device.manage'), async (req, res) => {
  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
    return;
  }

  const { empCode, employeeId, ignore } = parsed.data;

  const existing = await prisma.biotimeEmployee.findUnique({ where: { empCode } });
  if (!existing) {
    res.status(404).json({ error: 'not_found', message: `No BioTime enrolment with code ${empCode}.` });
    return;
  }

  if (employeeId) {
    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true } });
    if (!employee) {
      res.status(404).json({ error: 'not_found', message: 'That employee does not exist.' });
      return;
    }
    // Linking a device code adopts that code's punch history onto the employee, so it must be an
    // employee the caller may act on — device.manage held over one branch is not authority over
    // everyone enrolled on the terminal.
    const allowed = await resolveScopedEmployeeIds(req.auth, ['device.manage'], [employeeId]);
    if (allowed !== null && !allowed.length) {
      res.status(403).json({ error: 'forbidden', message: 'That employee is outside your scope.' });
      return;
    }
  }

  await prisma.biotimeEmployee.update({
    where: { empCode },
    data: {
      employeeId: ignore ? null : employeeId,
      // 'manual' and 'ignored' are human decisions; the roster sync will not overwrite either.
      linkStatus: ignore ? 'ignored' : employeeId ? 'manual' : 'unmatched',
      linkedAt: employeeId ? new Date() : null,
      linkedBy: req.auth?.userId ?? null,
      updatedAt: new Date(),
    },
  });

  let adopted = { punchesLinked: 0, firstDate: null as string | null, lastDate: null as string | null };

  if (employeeId && !ignore) {
    adopted = await resolvePunchLinks(empCode);

    if (adopted.punchesLinked > 0 && adopted.firstDate && adopted.lastDate) {
      await enqueueRecompute(employeeId, adopted.firstDate, adopted.lastDate, `code ${empCode} mapped`);
      background('recompute-after-link', () =>
        recompute({ from: adopted.firstDate!, to: adopted.lastDate!, employeeIds: [employeeId] })
      );
    }
  }

  logger.info({ empCode, employeeId, ignore, adopted: adopted.punchesLinked }, 'device code mapping updated');

  res.json({
    ok: true,
    empCode,
    employeeId: ignore ? null : employeeId,
    punchesAdopted: adopted.punchesLinked,
    recomputedFrom: adopted.firstDate,
    recomputedTo: adopted.lastDate,
  });
});

adminRouter.post('/api/mapping/suggest', authenticate, requirePermission('device.manage'), async (_req, res) => {
  const updated = await refreshSuggestions();
  res.json({ ok: true, updated });
});
