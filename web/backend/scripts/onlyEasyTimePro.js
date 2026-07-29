#!/usr/bin/env node
/**
 * Make the org structure exactly what Easy Time Pro knows, and nothing else.
 *
 *   node scripts/onlyEasyTimePro.js              dry run
 *   node scripts/onlyEasyTimePro.js --apply
 *   node scripts/onlyEasyTimePro.js --restore backups/<file>.json --apply
 *
 * WHAT EASY TIME PRO ACTUALLY HAS
 *   people        163 enrolments
 *   area          one, "parakkat"
 *   departments   18
 *   positions     17
 *   companies     none — there is no such field on an enrolment
 *   branches      none — likewise
 *
 * So "only what comes from Easy Time Pro" means one company, no branches, no zones. It cannot mean
 * zero companies: employees.entity_id is NOT NULL, so every person must belong to one. The single
 * company is therefore named after the only thing the device does record — its area.
 *
 * WHAT THIS DELETES
 *   the four companies added by hand, and everything that hangs off them: 48 branches, 1 zone,
 *   54 designations, and their holiday calendars.
 *
 * WHAT IT MOVES RATHER THAN DELETES
 *   employees, departments the device also knows, and — importantly — the payroll rows. There is a
 *   PUBLISHED payroll run against HO90 with a payslip of 50,000 for Kasinath A. Deleting that
 *   company would cascade the run away and take a published payslip with it. Whether that is test
 *   data or not is not this script's judgement to make, so it is re-pointed at the new company and
 *   survives intact.
 *
 * WHAT IS LOST, STATED PLAINLY
 *   PPL, PKT, HO90 and PJT are four separately registered companies. Collapsing them into one is a
 *   business decision with tax consequences, and it cannot be undone from Easy Time Pro, which has
 *   never heard of them. The backup written before any change is the only way back.
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

const TABLES = ['entities', 'zones', 'branches', 'departments', 'designations', 'holiday_calendars'];

async function restore(db, file) {
  const dump = JSON.parse(fs.readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file), 'utf8'));
  console.log(`\n  backup from ${dump.takenAt}`);
  for (const t of TABLES) console.log(`    ${t}: ${dump[t]?.length ?? 0} rows`);
  if (!APPLY) { console.log('\n  Dry run — re-run with --apply.\n'); return; }

  await db.query('begin');
  try {
    // Put the structure back, then re-point everything that was moved.
    for (const t of TABLES) {
      for (const r of dump[t] ?? []) {
        const cols = Object.keys(r);
        await db.query(
          `insert into public.${t} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})
           on conflict (id) do nothing`,
          cols.map((cn) => (r[cn] && typeof r[cn] === 'object' ? JSON.stringify(r[cn]) : r[cn]))
        );
      }
    }
    for (const [table, rows] of Object.entries(dump.placements ?? {})) {
      for (const r of rows) {
        await db.query(
          `update public.${table} set entity_id=$2, zone_id=$3, branch_id=$4, department_id=$5 where id=$1`,
          [r.id, r.entity_id, r.zone_id ?? null, r.branch_id ?? null, r.department_id ?? null]
        );
      }
    }
    await db.query(`delete from public.entities where code = ${"'PARAKKAT'"} and not exists
      (select 1 from public.employees e where e.entity_id = entities.id)`);
    await db.query('commit');
    console.log('  restored\n');
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}

async function main() {
  const db = new Client({ connectionString: loadEnv().SUPABASE_DB_URL });
  await db.connect();

  if (RESTORE) { await restore(db, RESTORE); await db.end(); return; }

  // --- what the device knows ------------------------------------------------------------------
  const { rows: areas } = await db.query(
    `select area_name, count(*)::int n from public.biotime_employees
      where area_name is not null group by 1 order by 2 desc`
  );
  if (areas.length !== 1) {
    console.log(`\n  Easy Time Pro reports ${areas.length} areas: ${areas.map((a) => a.area_name).join(', ')}`);
    console.log('  This script assumes exactly one. With more, each area should become its own company');
    console.log('  and that mapping needs deciding rather than guessing.\n');
    await db.end();
    return;
  }
  const area = areas[0].area_name;
  const newCode = area.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'PARAKKAT';
  const newName = area.trim().replace(/\b\w/g, (m) => m.toUpperCase());

  const { rows: deviceDepts } = await db.query(
    `select distinct department_name as name from public.biotime_employees
      where department_name is not null and department_name <> 'Department' order by 1`
  );

  const before = await db.query(`
    select (select count(*) from public.entities)::int entities,
           (select count(*) from public.branches)::int branches,
           (select count(*) from public.zones)::int zones,
           (select count(*) from public.departments)::int departments,
           (select count(*) from public.designations)::int designations,
           (select count(*) from public.employees)::int employees,
           (select count(*) from public.payroll_runs)::int payroll_runs,
           (select count(*) from public.payslips)::int payslips,
           (select count(*) from public.salary_structures)::int salary_structures
  `);
  const b = before.rows[0];

  console.log(`\n  Easy Time Pro reports one area: "${area}" (${areas[0].n} enrolments)`);
  console.log(`  It becomes the single company:  ${newCode} — ${newName}\n`);

  console.log(`  ${''.padEnd(18)} ${'now'.padStart(6)}   ${'after'.padStart(6)}`);
  console.log('  ' + '-'.repeat(36));
  const plan = [
    ['companies', b.entities, 1],
    ['branches', b.branches, 0],
    ['zones', b.zones, 0],
    ['departments', b.departments, deviceDepts.length],
    ['designations', b.designations, 0],
    ['employees', b.employees, b.employees],
  ];
  plan.forEach(([k, n, a]) => console.log(`  ${k.padEnd(18)} ${String(n).padStart(6)} → ${String(a).padStart(6)}`));

  console.log('\n  MOVED, NOT DELETED:');
  console.log(`    ${b.employees} employees        -> ${newCode}, branch and zone cleared`);
  console.log(`    ${b.payroll_runs} payroll runs      -> ${newCode}  (one is PUBLISHED)`);
  console.log(`    ${b.payslips} payslip           -> ${newCode}`);
  console.log(`    ${b.salary_structures} salary structure  -> ${newCode}`);
  console.log(`    departments the device also knows keep their employees attached`);

  console.log('\n  DELETED — nothing in Easy Time Pro corresponds to these:');
  const gone = await db.query(`select code, name from public.entities order by code`);
  console.log(`    companies:    ${gone.rows.map((r) => r.code).join(', ')}`);
  console.log(`    branches:     all ${b.branches}, including ALP, ALU, BLR, KNR, KTM, PKD, TCR`);
  console.log(`    zones:        ${b.zones}`);
  console.log(`    designations: ${b.designations}`);

  console.log('\n  THE PART THAT CANNOT BE UNDONE FROM THE DEVICE:');
  console.log('    PPL, PKT, HO90 and PJT are four separately registered companies. Easy Time Pro');
  console.log('    has never heard of them, so nothing can rebuild that split. The backup written');
  console.log('    below is the only way back.');

  if (!APPLY) {
    console.log('\n  Dry run — nothing changed. Re-run with --apply.\n');
    await db.end();
    return;
  }

  // --- back up everything this touches --------------------------------------------------------
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dump = { takenAt: new Date().toISOString() };
  for (const t of TABLES) dump[t] = (await db.query(`select * from public.${t}`)).rows;
  dump.placements = {};
  for (const t of ['employees', 'payroll_runs', 'payslips', 'salary_structures']) {
    const cols = (await db.query(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name=$1
          and column_name in ('id','entity_id','zone_id','branch_id','department_id')`, [t]
    )).rows.map((r) => r.column_name);
    dump.placements[t] = (await db.query(`select ${cols.join(',')} from public.${t}`)).rows;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `org-before-device-only-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(dump, null, 2));
  console.log(`\n  Backed up the whole structure -> ${path.relative(ROOT, file)}`);

  await db.query('begin');
  try {
    const ent = await db.query(
      `insert into public.entities (code, name, is_active) values ($1, $2, true) returning id`,
      [newCode, newName]
    );
    const entityId = ent.rows[0].id;

    // Departments first, so employees can be re-pointed at the new ones in the same pass.
    const deptMap = new Map();
    for (const d of deviceDepts) {
      const r = await db.query(
        `insert into public.departments (entity_id, name, is_active) values ($1, $2, true) returning id`,
        [entityId, d.name]
      );
      deptMap.set(d.name.toUpperCase(), r.rows[0].id);
    }

    // Each employee keeps the department the device says they are in; branch and zone go, because
    // the device has no such concept and a stale value is worse than none.
    const emps = await db.query(`
      select e.id, b.department_name
        from public.employees e
        left join public.biotime_employees b on b.employee_id = e.id
    `);
    for (const e of emps.rows) {
      const key = String(e.department_name ?? '').toUpperCase();
      const deptId = deptMap.get(key) ?? null;
      await db.query(
        // designation goes with branch and zone: the device records a position, but positions were
        // never imported as designations, so every value here came from the spreadsheet. Leaving
        // them set would also block the cascade — employees.designation_id is NO ACTION.
        `update public.employees
            set entity_id = $2, department_id = $3,
                branch_id = null, zone_id = null, designation_id = null, updated_at = now()
          where id = $1`,
        [e.id, entityId, deptId]
      );
    }

    // Payroll runs are unique per (company, period). Once every run shares one company, two runs
    // for the same month collide — here a PKT draft and an HO90 published run, both for 2026-07.
    //
    // An empty draft is scaffolding, not a record: no employees, nothing paid. Those are removed so
    // the real run survives. If two runs that both did something would still collide, stop rather
    // than pick one, because deciding which payroll to discard is not this script's call.
    const emptied = await db.query(
      `delete from public.payroll_runs
        where coalesce(employees, 0) = 0 and coalesce(total_gross, 0) = 0 and status <> 'Published'`
    );
    if (emptied.rowCount) console.log(`  Removed ${emptied.rowCount} empty draft payroll run(s)`);

    const clash = await db.query(
      `select period, count(*)::int n from public.payroll_runs group by period having count(*) > 1`
    );
    if (clash.rows.length) {
      throw new Error(
        `two payroll runs that both hold data cover the same period (${clash.rows.map((r) => r.period).join(', ')}). ` +
        `Merging companies would violate one run per company per period — resolve those first.`
      );
    }

    // Payroll follows its people rather than being cascaded away with the old company.
    for (const t of ['payroll_runs', 'payslips', 'salary_structures']) {
      const cols = (await db.query(
        `select column_name from information_schema.columns
          where table_schema='public' and table_name=$1
            and column_name in ('entity_id','zone_id','branch_id','department_id')`, [t]
      )).rows.map((r) => r.column_name);
      const sets = ['entity_id = $1'];
      for (const c of cols) if (c !== 'entity_id') sets.push(`${c} = null`);
      await db.query(`update public.${t} set ${sets.join(', ')}`, [entityId]);
    }

    // Devices point at a company too.
    await db.query('update public.devices set entity_id = $1, branch_id = null', [entityId]);

    // A calendar for the new company, so holidays have somewhere to live.
    await db.query(
      `insert into public.holiday_calendars (entity_id, code, name, is_default, is_active)
       values ($1, 'GEN', 'Company Holidays', true, true)`,
      [entityId]
    );

    // Now the old structure has nothing pointing at it.
    const del = await db.query('delete from public.entities where id <> $1', [entityId]);
    console.log(`  Deleted ${del.rowCount} companies and everything that hung off them`);

    await db.query('commit');
  } catch (err) {
    await db.query('rollback');
    console.error(`\n  Failed and rolled back — nothing changed: ${err.message}`);
    console.error(`  The backup is still at ${path.relative(ROOT, file)}\n`);
    await db.end();
    process.exit(1);
  }

  const after = await db.query(`
    select (select count(*) from public.entities)::int entities,
           (select count(*) from public.branches)::int branches,
           (select count(*) from public.zones)::int zones,
           (select count(*) from public.departments)::int departments,
           (select count(*) from public.employees)::int employees,
           (select count(*) from public.employees where department_id is not null)::int placed,
           (select count(*) from public.payroll_runs)::int payroll_runs,
           (select count(*) from public.payslips)::int payslips
  `);
  const a = after.rows[0];
  console.log(`\n  ${a.entities} company, ${a.branches} branches, ${a.zones} zones, ${a.departments} departments`);
  console.log(`  ${a.employees} employees (${a.placed} with a department from the device)`);
  console.log(`  ${a.payroll_runs} payroll runs and ${a.payslips} payslips preserved`);
  console.log(`\n  Undo:  node scripts/onlyEasyTimePro.js --restore ${path.relative(ROOT, file)} --apply\n`);
  await db.end();
}

main().catch((e) => { console.error('\nFailed:', e.message, '\n'); process.exit(1); });
