#!/usr/bin/env node
/**
 * Set each employee's join date from their first punch, where HR has not recorded one.
 *
 *   node scripts/deriveJoinDates.js              dry run
 *   node scripts/deriveJoinDates.js --apply
 *   node scripts/deriveJoinDates.js --clear      undo (only rows this script set)
 *
 * RUN THIS BETWEEN THE BACKFILL AND THE RECOMPUTE.
 *
 * The engine computes every active employee over whatever range it is asked for, so a year of
 * history would open an Absent row for each of today's 162 staff on every working day of that
 * year — including all the days before someone was hired. Nobody currently has a join_date, so
 * there is nothing to stop it.
 *
 * The punches themselves are the evidence: the earliest punch on somebody's device code is the
 * first day they stood in front of a terminal, which is the best available proxy for their start
 * date. It is a floor, not a fact — a person may have worked for weeks before being enrolled, and
 * the terminal may have been installed after they joined — so the derived date is written into
 * meta.join_date_source = 'first punch' and can be corrected in the UI.
 *
 * What it will NOT do: overwrite a join_date somebody has already entered. HR's record wins.
 */
const path = require('node:path');
const fs = require('node:fs');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const CLEAR = process.argv.includes('--clear');

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

  if (CLEAR) {
    const { rows } = await db.query(
      `select count(*)::int n from public.employees where meta->>'join_date_source' = 'first punch'`
    );
    console.log(`\n  ${rows[0].n} employees have a join date derived from punches.`);
    if (APPLY) {
      const r = await db.query(
        `update public.employees
            set join_date = null, meta = meta - 'join_date_source'
          where meta->>'join_date_source' = 'first punch'`
      );
      console.log(`  Cleared ${r.rowCount}. Dates entered by hand were left alone.\n`);
    } else {
      console.log('  Dry run — re-run with --apply to clear them.\n');
    }
    await db.end();
    return;
  }

  const { rows: candidates } = await db.query(`
    select e.id, e.employee_code, e.full_name,
           to_char(min(p.punch_time at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as first_punch,
           count(p.id)::int as punches
      from public.employees e
      join public.raw_punches p on p.employee_id = e.id
     where e.join_date is null
     group by e.id, e.employee_code, e.full_name
     order by 4
  `);

  const { rows: [{ n: noPunches }] } = await db.query(`
    select count(*)::int n from public.employees e
     where e.join_date is null
       and not exists (select 1 from public.raw_punches p where p.employee_id = e.id)
  `);

  console.log(`\n  ${candidates.length} employees would get a join date from their first punch`);
  if (noPunches) console.log(`  ${noPunches} have no punches at all — left as unknown`);

  // A date equal to the very start of the punch history usually means "was already working when
  // the terminal started recording", not "joined that day". Worth saying out loud.
  const earliest = candidates.reduce((a, c) => (!a || c.first_punch < a ? c.first_punch : a), null);
  const atFloor = candidates.filter((c) => c.first_punch === earliest).length;

  console.log(`\n  earliest punch in the data: ${earliest}`);
  console.log(`  ${atFloor} people first punched on that date — for them this is almost certainly`);
  console.log(`  "already employed when recording began", not a real start date.\n`);

  console.log('  A sample:');
  candidates.slice(0, 8).forEach((c) =>
    console.log(`    ${String(c.employee_code).padEnd(11)} ${String(c.full_name).slice(0, 22).padEnd(24)} ${c.first_punch}  (${c.punches} punches)`));
  if (candidates.length > 8) console.log(`    … and ${candidates.length - 8} more`);

  if (!APPLY) {
    console.log('\n  Dry run — nothing written. Re-run with --apply.\n');
    await db.end();
    return;
  }

  let set = 0;
  for (const c of candidates) {
    await db.query(
      `update public.employees
          set join_date = $2::date,
              meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('join_date_source', 'first punch')
        where id = $1 and join_date is null`,
      [c.id, c.first_punch]
    );
    set += 1;
  }

  console.log(`\n  Set ${set} join dates.`);
  console.log('  Now recompute, and days before each start date will be skipped:');
  console.log('    cd services/attendance && npm run recompute -- --from <start> --to <end>\n');
  await db.end();
}

main().catch((e) => { console.error('\nFailed:', e.message, '\n'); process.exit(1); });
