#!/usr/bin/env node
/**
 * Rebuild the employee list from Easy Time Pro alone.
 *
 *   node scripts/rebuildFromDevice.js              dry run — shows exactly what happens
 *   node scripts/rebuildFromDevice.js --apply
 *   node scripts/rebuildFromDevice.js --restore backups/<file>.json --apply
 *
 * WHAT IT DOES
 *   1. backs up every employee row and their attendance to backups/
 *   2. deletes all employees — attendance cascades, punches are released, links are cleared
 *   3. recreates one employee per terminal enrolment, named and departmented from the device
 *   4. re-links each enrolment, re-adopts its punches, and queues the affected days
 *
 * WHAT IT DOES NOT TOUCH
 *   companies, branches, zones, departments, shifts, roles, holiday calendars, leave types, and
 *   your login. Easy Time Pro has no concept of any of them, so "use only Easy Time Pro data"
 *   cannot mean deleting them — it would leave an app nobody can sign into and no company to file
 *   anyone under. raw_punches is kept too: those ARE Easy Time Pro's data, already downloaded, and
 *   re-fetching 1,800 rows to arrive at identical values would only add risk.
 *
 * THE COST, STATED PLAINLY
 * The device knows a name, a department, a position and sometimes a hire date. It does not know
 * which company or branch anyone belongs to. Today 112 employees carry a company inherited from the
 * spreadsheet; afterwards every company assignment is inferred from the device's department name,
 * which mostly means HO90. Since company scopes who can see whom, a branch manager's view narrows
 * accordingly. That is the trade being made, not a side effect.
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
const HOME_ENTITY = 'HO90';

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

/** Only two device department names name a company unambiguously. */
function entityFor(dept) {
  const d = String(dept || '').toUpperCase();
  if (d.includes('PP IMITATION')) return 'PPL';
  if (d.includes('PEARL')) return 'PKT';
  return HOME_ENTITY;
}

/** "KASINATH A" -> "Kasinath A". Tokens of one or two letters are initials and stay upper case. */
function tidyName(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ').split(' ')
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

const realOrNull = (v) => {
  const s = String(v || '').trim();
  return !s || s === 'Department' || s === 'Position' ? null : s;
};

async function restore(db, file) {
  const dump = JSON.parse(fs.readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file), 'utf8'));
  console.log(`\n  backup taken ${dump.takenAt}`);
  console.log(`  ${dump.employees.length} employees, ${dump.attendance.length} attendance rows`);
  if (!APPLY) { console.log('  Dry run — re-run with --apply to restore.\n'); return; }

  await db.query('begin');
  try {
    await db.query('delete from public.employees');
    for (const table of ['employees', 'attendance']) {
      const rows = dump[table];
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      for (const r of rows) {
        await db.query(
          `insert into public.${table} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})
           on conflict do nothing`,
          cols.map((cn) => (r[cn] && typeof r[cn] === 'object' ? JSON.stringify(r[cn]) : r[cn]))
        );
      }
      console.log(`  restored ${rows.length} ${table}`);
    }
    // Put the enrolment links back exactly as they were.
    for (const [empCode, employeeId] of Object.entries(dump.links ?? {})) {
      await db.query(
        `update public.biotime_employees set employee_id = $1, link_status = 'manual' where emp_code = $2`,
        [employeeId, empCode]
      );
      await db.query(
        'update public.raw_punches set employee_id = $1 where emp_code = $2 and employee_id is null',
        [employeeId, empCode]
      );
    }
    await db.query('commit');
    console.log('  done\n');
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}

