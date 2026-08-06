// Building an export, independent of how it was asked for.
//
// There are two ways in now: an HTTP call from a browser on the office LAN, and a queued command
// from a browser anywhere else. They must produce the same file for the same person, so the scope
// resolution and the workbook choice live here rather than once per entry point — the failure mode
// of two copies is that one of them keeps a permission rule the other quietly loses.
import type ExcelJS from 'exceljs';
import { resolveVisibleScope, branchesOfEntities, type AuthContext } from '../api/auth';
import { buildRegisterWorkbook } from './registerReport';
import { buildPayrollWorkbook } from './payrollExport';

export type ExportKind = 'register' | 'payroll';

/** The permissions each sheet admits. Scope is then resolved from these same permissions. */
export const EXPORT_PERMISSIONS: Record<ExportKind, string[]> = {
  register: ['report.read', 'attendance.read'],
  payroll: ['report.read', 'payslip.read'],
};

export interface ExportScope {
  branchIds: string[] | null;
  entityIds: string[] | null;
}

/**
 * Intersect what the caller asked for with what their grants allow.
 *
 * This service reads through a connection that bypasses RLS, so scope has to be applied here
 * explicitly — a branch manager requesting the whole company must get their branch, not the lot.
 */
export async function scopeFor(
  auth: AuthContext | undefined,
  permissions: string[],
  requested?: string
): Promise<ExportScope> {
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

export function exportFilename(kind: ExportKind, year: number, month: number): string {
  const mm = String(month).padStart(2, '0');
  return kind === 'register'
    ? `attendance-register-${year}-${mm}.xlsx`
    : `payroll-attendance-${year}-${mm}.xlsx`;
}

/**
 * Resolve scope and build the workbook.
 *
 * Throws with `status: 403` when the caller's grants confer no export scope — the caller turns that
 * into an HTTP status or a failed command row.
 */
export async function generateExport(opts: {
  kind: ExportKind;
  auth: AuthContext | undefined;
  year: number;
  month: number;
  branchIds?: string;
  columns?: string[];
}): Promise<{ filename: string; workbook: ExcelJS.Workbook }> {
  const { kind, auth, year, month, branchIds, columns } = opts;
  const scope = await scopeFor(auth, EXPORT_PERMISSIONS[kind], branchIds);

  const workbook =
    kind === 'register'
      ? await buildRegisterWorkbook({ year, month, ...scope })
      : await buildPayrollWorkbook({ year, month, ...scope, columns });

  return { filename: exportFilename(kind, year, month), workbook };
}
