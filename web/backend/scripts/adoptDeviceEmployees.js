#!/usr/bin/env node
/**
 * Turn Easy Time Pro enrolments into employee records.
 *
 *   node scripts/adoptDeviceEmployees.js            dry run — shows exactly what it would create
 *   node scripts/adoptDeviceEmployees.js --apply
 *   node scripts/adoptDeviceEmployees.js --review   just print the look-alike list, create nothing
 *
 * WHY THIS EXISTS
 * The spreadsheet roster and the terminals are two partial views of the same workforce. scripts/
 * linkDeviceCodes.js joined the 94 people who appear in both. What is left is mostly people the
 * spreadsheet never had — new joiners, factory sections, staff hired since the sheet was written.
 * The device knows their name, department, position and hire date, which is enough to open an
 * employee record and start collecting attendance. Payroll fields get filled in later by HR.
 *
 * WHAT IT REFUSES TO DO
 * If an enrolment looks like somebody already on the roster (name similarity >= REVIEW_AT) it is
 * NOT created. Creating "Gibin Cherian" next to the existing "Gibin Cheriyan" would give one person
 * two employee records, two attendance streams and eventually two salaries — a mess that is far
 * harder to unpick later than it is to resolve now with one glance from HR. Those are printed at
 * the end and belong in Time & Attendance -> Setup, where a human confirms or rejects each one.
 *
 * ENTITY ASSIGNMENT is inferred from the device's own department name and stated in the output so
 * it can be corrected. Only two mappings are certain; everything else lands on the entity that owns
 * the site where the terminal physically sits.
 */
const path = require('node:path');
const fs = require('node:fs');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const REVIEW_ONLY = process.argv.includes('--review');

// Above this, an enrolment is treated as a possible duplicate of an existing employee and left for
// a human. linkDeviceCodes.js already auto-linked >= 0.90, so this only catches the middle band.
const REVIEW_AT = 0.78;

// The device site. Anything whose department does not clearly belong elsewhere is created here.
const HOME_ENTITY = 'HO90';

/** Device department name -> entity code. Only the unambiguous ones. */
function entityForDepartment(dept) {
  const d = String(dept || '').toUpperCase();
  if (d.includes('PP IMITATION')) return 'PPL';
  if (d.includes('PEARL')) return 'PKT';
  return HOME_ENTITY;
}

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

/**
 * "KASINATH A" -> "Kasinath A", "latha ms" -> "Latha MS", "DHANOOP K chandran" -> "Dhanoop K Chandran".
 * One- and two-letter tokens stay upper case: in this roster they are always initials, and the
 * existing HR records write them the same way ("Balan.A.N", "Latha.M.S").
 */
function tidyName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

/** BioTime writes "Department"/"Position" as the placeholder for "not set". */
const realOrNull = (v) => {
  const s = String(v || '').trim();
  if (!s || s === 'Department' || s === 'Position') return null;
  return s;
};

