#!/usr/bin/env node
/**
 * Link Easy Time Pro enrolments to HR employees in bulk, by name.
 *
 *   node scripts/linkDeviceCodes.js                  dry run — shows every proposed link
 *   node scripts/linkDeviceCodes.js --apply
 *   node scripts/linkDeviceCodes.js --min 0.8 --apply    lower the bar (see the warning below)
 *
 * WHY THIS EXISTS
 * The terminals identify people by their own numeric codes (1015, 3031). The HR roster was
 * imported from spreadsheets that carried no employee numbers, so its codes are generated
 * (HO90-0001). Nothing matches on code, and mapping 163 people by hand is a poor use of an
 * afternoon when most of the names are identical.
 *
 * WHAT IT WILL NOT DO
 * Only links where the top name match scores >= --min (default 0.90) AND is clearly ahead of the
 * runner-up. A wrong link silently attributes one person's attendance — and therefore their pay —
 * to somebody else, which is worse than leaving it unmapped. "SINDHU PR" vs "Sindhu P B" vs
 * "Sindhu MT" is exactly the case this refuses to guess at; those stay for a human in
 * HR > Devices & Mapping.
 *
 * It mirrors what the app's own link endpoint does:
 *   1. set biotime_employees.employee_id and link_status='manual'
 *   2. adopt existing raw_punches for that code
 *   3. queue a recompute so attendance is rebuilt for the days affected
 * The running sync service drains that queue, so attendance appears without restarting anything.
 */
const path = require('node:path');
const fs = require('node:fs');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const MIN = Number((process.argv[process.argv.indexOf('--min') + 1])) || 0.9;
const MARGIN = 0.05; // the top match must beat the runner-up by at least this

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

  const { rows: candidates } = await db.query(`
    select b.emp_code, b.full_name as device_name,
           (b.match_suggestions->0->>'employee_id')::uuid as employee_id,
           b.match_suggestions->0->>'full_name'          as hr_name,
           (b.match_suggestions->0->>'score')::numeric   as score,
           (b.match_suggestions->1->>'score')::numeric   as runner_up,
           (select count(*)::int from public.raw_punches p where p.emp_code = b.emp_code) as punches
      from public.biotime_employees b
     where b.link_status = 'unmatched'
       and b.match_suggestions is not null
       and jsonb_array_length(b.match_suggestions) > 0
     order by score desc nulls last, punches desc
  `);

  const willLink = [];
  const skipped = [];
  for (const c of candidates) {
    const score = Number(c.score);
    const runner = c.runner_up == null ? 0 : Number(c.runner_up);
    if (!c.employee_id) { skipped.push({ ...c, why: 'suggestion carries no employee id' }); continue; }
    if (score < MIN) { skipped.push({ ...c, why: `score ${score.toFixed(2)} below ${MIN}` }); continue; }
    if (score - runner < MARGIN) {
      skipped.push({ ...c, why: `too close to runner-up (${score.toFixed(2)} vs ${runner.toFixed(2)})` });
      continue;
    }
    willLink.push(c);
  }

  // Two device codes must never point at the same person — that would merge two people's days.
  const byEmployee = new Map();
  const contested = [];
  for (const c of willLink) {
    if (byEmployee.has(c.employee_id)) {
      contested.push(c);
    } else byEmployee.set(c.employee_id, c);
  }
  const finalLinks = willLink.filter((c) => !contested.includes(c));
  contested.forEach((c) => skipped.push({ ...c, why: 'another device code already maps to this person' }));

  console.log(`\n  ${candidates.length} unmatched enrolments with a suggestion`);
  console.log(`  ${finalLinks.length} will be linked   (score >= ${MIN}, clear of the runner-up)`);
  console.log(`  ${skipped.length} left for a human in HR > Devices & Mapping\n`);

  console.log('  LINKING:');
  finalLinks.slice(0, 12).forEach((c) =>
    console.log(`    ${String(c.emp_code).padEnd(6)} ${String(c.device_name).slice(0, 22).padEnd(24)}` +
      `-> ${String(c.hr_name).slice(0, 24).padEnd(26)} ${Number(c.score).toFixed(2)}  ${c.punches} punches`));
  if (finalLinks.length > 12) console.log(`    … and ${finalLinks.length - 12} more`);

  console.log('\n  LEFT ALONE (a wrong link misattributes someone\'s attendance):');
  skipped.slice(0, 8).forEach((c) =>
    console.log(`    ${String(c.emp_code).padEnd(6)} ${String(c.device_name).slice(0, 22).padEnd(24)}${c.why}`));
  if (skipped.length > 8) console.log(`    … and ${skipped.length - 8} more`);

  if (!APPLY) {
    console.log('\n  Dry run — nothing written. Re-run with --apply.\n');
    await db.end();
    return;
  }

  let linked = 0, punchesAdopted = 0, queued = 0;
  for (const c of finalLinks) {
    await db.query('begin');
    try {
      await db.query(
        `update public.biotime_employees
            set employee_id = $1, link_status = 'manual', linked_at = now(), updated_at = now()
          where emp_code = $2`,
        [c.employee_id, c.emp_code]
      );

      // Adopt the punches already collected under this code.
      const adopt = await db.query(
        `update public.raw_punches set employee_id = $1
          where emp_code = $2 and employee_id is null
         returning punch_time`,
        [c.employee_id, c.emp_code]
      );
      punchesAdopted += adopt.rowCount;

      // Queue a recompute for every day those punches touch. The running service drains this.
      if (adopt.rowCount) {
        const days = [...new Set(adopt.rows.map((r) => new Date(r.punch_time).toISOString().slice(0, 10)))];
        for (const d of days) {
          await db.query(
            `insert into public.attendance_recompute_queue (employee_id, work_date, reason)
             values ($1, $2, $3)`,
            [c.employee_id, d, `device code ${c.emp_code} linked in bulk`]
          );
          queued += 1;
        }
      }
      await db.query('commit');
      linked += 1;
    } catch (e) {
      await db.query('rollback');
      console.error(`    failed on ${c.emp_code}: ${e.message}`);
    }
  }

  console.log(`\n  Linked ${linked} people.`);
  console.log(`  Adopted ${punchesAdopted} existing punches.`);
  console.log(`  Queued ${queued} day-recomputes — the running service will pick these up.\n`);
  await db.end();
}

main().catch((e) => { console.error('\nFailed:', e.message, '\n'); process.exit(1); });
