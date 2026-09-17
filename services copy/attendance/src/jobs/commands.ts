// Work requested from the browser, collected by polling instead of by being called.
//
// The service can always reach Supabase; the browser can always reach Supabase; the browser
// frequently cannot reach the service — it is on a LAN behind a firewall, and an HTTPS page is not
// permitted to call a plain-HTTP address at all. So the admin screen writes a row to
// service_commands and this drains it. No inbound connection to the HR laptop is required for
// anything, which is what makes the office network irrelevant to whether the buttons work.
//
// The scheduler runs one command at a time in this worker. The atomic claim (`for update skip
// locked`) prevents two consumers claiming the same row; it does not serialize different commands
// across processes. Deploy exactly one worker for the shared BioTime integration.
import { prisma } from '../lib/db';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { syncTransactions, runTransactionSync } from '../sync/syncTransactions';
import { syncEmployees, refreshSuggestions } from '../sync/syncEmployees';
import { recompute } from '../engine/recompute';
import { contextForUserId, resolveVisibleScope } from '../api/auth';
import { branchFilter, dateString } from '../api/validation';
import { workDateStart, workDateEnd, todayWorkDate, DateTime, APP_TZ } from '../lib/time';
import { generateExport, type ExportKind } from '../exports/generate';

interface CommandRow {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  requested_by: string | null;
}

/** Take the oldest pending command, if there is one, and mark it running in the same statement. */
async function claimNext(): Promise<CommandRow | null> {
  const rows = await prisma.$queryRaw<CommandRow[]>`
    update public.service_commands
       set status = 'running', claimed_at = now()
     where id = (
       select id from public.service_commands
        where status = 'pending'
        order by requested_at
        limit 1
        for update skip locked
     )
    returning id, kind, params, requested_by::text as requested_by
  `;
  return rows[0] ?? null;
}

/** An export's file, handed back on the row the browser is already watching. */
interface ExportResult {
  filename: string;
  base64: string;
}

const isExportResult = (v: unknown): v is ExportResult =>
  typeof v === 'object' && v !== null && 'base64' in v && 'filename' in v;

const exportParams = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  branchIds: z.union([branchFilter, z.array(z.string().uuid())]).optional(),
  columns: z.array(z.string().min(1)).optional(),
});
const recomputeParams = z.object({
  from: dateString,
  to: dateString.optional(),
  employeeIds: z.array(z.string().uuid()).min(1, 'Choose at least one employee or omit the filter.').optional(),
});
const backfillParams = z.object({
  from: dateString,
  to: dateString.optional(),
  recompute: z.boolean().optional(),
}).refine(p => !p.to || p.from <= p.to, 'Backfill end date must not precede its start date.');

/**
 * Build an export for whoever asked for it.
 *
 * The scope comes from `requested_by`, resolved the same way the HTTP route resolves it from a
 * bearer token. Refusing outright when that lookup comes back empty is deliberate: this service
 * bypasses RLS, so "no context" must mean no rows, never all of them — and a command whose
 * requester has since been deleted has nobody's authority behind it.
 */
async function runExport(kind: ExportKind, cmd: CommandRow, signal?: AbortSignal): Promise<ExportResult> {
  const auth = await contextForUserId(cmd.requested_by);
  signal?.throwIfAborted();
  if (!auth) {
    throw new Error('Cannot identify who requested this export, so its scope cannot be established.');
  }

  const p = exportParams.parse(cmd.params ?? {});
  const { year, month } = p;

  // scopeFor takes the comma-joined form the query string used, but the screens hand this over as
  // JSON and one of them sends an array. Dropping an unrecognised shape here would not error — it
  // would widen the export from the branch that was chosen to every branch the caller can see,
  // which is the kind of wrong that looks like a successful download.
  const branchIds = Array.isArray(p.branchIds) ? p.branchIds.join(',') : p.branchIds;

  const { filename, workbook } = await generateExport({
    kind,
    auth,
    year,
    month,
    branchIds: branchIds || undefined,
    columns: p.columns,
  });
  signal?.throwIfAborted();

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { filename, base64: buffer.toString('base64') };
}