async function main() {
  const db = new Client({ connectionString: loadEnv().SUPABASE_DB_URL });
  await db.connect();

  if (RESTORE) { await restore(db, RESTORE); await db.end(); return; }

  const { rows: entities } = await db.query('select id, code from public.entities');
  const entityId = Object.fromEntries(entities.map((e) => [e.code, e.id]));
  if (!entityId[HOME_ENTITY]) throw new Error(`entity ${HOME_ENTITY} not found — nothing to file people under`);

  // --- refuse to run if it would destroy something Easy Time Pro cannot replace ---------------
  const guard = await db.query(`
    select
      (select count(*) from public.employees where user_id is not null)::int logins,
      (select count(*) from public.payslips)::int payslips,
      (select count(*) from public.leaves)::int leaves,
      (select count(*) from public.documents)::int documents,
      (select count(*) from public.salary_structures)::int salaries,
      (select count(*) from public.employees where salary is not null)::int salaried,
      (select count(*) from public.employees
        where pan is not null or aadhaar is not null or bank_account is not null)::int statutory
  `);
  const g = guard.rows[0];
  const blockers = Object.entries(g).filter(([, v]) => v > 0);
  if (blockers.length) {
    console.log('\n  REFUSING — employees carry data the device cannot recreate:');
    blockers.forEach(([k, v]) => console.log(`    ${v} ${k}`));
    console.log('\n  Nothing was changed. Export or migrate these first.\n');
    await db.end();
    return;
  }

  const { rows: enrolments } = await db.query(`
    select b.emp_code, b.full_name, b.department_name, b.position_name, b.hire_date, b.is_active,
           (select count(*)::int from public.raw_punches p where p.emp_code = b.emp_code) as punches
      from public.biotime_employees b
     order by b.emp_code
  `);

  const plan = [];
  const skipped = [];
  for (const e of enrolments) {
    // BioTime stores its admin logins with the role as the name; those are not people.
    if (realOrNull(e.full_name)
        && e.full_name.trim().toUpperCase() === String(e.position_name || '').trim().toUpperCase()) {
      skipped.push({ ...e, why: 'device admin account, not a person' });
      continue;
    }
    if (!realOrNull(e.full_name)) { skipped.push({ ...e, why: 'no name on the enrolment' }); continue; }

    const dept = realOrNull(e.department_name);
    const ent = entityFor(dept);
    plan.push({
      ...e,
      entity: ent,
      entity_id: entityId[ent],
      department: dept,
      position: realOrNull(e.position_name),
      name: tidyName(e.full_name),
      code: `${ent}-D${e.emp_code}`,
    });
  }

  const before = await db.query(`
    select (select count(*) from public.employees)::int employees,
           (select count(*) from public.attendance)::int attendance,
           (select count(*) from public.raw_punches)::int punches,
           (select count(*) from public.employees where branch_id is not null)::int with_branch
  `);
  const bf = before.rows[0];

  console.log(`\n  NOW:   ${bf.employees} employees, ${bf.attendance} attendance rows, ${bf.punches} punches`);
  console.log(`  AFTER: ${plan.length} employees rebuilt from ${enrolments.length} terminal enrolments\n`);

  const byEntity = {};
  plan.forEach((p) => { byEntity[p.entity] = (byEntity[p.entity] || 0) + 1; });
  const nowByEntity = await db.query(
    `select en.code, count(*)::int n from public.employees e join public.entities en on en.id = e.entity_id group by 1 order by 2 desc`
  );
  console.log('  COMPANY ASSIGNMENT CHANGES — the real cost of this:');
  console.log(`    now:   ${nowByEntity.rows.map((r) => `${r.code}=${r.n}`).join(', ')}`);
  console.log(`    after: ${Object.entries(byEntity).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`    (the device does not record a company; ${bf.with_branch} branch assignments are also lost)\n`);

  if (skipped.length) {
    console.log('  NOT CREATED:');
    skipped.forEach((s) => console.log(`    ${String(s.emp_code).padEnd(6)} ${s.full_name} — ${s.why}`));
    console.log('');
  }

  console.log('  KEPT UNTOUCHED: companies, branches, zones, departments, shifts, roles,');
  console.log('  holiday calendars, leave types, your login, and all 1,851 punches.\n');

  console.log('  A sample of what gets created:');
  plan.filter((p) => p.punches > 0).slice(0, 8).forEach((p) =>
    console.log(`    ${p.code.padEnd(12)} ${p.name.slice(0, 22).padEnd(24)} ${String(p.department || '—').slice(0, 20).padEnd(22)} ${p.punches}p`));

  if (!APPLY) {
    console.log('\n  Dry run — nothing changed. Re-run with --apply.\n');
    await db.end();
    return;
  }

  // --- back up before touching anything ------------------------------------------------------
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const employees = (await db.query('select * from public.employees')).rows;
  const attendance = (await db.query('select * from public.attendance')).rows;
  const links = Object.fromEntries(
    (await db.query('select emp_code, employee_id from public.biotime_employees where employee_id is not null')).rows
      .map((r) => [r.emp_code, r.employee_id])
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `before-device-rebuild-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), employees, attendance, links }, null, 2));
  console.log(`\n  Backed up ${employees.length} employees and ${attendance.length} attendance rows`);
  console.log(`  -> ${path.relative(ROOT, file)}`);

  // --- rebuild, all or nothing ---------------------------------------------------------------
  await db.query('begin');
  try {
    // Cascades attendance; raw_punches.employee_id and biotime_employees.employee_id are SET NULL.
    const del = await db.query('delete from public.employees');
    console.log(`  Deleted ${del.rowCount} employees (attendance cascaded, punches released)`);

    const deptCache = new Map();
    let created = 0, adopted = 0, queued = 0;

    for (const p of plan) {
      let deptId = null;
      if (p.department) {
        const key = `${p.entity}:${p.department}`;
        if (deptCache.has(key)) deptId = deptCache.get(key);
        else {
          const found = await db.query(
            'select id from public.departments where entity_id = $1 and lower(name) = lower($2) limit 1',
            [p.entity_id, p.department]
          );
          deptId = found.rows[0]?.id
            ?? (await db.query(
              'insert into public.departments (entity_id, name, is_active) values ($1, $2, true) returning id',
              [p.entity_id, p.department]
            )).rows[0].id;
          deptCache.set(key, deptId);
        }
      }

      const ins = await db.query(
        `insert into public.employees
           (entity_id, department_id, employee_code, full_name, join_date, status, meta)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [
          p.entity_id, deptId, p.code, p.name, p.hire_date || null,
          p.is_active === false ? 'Inactive' : 'Active',
          JSON.stringify({
            source: 'biotime',
            device_emp_code: p.emp_code,
            device_name: p.full_name,
            device_department: p.department,
            device_position: p.position,
            needs_hr_review: true,
          }),
        ]
      );
      const employeeId = ins.rows[0].id;
      created += 1;

      await db.query(
        `update public.biotime_employees
            set employee_id = $1, link_status = 'manual', linked_at = now(), updated_at = now()
          where emp_code = $2`,
        [employeeId, p.emp_code]
      );

      const punches = await db.query(
        `update public.raw_punches set employee_id = $1
          where emp_code = $2 and employee_id is null returning punch_time`,
        [employeeId, p.emp_code]
      );
      adopted += punches.rowCount;

      if (punches.rowCount) {
        // IST calendar day — work_date is a local date, not a UTC one.
        const days = [...new Set(punches.rows.map((r) =>
          new Date(new Date(r.punch_time).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)))];
        for (const d of days) {
          await db.query(
            'insert into public.attendance_recompute_queue (employee_id, work_date, reason) values ($1, $2, $3)',
            [employeeId, d, 'rebuilt from Easy Time Pro enrolment']
          );
          queued += 1;
        }
      }
    }

    await db.query('commit');
    console.log(`\n  Created ${created} employees from the terminal roster.`);
    console.log(`  Adopted ${adopted} punches, queued ${queued} day-recomputes.`);
  } catch (err) {
    await db.query('rollback');
    console.error(`\n  Rebuild failed and was rolled back: ${err.message}`);
    console.error('  Nothing changed. The backup is still on disk.\n');
    await db.end();
    process.exit(1);
  }

  const orphans = await db.query('select count(*)::int n from public.raw_punches where employee_id is null');
  console.log(`  Punches with no owner: ${orphans.rows[0].n}`);
  console.log('\n  Next:  cd ../../services/attendance && npm run recompute -- --from 2026-07-21 --to 2026-07-28');
  console.log(`  Undo:  node scripts/rebuildFromDevice.js --restore ${path.relative(ROOT, file)} --apply\n`);
  await db.end();
}

main().catch((e) => { console.error('\nFailed:', e.message, '\n'); process.exit(1); });
