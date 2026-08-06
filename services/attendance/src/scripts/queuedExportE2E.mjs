// End-to-end proof of the queued export, against the real database.
//
//   npx tsx src/exports/e2e.mjs
//
// Two halves, because they cannot share a transaction:
//
//   the permission checks run inside a transaction that is ROLLED BACK, since they only need the
//   RPC and impersonated users;
//
//   the export itself is COMMITTED, because drainServiceCommands runs on the service's own Prisma
//   connection and cannot see rows another connection has not committed. Its footprint is one
//   service_commands row, requested by the real super admin, deleted in the finally block. No user
//   accounts are created and nothing but that row is written — the export itself only reads.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const BACKEND = '/Users/sushil/Documents/PARAKKAT SOFTWARES/HR_Software/parakkat-hr-software/web/backend';
const require = createRequire(`${BACKEND}/package.json`);
const pg = require('pg');

const env = {};
for (const line of readFileSync(`${BACKEND}/.env.local`, 'utf8').split('\n')) {
  const m = line.trim().match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL = env.SUPABASE_DB_URL;
process.env.ENABLE_WORKERS = 'false';
process.env.LOG_LEVEL = 'error';

const { drainServiceCommands } = await import('../jobs/commands.ts');
const { prisma } = await import('../lib/db.ts');

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = (sql, params) => client.query(sql, params);

const fails = [];
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} — ${msg}`); if (!ok) fails.push(msg); };

let commandId = null;
try {
  const { rows: [period] } = await q(
    `select extract(year from max(work_date))::int y, extract(month from max(work_date))::int m
       from public.attendance`);
  const { rows: [admin] } = await q(`select user_id from public.profiles where is_super_admin limit 1`);
  console.log(`\nExporting ${period.y}-${String(period.m).padStart(2, '0')}\n`);

  // ---------------------------------------------------------------------------
  // Part 1 — who may ask. Rolled back.
  // ---------------------------------------------------------------------------
  console.log('permission checks (rolled back):');
  await q('begin');
  const EMP = '00000000-0000-0000-0000-00000000d002';
  await q(`insert into auth.users (id) values ($1)`, [EMP]);
  await q(`insert into public.profiles (user_id) values ($1) on conflict (user_id) do nothing`, [EMP]);
  await q(`insert into public.role_assignments (user_id, role_id, scope_type, scope_id)
           select $1, id, 'self', null from public.roles where key='employee'`, [EMP]);

  const askAs = async (uid, kind) => {
    await q('savepoint s');
    try {
      await q(`set local role authenticated`);
      await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid })]);
      await q(`select public.request_service_command($1, $2::jsonb)`,
        [kind, JSON.stringify({ year: period.y, month: period.m })]);
      await q(`reset role`);
      await q('rollback to savepoint s');
      return null;
    } catch (e) {
      await q('rollback to savepoint s');
      return String(e.message);
    }
  };

  const empRegister = await askAs(EMP, 'export_register');
  check(Boolean(empRegister), 'a self-scoped employee cannot queue a register export');
  console.log(`         → ${empRegister?.slice(0, 95)}`);
  const empPayroll = await askAs(EMP, 'export_payroll');
  check(Boolean(empPayroll), 'a self-scoped employee cannot queue a payroll export');
  check((await askAs(admin.user_id, 'export_register')) === null, 'a super admin can');
  await q('rollback');

  // ---------------------------------------------------------------------------
  // Part 2 — does it actually produce a workbook. Committed, then cleaned up.
  // ---------------------------------------------------------------------------
  console.log('\nthe export itself (one committed row, deleted at the end):');
  const { rows: [cmd] } = await q(
    `insert into public.service_commands (kind, params, requested_by)
     values ('export_register', $1::jsonb, $2) returning id`,
    [JSON.stringify({ year: period.y, month: period.m }), admin.user_id]);
  commandId = cmd.id;

  const t0 = Date.now();
  const did = await drainServiceCommands();
  check(did === true, 'the service claimed and ran it');

  const { rows: [row] } = await q(
    `select status, error_message, result::text result, result_filename, length(result_file) b64_len,
            encode(decode(substring(result_file from 1 for 8), 'base64'), 'hex') head
       from public.service_commands where id = $1`, [commandId]);

  check(row.status === 'done', `it finished (${row.status}) ${row.error_message ?? ''}`);
  check((row.b64_len ?? 0) > 5_000, `a real workbook came back — ${row.b64_len} base64 chars, ${Date.now() - t0}ms`);
  check(/^attendance-register-\d{4}-\d{2}\.xlsx$/.test(row.result_filename ?? ''),
    `named correctly (${row.result_filename})`);
  // .xlsx is a zip: PK\x03\x04. Proves the base64 column round-trips real bytes, not mangled text.
  check(row.head?.startsWith('504b0304'), `it is a genuine .xlsx zip (starts ${row.head?.slice(0, 8)})`);
  // The admin screen lists `result` for every recent command; the file must not ride along.
  check((row.result?.length ?? 0) < 300, `the file did not leak into result (${row.result?.length} chars)`);
  console.log(`         result = ${row.result}`);
} catch (e) {
  console.log('ERROR', e.message);
  fails.push(e.message);
} finally {
  if (commandId) {
    await q(`delete from public.service_commands where id = $1`, [commandId]);
    console.log(`\n(cleaned up command ${commandId})`);
  }
  console.log(fails.length ? `\nFAIL (${fails.length})` : '\nPASS — end to end');
  await client.end();
  await prisma.$disconnect();
  process.exit(fails.length ? 1 : 0);
}
