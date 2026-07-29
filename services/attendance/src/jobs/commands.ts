// Work requested from the browser, collected by polling instead of by being called.
//
// The service can always reach Supabase; the browser can always reach Supabase; the browser
// frequently cannot reach the service — it is on a LAN behind a firewall, and an HTTPS page is not
// permitted to call a plain-HTTP address at all. So the admin screen writes a row to
// service_commands and this drains it. No inbound connection to the HR laptop is required for
// anything, which is what makes the office network irrelevant to whether the buttons work.
//
// One command runs at a time. These are heavy operations against an on-prem BioTime box, and two
// backfills at once is how you take it down mid-morning. The claim is atomic (`for update skip
// locked`), so a second service instance would simply find nothing to do rather than duplicate.
import { prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { syncTransactions, runTransactionSync } from '../sync/syncTransactions';
import { syncEmployees, refreshSuggestions } from '../sync/syncEmployees';
import { recompute } from '../engine/recompute';

interface CommandRow {
  id: string;
  kind: string;
  params: Record<string, unknown>;
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
    returning id, kind, params
  `;
  return rows[0] ?? null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

async function execute(cmd: CommandRow, signal?: AbortSignal): Promise<unknown> {
  const p = cmd.params ?? {};

  switch (cmd.kind) {
    case 'sync_transactions':
      return syncTransactions(signal);

    case 'sync_employees':
      return syncEmployees(signal);

    case 'refresh_suggestions':
      return { updated: await refreshSuggestions() };

    case 'recompute': {
      const from = str(p.from);
      const to = str(p.to) ?? from;
      if (!from || !to) throw new Error('recompute needs a from and to date');
      const employeeIds = Array.isArray(p.employeeIds) ? (p.employeeIds as string[]) : undefined;
      return recompute({ from, to, employeeIds });
    }

    case 'backfill': {
      const from = str(p.from);
      const to = str(p.to);
      if (!from) throw new Error('backfill needs a from date');
      // Chunked the same way the CLI does it: asking BioTime for months in one query is what
      // produces a timeout, or a terminal server on its knees during business hours.
      const result = await runTransactionSync({
        kind: 'backfill',
        source: 'backfill',
        startTime: new Date(`${from}T00:00:00+05:30`),
        endTime: to ? new Date(`${to}T23:59:59+05:30`) : undefined,
        advanceCursorAfter: false,
        signal,
      });
      if (p.recompute && to) await recompute({ from, to });
      return result;
    }

    default:
      throw new Error(`unknown command kind "${cmd.kind}"`);
  }
}

/** Run at most one queued command. Returns true if it did something. */
export async function drainServiceCommands(signal?: AbortSignal): Promise<boolean> {
  const cmd = await claimNext();
  if (!cmd) return false;

  logger.info({ id: cmd.id, kind: cmd.kind, params: cmd.params }, 'running requested command');
  const started = Date.now();

  try {
    const result = await execute(cmd, signal);
    await prisma.$executeRaw`
      update public.service_commands
         set status = 'done', finished_at = now(), result = ${JSON.stringify(result ?? {})}::jsonb
       where id = ${cmd.id}::uuid
    `;
    logger.info({ id: cmd.id, kind: cmd.kind, ms: Date.now() - started }, 'command finished');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The failure belongs on the row, not only in a log file on a laptop nobody is looking at.
    await prisma.$executeRaw`
      update public.service_commands
         set status = 'failed', finished_at = now(), error_message = ${message}
       where id = ${cmd.id}::uuid
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
