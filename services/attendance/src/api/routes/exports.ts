// Excel exports: the monthly register and the payroll summary.
//
// Generated server-side rather than in the browser because a 250 x 31 grid with per-cell fills is
// slow and memory-hungry on a phone, and the Capacitor build runs on phones.
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission, resolveVisibleScope, branchesOfEntities } from '../auth';
import { buildRegisterWorkbook, buildRegisterRows } from '../../exports/registerReport';
import { buildPayrollWorkbook, buildPayrollRows } from '../../exports/payrollExport';
import { columnCatalog } from '../../exports/columns';
import { logger } from '../../lib/logger';

export const exportsRouter = Router();

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const periodSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  branchIds: z.string().optional(),
  columns: z.string().optional(),
  format: z.enum(['xlsx', 'json']).optional(),
});

function parsePeriod(query: unknown) {
  const parsed = periodSchema.safeParse(query);
  if (!parsed.success) {
    throw Object.assign(new Error('invalid query'), { issues: parsed.error.issues, status: 400 });
  }
  return parsed.data;
}

/**
 * Intersect what the caller asked for with what their grants allow.
 *
 * This service reads through a connection that bypasses RLS, so scope has to be applied here
 * explicitly — a branch manager requesting the whole company must get their branch, not the lot.
 */
async function scopeFor(
  auth: Parameters<typeof resolveVisibleScope>[0],
  permissions: string[],
  requested?: string
): Promise<{ branchIds: string[] | null; entityIds: string[] | null }> {
  // Scope is the union of grants across the SAME permissions the route admits — computing it for
  // a permission the caller might not hold would fail open to "everything".
  const scope = await resolveVisibleScope(auth, permissions);
  const askedFor = requested?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];

  if (scope.all) {
    return { branchIds: askedFor.length ? askedFor : null, entityIds: null };
  }

  // FAIL CLOSED: a caller whose grants resolve to no branch/entity (e.g. an employee's
  // self-scoped payslip.read) has no export scope at all.
  if (!scope.branchIds.length && !scope.entityIds.length) {
    throw Object.assign(
      new Error('Your role has no export scope. Exports need a branch, zone, entity or global grant.'),
      { status: 403 }
    );
  }

  if (askedFor.length) {
    // A requested branch is allowed if granted directly or via one of the caller's entities.
    const allowed = new Set([...scope.branchIds, ...(await branchesOfEntities(scope.entityIds))]);
    const chosen = askedFor.filter((b) => allowed.has(b));
    // FAIL CLOSED: an empty intersection is a refusal, never "all branches".
    if (!chosen.length) {
      throw Object.assign(new Error('The requested branches are outside your visible scope.'), {
        status: 403,
      });
    }
    return { branchIds: chosen, entityIds: null };
  }

  // No filter requested: the whole visible scope. The report SQL ANDs the two arrays, so when
  // both branch and entity grants exist, express their UNION as one branch list.
  if (scope.branchIds.length && scope.entityIds.length) {
    const union = new Set([...scope.branchIds, ...(await branchesOfEntities(scope.entityIds))]);
    return { branchIds: [...union], entityIds: null };
  }
  return {
    branchIds: scope.branchIds.length ? scope.branchIds : null,
    entityIds: scope.entityIds.length ? scope.entityIds : null,
  };
}

// ---------------------------------------------------------------------------
// monthly attendance register
// ---------------------------------------------------------------------------

exportsRouter.get('/api/exports/register', authenticate, requirePermission('report.read', 'attendance.read'), async (req, res) => {
  try {
    const { year, month, branchIds, format } = parsePeriod(req.query);
    const scope = await scopeFor(req.auth, ['report.read', 'attendance.read'], branchIds);

    if (format === 'json') {
      const { rows, dates } = await buildRegisterRows({ year, month, ...scope });
      res.json({
        year,
        month,
        dates,
        rows: rows.map((r) => ({ ...r, days: Object.fromEntries(r.days) })),
      });
      return;
    }

    const workbook = await buildRegisterWorkbook({ year, month, ...scope });
    const filename = `attendance-register-${year}-${String(month).padStart(2, '0')}.xlsx`;

    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    logger.error({ err }, 'register export failed');
    res.status(status).json({
      error: 'export_failed',
      message: err instanceof Error ? err.message : String(err),
      issues: (err as { issues?: unknown }).issues,
    });
  }
});

// ---------------------------------------------------------------------------
// payroll export
// ---------------------------------------------------------------------------

exportsRouter.get('/api/exports/payroll/columns', authenticate, requirePermission('report.read', 'payslip.read'), (_req, res) => {
  res.json({ columns: columnCatalog() });
});

exportsRouter.get('/api/exports/payroll', authenticate, requirePermission('report.read', 'payslip.read'), async (req, res) => {
  try {
    const { year, month, branchIds, columns, format } = parsePeriod(req.query);
    const scope = await scopeFor(req.auth, ['report.read', 'payslip.read'], branchIds);
    const columnKeys = columns?.split(',').map((s) => s.trim()).filter(Boolean);

    if (format === 'json') {
      const rows = await buildPayrollRows({ year, month, ...scope, columns: columnKeys });
      res.json({ year, month, rows });
      return;
    }

    const workbook = await buildPayrollWorkbook({ year, month, ...scope, columns: columnKeys });
    const filename = `payroll-attendance-${year}-${String(month).padStart(2, '0')}.xlsx`;

    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    logger.error({ err }, 'payroll export failed');
    res.status(status).json({
      error: 'export_failed',
      message: err instanceof Error ? err.message : String(err),
      issues: (err as { issues?: unknown }).issues,
    });
  }
});
