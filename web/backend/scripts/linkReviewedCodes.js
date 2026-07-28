#!/usr/bin/env node
/**
 * Link the device codes that scripts/linkDeviceCodes.js deliberately refused to guess at.
 *
 *   node scripts/linkReviewedCodes.js           dry run
 *   node scripts/linkReviewedCodes.js --apply
 *
 * These eighteen scored 0.78-0.89 on name similarity: close enough to be suspicious, not close
 * enough to be automatic. Each was then checked against the whole 242-person roster by first name.
 * Sixteen turned out to have exactly one possible owner, which makes them safe. Two did not, and
 * are resolved here by employee code rather than by name:
 *
 *   1015 "SINDHU PR"  There are seven Sindhus. The fuzzy matcher chose "Sindhu P B" (0.86) because
 *                     "Sindhu P R (Ajith)" carries a parenthetical husband's name that drags the
 *                     score down — but P R is plainly the same initials as the device's "PR", and
 *                     P B is a different person. Pinned to PPL-0074.
 *   2010 "latha ms"   "Latha.M.S" and "Latha Pp" both exist. M S matches. Pinned to PPL-0035.
 *
 * The pairs below are the whole decision. Nothing here is inferred at run time except the lookup,
 * and a name that does not resolve to exactly one employee is skipped rather than guessed.
 */
const path = require('node:path');
const fs = require('node:fs');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');

// device code -> how to find the employee. `code` is exact and wins; `name` must be unique.
const PAIRS = [
  { device: '7159', name: 'Shijil' },
  { device: '7315', name: 'Chikku Subramanian' },
  { device: '1015', code: 'PPL-0074', note: 'Sindhu P R (Ajith) — not "Sindhu P B"' },
  { device: '2014', name: 'Beena' },
  { device: '2010', code: 'PPL-0035', note: 'Latha.M.S — not "Latha Pp"' },
  { device: '3075', name: 'Gibin Cheriyan' },
  { device: '1014', name: 'Bindu V R (Aji)' },
  { device: '1038', name: 'Lathika Velayudhan' },
  { device: '1096', name: 'Goutham Prusty' },
  { device: '5001', name: 'Mallika' },
  { device: '7220', name: 'Sindhukumari Lakshmanan' },
  { device: '2132', name: 'Rema' },
  { device: '3094', name: 'Vrindha' },
  { device: '5009', name: 'Syamala Kumari O S' },
  { device: '7267', name: 'Radhika' },
  { device: '3085', name: 'Valsalan Gurikkalot' },
  { device: '2009', name: 'Jasmine Thoppil' },
  { device: '5026', name: 'Bineesh Salim' },
];

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

async function main() {
  const db = new Client({ connectionString: loadEnv().SUPABASE_DB_URL });
  await db.connect();

  const resolved = [];
  const problems = [];

  for (const p of PAIRS) {
    const { rows } = p.code
      ? await db.query('select id, full_name, employee_code from public.employees where employee_code = $1', [p.code])
      : await db.query('select id, full_name, employee_code from public.employees where full_name = $1', [p.name]);

    if (rows.length !== 1) {
      problems.push({ ...p, why: rows.length === 0 ? 'no employee matches' : `${rows.length} employees match — ambiguous` });
      continue;
    }

    const enrol = await db.query(
      `select full_name, link_status, employee_id,
              (select count(*)::int from public.raw_punches r where r.emp_code = b.emp_code) punches
         from public.biotime_employees b where emp_code = $1`,
      [p.device]
    );
    if (!enrol.rows.length) { problems.push({ ...p, why: 'device code not enrolled' }); continue; }
    if (enrol.rows[0].employee_id) { problems.push({ ...p, why: 'already linked' }); continue; }

    resolved.push({ ...p, employee: rows[0], device_name: enrol.rows[0].full_name, punches: enrol.rows[0].punches });
  }

  console.log(`\n  ${resolved.length} of ${PAIRS.length} ready to link\n`);
  resolved.forEach((r) =>
    console.log(`    ${r.device.padEnd(6)} ${String(r.device_name).slice(0, 20).padEnd(22)} -> ` +
      `${r.employee.full_name.slice(0, 24).padEnd(26)} ${r.employee.employee_code.padEnd(10)} ${String(r.punches).padStart(3)}p` +
      `${r.note ? `   (${r.note})` : ''}`));
  if (problems.length) {
    console.log('\n  NOT LINKED:');
    problems.forEach((p) => console.log(`    ${p.device.padEnd(6)} ${p.code || p.name}: ${p.why}`));
  }

  if (!APPLY) {
    console.log('\n  Dry run — nothing written. Re-run with --apply.\n');
    await db.end();
    return;
  }

  let linked = 0, adopted = 0, queued = 0;
  for (const r of resolved) {
    await db.query('begin');
    try {
      await db.query(
        `update public.biotime_employees
            set employee_id = $1, link_status = 'manual', linked_at = now(), updated_at = now()
          where emp_code = $2`,
        [r.employee.id, r.device]
      );
      const punches = await db.query(
        `update public.raw_punches set employee_id = $1
          where emp_code = $2 and employee_id is null returning punch_time`,
        [r.employee.id, r.device]
      );
      adopted += punches.rowCount;
      // IST calendar day — work_date is a local date, not a UTC one.
      const days = [...new Set(punches.rows.map((x) =>
        new Date(new Date(x.punch_time).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)))];
      for (const d of days) {
        await db.query(
          'insert into public.attendance_recompute_queue (employee_id, work_date, reason) values ($1, $2, $3)',
          [r.employee.id, d, `device code ${r.device} linked after review`]
        );
        queued += 1;
      }
      await db.query('commit');
      linked += 1;
    } catch (e) {
      await db.query('rollback');
      console.error(`    failed on ${r.device}: ${e.message}`);
    }
  }

  console.log(`\n  Linked ${linked}. Adopted ${adopted} punches, queued ${queued} day-recomputes.`);
  console.log(`  Run:  cd ../../services/attendance && npm run recompute -- --queue\n`);
  await db.end();
}

main().catch((e) => { console.error('\nFailed:', e.message, '\n'); process.exit(1); });
