// Excel exports: the monthly register and the payroll summary.
//
// Generated server-side rather than in the browser because a 250 x 31 grid with per-cell fills is
// slow and memory-hungry on a phone, and the Capacitor build runs on phones.
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission, visibleScope } from '../auth';
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
function scopeFor(req: Parameters<typeof visibleScope>[0] extends never ? never : any, requested?: string) {
  const scope = visibleScope(req.auth, 'attendance.read');
  const askedFor = requested?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];

  if (scope.branchIds === null && scope.entityIds === null) {
    // Global grant: honour the filter as given.
    return { branchIds: askedFor.length ? askedFor : null, entityIds: null };
  }

  if (askedFor.length && scope.branchIds) {
    const allowed = new Set(scope.branchIds);
    return { branchIds: askedFor.filter((b) => allowed.has(b)), entityIds: scope.entityIds };
  }

  return scope;
}

// ---------------------------------------------------------------------------
// monthly attendance register
// ---------------------------------------------------------------------------

exportsRouter.get('/api/exports/register', authenticate, requirePermission('report.read', 'attendance.read'), async (req, res) => {
  try {
    const { year, month, branchIds, format } = parsePeriod(req.query);
    const scope = scopeFor(req, branchIds);

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
    const scope = scopeFor(req, branchIds);
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