async function execute(cmd: CommandRow, signal?: AbortSignal): Promise<unknown> {
  const p = cmd.params ?? {};
  signal?.throwIfAborted();

  // A command may have waited since the original RPC permission check. Re-resolve current
  // authority before privileged work; a revoked/deleted requester cannot retain queue privileges.
  // Operational commands act across the service, so an entity/branch grant is insufficient.
  if (cmd.kind !== 'export_register' && cmd.kind !== 'export_payroll') {
    const auth = await contextForUserId(cmd.requested_by);
    if (!auth) throw new Error('The requester no longer has authority to run this command.');
    const permission = cmd.kind === 'recompute' ? 'attendance.manage' : 'device.manage';
    const scope = await resolveVisibleScope(auth, [permission]);
    if (!scope.all) throw new Error(`This operation requires global ${permission} access.`);
    signal?.throwIfAborted();
  }

  switch (cmd.kind) {
    case 'sync_transactions':
      return syncTransactions(signal);

    case 'sync_employees':
      return syncEmployees(signal);

    case 'refresh_suggestions':
      return { updated: await refreshSuggestions() };

    case 'recompute': {
      const { from, to = from, employeeIds } = recomputeParams.parse(p);
      return recompute({ from, to, employeeIds }, { signal });
    }

    case 'backfill': {
      const { from, to = todayWorkDate(), recompute: rebuild } = backfillParams.parse(p);
      if (from > to) throw new Error('Backfill end date must not precede its start date.');
      // Chunked the same way the CLI does it: asking BioTime for months in one query is what
      // produces a timeout, or a terminal server on its knees during business hours.
      const result: { inserted: number; fetched: number; skipped: number; chunks: number; rowsWritten?: number } = {
        inserted: 0, fetched: 0, skipped: 0, chunks: 0,
      };
      for (let start = from; start <= to;) {
        signal?.throwIfAborted();
        const weekEnd = DateTime.fromISO(start, { zone: APP_TZ }).plus({ days: 6 }).toISODate()!;
        const end = weekEnd < to ? weekEnd : to;
        const chunk = await runTransactionSync({
          kind: 'backfill', source: 'backfill', startTime: workDateStart(start), endTime: workDateEnd(end),
          advanceCursorAfter: false, maxPages: 10_000, signal,
        });
        signal?.throwIfAborted();
        result.inserted += chunk.inserted;
        result.fetched += chunk.fetched;
        result.skipped += chunk.skipped;
        result.chunks += 1;
        start = DateTime.fromISO(end, { zone: APP_TZ }).plus({ days: 1 }).toISODate()!;
      }
      if (rebuild) result.rowsWritten = (await recompute({ from, to }, { signal })).rowsWritten;
      return result;
    }

    case 'export_register':
      return runExport('register', cmd, signal);

    case 'export_payroll':
      return runExport('payroll', cmd, signal);

    default:
      throw new Error(`unknown command kind "${cmd.kind}"`);
  }
}

/** Run at most one queued command. Returns true if it did something. */
export async function drainServiceCommands(signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const cmd = await claimNext();
  if (!cmd) return false;

  logger.info({ id: cmd.id, kind: cmd.kind, params: cmd.params }, 'running requested command');
  const started = Date.now();

  try {
    const result = await execute(cmd, signal);
    signal?.throwIfAborted();

    // An export's file goes in its own column, never into `result`. The admin screen lists recent
    // commands and selects `result` for every one of them; a few hundred kilobytes of base64 in
    // that jsonb would be re-downloaded on every poll of a list nobody asked to include a file in.
    if (isExportResult(result)) {
      await prisma.$executeRaw`
        update public.service_commands
           set status = 'done',
               finished_at = now(),
               result = ${JSON.stringify({ filename: result.filename, bytes: Buffer.byteLength(result.base64, 'base64') })}::jsonb,
               result_file = ${result.base64},
               result_filename = ${result.filename}
         where id = ${cmd.id}::uuid
           and status = 'running'
      `;
    } else {
      await prisma.$executeRaw`
        update public.service_commands
           set status = 'done', finished_at = now(), result = ${JSON.stringify(result ?? {})}::jsonb
         where id = ${cmd.id}::uuid
           and status = 'running'
      `;
    }
    logger.info({ id: cmd.id, kind: cmd.kind, ms: Date.now() - started }, 'command finished');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The failure belongs on the row, not only in a log file on a laptop nobody is looking at.
    await prisma.$executeRaw`
      update public.service_commands
         set status = 'failed', finished_at = now(), error_message = ${message}
       where id = ${cmd.id}::uuid
         and status = 'running'
    `;
    logger.error({ id: cmd.id, kind: cmd.kind, err: message }, 'command failed');
  }

  return true;
}

/**
 * Settle commands left mid-flight by a process that stopped.
 *
 * Same reasoning as reconcileStaleRuns: a row that says 'running' forever is worse than one that
 * says it failed, because the duplicate-work guard in request_service_command() treats 'running'
 * as in-flight and would refuse every future request of that kind.
 */
export async function reconcileStaleCommands(): Promise<number> {
  const n = await prisma.$executeRaw`
    update public.service_commands
       set status = 'failed', finished_at = now(),
           error_message = 'interrupted — the service stopped before this finished'
     where status = 'running'
  `;
  if (n > 0) logger.warn({ count: n }, 'marked interrupted commands as failed');
  return n;
}

/**
 * Settle abandoned commands on a timer, rather than only when somebody presses a button.
 *
 * expire_stale_service_commands() already exists in the database and request_service_command()
 * calls it before deciding whether a request is a duplicate — which self-heals the button, but only
 * at the moment it is next pressed. Until then the admin screen lists a command as pending or
 * running that nothing is going to collect. Calling the same function on a schedule means the list
 * tells the truth without anyone having to poke it.
 *
 * Deliberately the database's function and not a second copy of the rule here: two expiry policies
 * that disagree about what counts as abandoned would be worse than none.
 */
export async function expireStaleCommands(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    select public.expire_stale_service_commands() as n
  `;
  const n = Number(rows[0]?.n ?? 0);
  if (n > 0) logger.warn({ count: n }, 'settled abandoned service commands');
  return n;
}