async function main() {
  const db = new Client({ connectionString: loadEnv().SUPABASE_DB_URL });
  await db.connect();

  const { rows: entities } = await db.query('select id, code from public.entities');
  const entityId = Object.fromEntries(entities.map((e) => [e.code, e.id]));
  if (!entityId[HOME_ENTITY]) throw new Error(`entity ${HOME_ENTITY} not found`);

  const { rows: enrolments } = await db.query(`
    select b.emp_code, b.full_name, b.department_name, b.position_name, b.hire_date, b.is_active,
           b.match_suggestions->0->>'full_name'        as best_name,
           (b.match_suggestions->0->>'score')::numeric as best_score,
           (select count(*)::int from public.raw_punches p where p.emp_code = b.emp_code) as punches
      from public.biotime_employees b
     where b.link_status = 'unmatched'
     order by punches desc, b.emp_code
  `);

  const create = [];
  const review = [];
  const ignored = [];

  for (const e of enrolments) {
    // A device admin login, not a person: BioTime stores those with the role as the name.
    if (realOrNull(e.full_name) && e.full_name.trim().toUpperCase() === String(e.position_name || '').trim().toUpperCase()) {
      ignored.push({ ...e, why: 'device admin account, not a person' });
      continue;
    }
    if (e.best_score != null && Number(e.best_score) >= REVIEW_AT) {
      review.push(e);
      continue;
    }
    create.push(e);
  }

  const plan = create.map((e) => {
    const dept = realOrNull(e.department_name);
    const ent = entityForDepartment(dept);
    return {
      ...e,
      entity: ent,
      entity_id: entityId[ent],
      department: dept,
      position: realOrNull(e.position_name),
      name: tidyName(e.full_name),
      code: `${ent}-D${e.emp_code}`,
    };
  });

  console.log(`\n  ${enrolments.length} enrolments are still unlinked.`);
  console.log(`  ${plan.length} will become employees`);
  console.log(`  ${review.length} look like someone already on the roster — left for HR`);
  if (ignored.length) console.log(`  ${ignored.length} ignored (${ignored.map((i) => i.full_name).join(', ')})`);

  const byEntity = {};
  plan.forEach((p) => { byEntity[p.entity] = (byEntity[p.entity] || 0) + 1; });
  console.log(`\n  ENTITY (inferred from the device's department name — correct these in the UI if wrong):`);
  Object.entries(byEntity).forEach(([k, v]) => console.log(`    ${k.padEnd(6)} ${v}`));

  console.log(`\n  CREATING — the ${plan.filter((p) => p.punches > 0).length} with punches first:`);
  plan.filter((p) => p.punches > 0).forEach((p) =>
    console.log(`    ${p.code.padEnd(11)} ${p.name.slice(0, 24).padEnd(26)} ${String(p.department || '—').slice(0, 20).padEnd(22)}` +
      `${String(p.position || '—').slice(0, 16).padEnd(18)} ${String(p.punches).padStart(3)}p`));
  const idle = plan.filter((p) => p.punches === 0);
  if (idle.length) {
    console.log(`\n  … plus ${idle.length} enrolled but not yet punching:`);
    console.log('    ' + idle.map((p) => p.name).join(', '));
  }

  console.log(`\n  LEFT FOR HR — each of these may already exist under a different spelling.`);
  console.log(`  Confirm or reject in Time & Attendance -> Setup:\n`);
  console.log(`    ${'device code'.padEnd(12)} ${'device name'.padEnd(24)} ${'possible match on roster'.padEnd(26)} score  punches`);
  review.forEach((r) =>
    console.log(`    ${String(r.emp_code).padEnd(12)} ${String(r.full_name).slice(0, 22).padEnd(24)} ${String(r.best_name).slice(0, 24).padEnd(26)} ` +
      `${Number(r.best_score).toFixed(2)}   ${r.punches}`));

  if (REVIEW_ONLY) { await db.end(); return; }
  if (!APPLY) {
    console.log('\n  Dry run — nothing written. Re-run with --apply.\n');
    await db.end();
    return;
  }

  // Find-or-create the department the device reports, so the org tree reflects the factory as it
  // actually is rather than the nine placeholder rows currently in HR.
  const deptCache = new Map();
  async function departmentId(name, entId, entCode) {
    if (!name) return null;
    const key = `${entCode}:${name}`;
    if (deptCache.has(key)) return deptCache.get(key);
    const found = await db.query(
      'select id from public.departments where entity_id = $1 and lower(name) = lower($2) limit 1',
      [entId, name]
    );
    let id = found.rows[0]?.id;
    if (!id) {
      const ins = await db.query(
        'insert into public.departments (entity_id, name, is_active) values ($1, $2, true) returning id',
        [entId, name]
      );
      id = ins.rows[0].id;
    }
    deptCache.set(key, id);
    return id;
  }

  let created = 0, adopted = 0, queued = 0, failed = 0;
  for (const p of plan) {
    await db.query('begin');
    try {
      const deptId = await departmentId(p.department, p.entity_id, p.entity);

      const ins = await db.query(
        `insert into public.employees
           (entity_id, department_id, employee_code, full_name, join_date, status, meta)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (entity_id, employee_code) do update set full_name = excluded.full_name
         returning id`,
        [
          p.entity_id, deptId, p.code, p.name,
          p.hire_date || null,
          p.is_active === false ? 'Inactive' : 'Active',
          JSON.stringify({
            source: 'biotime',
            device_emp_code: p.emp_code,
            device_name: p.full_name,
            device_department: p.department,
            device_position: p.position,
            needs_hr_review: true,
            entity_inferred: p.entity === HOME_ENTITY && !p.department ? 'default' : 'from department',
          }),
        ]
      );
      const employeeId = ins.rows[0].id;

      await db.query(
        `update public.biotime_employees
            set employee_id = $1, link_status = 'manual', linked_at = now(), updated_at = now()
          where emp_code = $2`,
        [employeeId, p.emp_code]
      );

      const punches = await db.query(
        `update public.raw_punches set employee_id = $1
          where emp_code = $2 and employee_id is null
         returning punch_time`,
        [employeeId, p.emp_code]
      );
      adopted += punches.rowCount;

      if (punches.rowCount) {
        // Group by the IST calendar day, which is what work_date means. Deriving the day from the
        // UTC instant would put an evening punch on the wrong date.
        const days = [...new Set(punches.rows.map((r) =>
          new Date(new Date(r.punch_time).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)))];
        for (const d of days) {
          await db.query(
            `insert into public.attendance_recompute_queue (employee_id, work_date, reason)
             values ($1, $2, $3)`,
            [employeeId, d, `employee created from device enrolment ${p.emp_code}`]
          );
          queued += 1;
        }
      }

      await db.query('commit');
      created += 1;
    } catch (err) {
      await db.query('rollback');
      failed += 1;
      console.error(`    failed on ${p.emp_code} ${p.name}: ${err.message}`);
    }
  }

  console.log(`\n  Created ${created} employees${failed ? `, ${failed} failed` : ''}.`);
  console.log(`  Adopted ${adopted} punches, queued ${queued} day-recomputes.`);
  console.log(`  Run:  cd ../../services/attendance && npm run recompute -- --queue\n`);
  await db.end();
}

main().catch((e) => { console.error('\nFailed:', e.message, '\n'); process.exit(1); });
