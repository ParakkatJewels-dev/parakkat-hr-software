#!/usr/bin/env node
/**
 * Reduce the employee list to the people who actually exist on the Easy Time Pro terminals.
 *
 *   node scripts/keepOnlyDeviceEmployees.js            dry run
 *   node scripts/keepOnlyDeviceEmployees.js --apply
 *   node scripts/keepOnlyDeviceEmployees.js --restore backups/<file>.json --apply
 *
 * WHAT "FROM EASY TIME PRO" MEANS HERE
 * An employee is kept if a biotime_employees row points at them — that is, they are enrolled on a
 * terminal. That is 162 people. It is NOT the same as "the 50 records this tool created": 112 of
 * the kept employees came from the spreadsheet and were matched to a device code during linking.
 * Those 112 are the people whose attendance is currently being collected, and their spreadsheet
 * record carries better entity/branch data than the device has, so replacing them would be a loss.
 *
 * Removing them by "where the record came from" instead of "are they on a device" would delete
 * Basil C Mathew, Anju Balachandran and 110 others who punch in every morning, and cascade their
 * attendance with them. That is the mistake this script exists to avoid.
 *
 * SAFETY
 * Every removed row is written to backups/ as JSON before the delete, and --restore puts them back.
 * The delete cascades to attendance, which for this group is a single placeholder 'Absent' row per
 * person containing no punches — verified before this script was written, and re-verified at run
 * time: anything with a real punch, a login, a payslip or a report is refused.
 */
const path = require('node:path');
const fs = require('node:fs');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const RESTORE = process.argv.includes('--restore')
  ? process.argv[process.argv.indexOf('--restore') + 1]
  : null;
const BACKUP_DIR = path.join(ROOT, 'backups');

function loadEnv() {
  const text = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

// Not on any terminal.
const NOT_ON_DEVICE =
  'not exists (select 1 from public.biotime_employees b where b.employee_id = e.id)';

async function restore(db, file) {
  const rows = JSON.parse(fs.readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file), 'utf8'));
  console.log(`\n  ${rows.length} employees in ${file}`);
  if (!APPLY) { console.log('  Dry run — re-run with --apply to restore them.\n'); return; }

  const cols = Object.keys(rows[0]);
  let n = 0;
  for (const r of rows) {
    const ph = cols.map((_, i) => `$${i + 1}`).join(',');
    await db.query(
      `insert into public.employees (${cols.join(',')}) values (${ph}) on conflict (id) do nothing`,
      cols.map((c) => (r[c] && typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c]))
    );
    n += 1;
  }
  console.log(`  Restored ${n}. Attendance was cascaded away and is not restored — re-run the engine.\n`);
}

async function main() {
  const db = new Client({ connectionString: loadEnv().SUPABASE_DB_URL });
  await db.connect();

  if (RESTORE) { await restore(db, RESTORE); await db.end(); return; }

  const { rows: doomed } = await db.query(
    `select e.* from public.employees e where ${NOT_ON_DEVICE} order by e.employee_code`
  );
  const { rows: kept } = await db.query(
    `select count(*)::int n,
            count(*) filter (where (e.meta->>'source') = 'biotime')::int created_here
       from public.employees e where not (${NOT_ON_DEVICE})`
  );

  // Refuse to delete anyone carrying real work. The earlier check found none; this makes sure that
  // is still true at the moment of deletion rather than trusting a measurement taken minutes ago.
  const { rows: guard } = await db.query(`
    select
      count(*) filter (where exists (select 1 from public.attendance a
                                      where a.employee_id = e.id and a.check_in is not null))::int punched,
      count(*) filter (where e.user_id is not null)::int logins,
      count(*) filter (where exists (select 1 from public.employees m where m.manager_id = e.id))::int managers,
      count(*) filter (where exists (select 1 from public.payslips p where p.employee_id = e.id))::int payslips,
      count(*) filter (where exists (select 1 from public.leaves l where l.employee_id = e.id))::int leaves,
      count(*) filter (where e.salary is not null
                          or e.pan is not null or e.aadhaar is not null or e.bank_account is not null)::int payroll_data
    from public.employees e where ${NOT_ON_DEVICE}
  `);
  const g = guard[0];

  console.log(`\n  KEEP   ${kept[0].n} employees enrolled on a terminal`);
  console.log(`         (${kept[0].n - kept[0].created_here} matched from your spreadsheet, ${kept[0].created_here} created from the device)`);
  console.log(`  REMOVE ${doomed.length} employees with no terminal enrolment\n`);

  const blockers = Object.entries({
    'have real punches': g.punched, 'have a login': g.logins, 'manage someone': g.managers,
    'have payslips': g.payslips, 'have leave records': g.leaves, 'have payroll data': g.payroll_data,
  }).filter(([, v]) => v > 0);

  if (blockers.length) {
    console.log('  REFUSING — some of these carry real data:');
    blockers.forEach(([k, v]) => console.log(`    ${v} ${k}`));
    console.log('\n  Nothing was deleted. Resolve these first.\n');
    await db.end();
    return;
  }
  console.log('  Checked: none of them have punches, logins, payslips, leave, reports or payroll data.');

  const byEntity = {};
  doomed.forEach((d) => { byEntity[d.entity_id] = (byEntity[d.entity_id] || 0) + 1; });
  const ents = Object.fromEntries((await db.query('select id, code from public.entities')).rows.map((e) => [e.id, e.code]));
  console.log('  By company: ' + Object.entries(byEntity).map(([k, v]) => `${ents[k]}=${v}`).join(', '));
  console.log('\n  First 10 of them:');
  doomed.slice(0, 10).forEach((d) => console.log(`    ${String(d.employee_code).padEnd(11)} ${d.full_name}`));
  if (doomed.length > 10) console.log(`    … and ${doomed.length - 10} more`);

  if (!APPLY) {
    console.log('\n  Dry run — nothing deleted. Re-run with --apply.\n');
    await db.end();
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `employees-not-on-device-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(doomed, null, 2));
  console.log(`\n  Backed up ${doomed.length} rows to ${path.relative(ROOT, file)}`);

  const del = await db.query(`delete from public.employees e where ${NOT_ON_DEVICE}`);
  const after = await db.query('select count(*)::int n from public.employees');
  console.log(`  Deleted ${del.rowCount}. ${after.rows[0].n} employees remain — all of them on a terminal.`);
  console.log(`\n  Undo:  node scripts/keepOnlyDeviceEmployees.js --restore ${path.relative(ROOT, file)} --apply\n`);
  await db.end();
}

main().catch((e) => { console.error('\nFailed:', e.message, '\n'); process.exit(1); });
