// Excel exports: the monthly register and the payroll summary.
//
// Generated server-side rather than in the browser because a 250 x 31 grid with per-cell fills is
// slow and memory-hungry on a phone, and the Capacitor build runs on phones.
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../auth';
import { scopeFor, EXPORT_PERMISSIONS, exportFilename } from '../../exports/generate';
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

// ---------------------------------------------------------------------------
// monthly attendance register
// ---------------------------------------------------------------------------

exportsRouter.get('/api/exports/register', authenticate, requirePermission('report.read', 'attendance.read'), async (req, res) => {
  try {
    const { year, month, branchIds, format } = parsePeriod(req.query);
    const scope = await scopeFor(req.auth, EXPORT_PERMISSIONS.register, branchIds);

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
    const filename = exportFilename('register', year, month);

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
    const scope = await scopeFor(req.auth, EXPORT_PERMISSIONS.payroll, branchIds);
    const columnKeys = columns?.split(',').map((s) => s.trim()).filter(Boolean);

    if (format === 'json') {
      const rows = await buildPayrollRows({ year, month, ...scope, columns: columnKeys });
      res.json({ year, month, rows });
      return;
    }

    const workbook = await buildPayrollWorkbook({ year, month, ...scope, columns: columnKeys });
    const filename = exportFilename('payroll', year, month);

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
