#!/usr/bin/env node
/**
 * Generate believable attendance history so the analytics screens can be exercised before the
 * ZKTeco terminals are connected.
 *
 *   node scripts/dev/mockAttendance.js --days 60      generate (dry run first — see below)
 *   node scripts/dev/mockAttendance.js --days 60 --apply
 *   node scripts/dev/mockAttendance.js --clean --apply    remove every mock row
 *
 * EVERY row is written with source='mock'. Real punches from the sync service arrive as
 * source='device', so the two never mix and --clean can remove the test data exactly, with no
 * risk to anything real. Check before trusting it:
 *
 *   select source, count(*) from public.attendance group by 1;
 *
 * The shapes are deliberately imperfect — a roster where everyone arrives at 09:30 exactly would
 * make the late/early/overtime analytics look like they work when they have never been exercised.
 *
 * The upsert carries `where source = 'mock'`, so a day that already holds REAL attendance is left
 * alone rather than being overwritten. Without that guard this script would happily replace a
 * device-sourced day with invented times — which it did once, before the guard existed.
 */
const path = require('node:path');
const fs = require('node:fs');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const APPLY = process.argv.includes('--apply');
const CLEAN = process.argv.includes('--clean');
const DAYS = Number((process.argv.find((a) => a.startsWith('--days=')) || '').split('=')[1])
  || Number(process.argv[process.argv.indexOf('--days') + 1]) || 60;

// Deterministic PRNG: the same run produces the same data, so a bug found in the UI can be
// reproduced rather than regenerated away.
let seed = 20260727;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (n) => Math.floor(rnd() * n);
const jitter = (spread) => Math.round((rnd() - 0.5) * 2 * spread);

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

const iso = (d) => d.toISOString().slice(0, 10);

// check_in/check_out are timestamptz, not time-of-day. The app works in IST, so a punch is
// written as an absolute instant with the +05:30 offset stated — never a bare local time, which
// Postgres would interpret in the server's zone and silently shift by five and a half hours.
const stamp = (dateStr, mins) => {
  const h = String(Math.floor(mins / 60)).padStart(2, '0');
  const m = String(mins % 60).padStart(2, '0');
  return `${dateStr}T${h}:${m}:00+05:30`;
};

/** One person's day. Returns null for a weekly off. */
function makeDay(dateStr, dow, profile) {
  if (dow === 0) {
    return { status: 'Weekly Off', day_type: 'Weekly Off', worked_minutes: 0, day_fraction: 0 };
  }

  const roll = rnd();
  // Absence and leave rates vary by person so the analytics have someone to flag.
  if (roll < profile.absentRate) {
    return { status: 'Absent', day_type: 'Working', worked_minutes: 0, day_fraction: 0, is_lop: true };
  }
  if (roll < profile.absentRate + profile.leaveRate) {
    return {
      status: 'On Leave', day_type: 'Working', worked_minutes: 0, day_fraction: 0,
      leave_type: rnd() < 0.6 ? 'Casual' : 'Sick',
    };
  }

  const SCHED_IN = 9 * 60 + 30;   // 09:30
  const SCHED_OUT = 18 * 60 + 30; // 18:30

  // Habitually-late people drift later; everyone has day-to-day noise.
  const inMin = SCHED_IN + profile.lateBias + jitter(profile.spread);
  const lateMinutes = Math.max(0, inMin - SCHED_IN - 10); // 10-minute grace

  // A missing punch-out happens occasionally and is its own exception, not an absence.
  if (rnd() < profile.missingRate) {
    return {
      status: 'Present', day_type: 'Working', check_in: stamp(dateStr, inMin), check_out: null,
      worked_minutes: 0, late_minutes: lateMinutes, is_late: lateMinutes > 0,
      is_missing_punch: true, punch_count: 1, day_fraction: 1,
    };
  }

  const outMin = SCHED_OUT + profile.otBias + jitter(profile.spread);
  const earlyExit = Math.max(0, SCHED_OUT - outMin);
  const ot = Math.max(0, outMin - SCHED_OUT - 15); // 15-minute buffer before it counts as OT
  const worked = Math.max(0, outMin - inMin - 45); // 45-minute unpaid break

  return {
    status: 'Present', day_type: 'Working',
    check_in: stamp(dateStr, inMin), check_out: stamp(dateStr, outMin),
    worked_minutes: worked, hours: Number((worked / 60).toFixed(2)),
    late_minutes: lateMinutes, early_exit_minutes: earlyExit, ot_minutes: ot,
    is_late: lateMinutes > 0, is_early_exit: earlyExit > 0,
    punch_count: 2, day_fraction: 1,
  };
}

async function main() {
  const env = loadEnv();
  const db = new Client({ connectionString: env.SUPABASE_DB_URL });
  await db.connect();

  if (CLEAN) {
    const { rows } = await db.query("select count(*)::int n from public.attendance where source = 'mock'");
    console.log(`\n  ${rows[0].n} mock rows found.`);
    if (APPLY) {
      const r = await db.query("delete from public.attendance where source = 'mock'");
      console.log(`  Deleted ${r.rowCount}. Real (source='device') rows untouched.\n`);
    } else {
      console.log('  Dry run — re-run with --apply to delete them.\n');
    }
    await db.end();
    return;
  }

  const { rows: people } = await db.query(
    `select id, entity_id, zone_id, branch_id, department_id, full_name
       from public.employees where status = 'Active' order by employee_code`
  );
  if (!people.length) { console.log('\n  No employees. Import the roster first.\n'); await db.end(); return; }

  // A per-person profile, stable across the run, so trends are consistent: the same person is
  // habitually late every week rather than randomly on any given day.
  const profiles = people.map((p, i) => {
    seed = 20260727 + i * 7919;
    const kind = pick(10);
    return {
      ...p,
      lateBias: kind < 2 ? 18 + pick(20) : kind < 5 ? 4 : -3,   // 20% habitually late
      otBias: kind > 7 ? 35 + pick(40) : 2,                     // 20% regularly stay on
      absentRate: kind === 9 ? 0.10 : 0.03,                     // one in ten is absent-prone
      leaveRate: 0.04,
      missingRate: 0.015,
      spread: 12,
    };
  });

  const today = new Date();
  const rows = [];
  // Down to 0, i.e. INCLUDING today. Stopping at 1 left the day view — which shows today — empty
  // while sixty days of history sat behind it.
  for (let back = DAYS; back >= 0; back--) {
    const d = new Date(today);
    d.setDate(d.getDate() - back);
    const dateStr = iso(d);
    const dow = d.getDay();
    for (const p of profiles) {
      const day = makeDay(dateStr, dow, p);
      if (!day) continue;
      // The flag columns are NOT NULL, so every one is stated explicitly and `day` overrides
      // only what actually happened. Spreading a partial object over no defaults is how you get
      // "null value in column is_missing_punch violates not-null constraint" halfway through.
      rows.push({
        employee_id: p.id, entity_id: p.entity_id, zone_id: p.zone_id,
        branch_id: p.branch_id, department_id: p.department_id,
        work_date: dateStr, source: 'mock',
        scheduled_in: stamp(dateStr, 9 * 60 + 30), scheduled_out: stamp(dateStr, 18 * 60 + 30),
        check_in: null, check_out: null, hours: 0,
        worked_minutes: 0, late_minutes: 0, early_exit_minutes: 0, ot_minutes: 0,
        is_late: false, is_early_exit: false, is_missing_punch: false, is_lop: false,
        leave_type: null, punch_count: 0, day_fraction: 0,
        ...day,
      });
    }
  }

  const present = rows.filter((r) => r.status === 'Present').length;
  console.log(`\n  ${people.length} employees × ${DAYS} days -> ${rows.length} rows`);
  console.log(`    present ${present}  absent ${rows.filter((r) => r.status === 'Absent').length}` +
    `  leave ${rows.filter((r) => r.status === 'On Leave').length}` +
    `  weekly off ${rows.filter((r) => r.status === 'Weekly Off').length}`);
  console.log(`    late days ${rows.filter((r) => r.is_late).length}` +
    `  missing punch ${rows.filter((r) => r.is_missing_punch).length}` +
    `  with overtime ${rows.filter((r) => r.ot_minutes > 0).length}`);

  if (!APPLY) {
    console.log('\n  Dry run — nothing written. Re-run with --apply.\n');
    await db.end();
    return;
  }

  const COLS = ['employee_id','entity_id','zone_id','branch_id','department_id','work_date','source',
    'scheduled_in','scheduled_out','status','day_type','check_in','check_out','hours','worked_minutes',
    'late_minutes','early_exit_minutes','ot_minutes','is_late','is_early_exit','is_missing_punch',
    'is_lop','leave_type','punch_count','day_fraction'];

  let done = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    slice.forEach((r, n) => {
      values.push(`(${COLS.map((_, k) => `$${n * COLS.length + k + 1}`).join(',')})`);
      COLS.forEach((c) => params.push(r[c] ?? null));
    });
    // (employee_id, work_date) is unique — re-running replaces rather than duplicating.
    await db.query(
      `insert into public.attendance (${COLS.join(',')}) values ${values.join(',')}
       on conflict (employee_id, work_date) do update set
         source = excluded.source, status = excluded.status, day_type = excluded.day_type,
         check_in = excluded.check_in, check_out = excluded.check_out, hours = excluded.hours,
         worked_minutes = excluded.worked_minutes, late_minutes = excluded.late_minutes,
         early_exit_minutes = excluded.early_exit_minutes, ot_minutes = excluded.ot_minutes,
         is_late = excluded.is_late, is_early_exit = excluded.is_early_exit,
         is_missing_punch = excluded.is_missing_punch, is_lop = excluded.is_lop,
         leave_type = excluded.leave_type, punch_count = excluded.punch_count,
         day_fraction = excluded.day_fraction
       where public.attendance.source = 'mock'`,
      params
    );
    done += slice.length;
    process.stdout.write(`\r  writing ${done}/${rows.length}`);
  }

  const total = await db.query("select source, count(*)::int n from public.attendance group by 1 order by 1");
  console.log(`\n\n  Done. attendance now holds:`);
  total.rows.forEach((r) => console.log(`    ${r.source}: ${r.n}`));
  console.log(`\n  Remove it all with:  node scripts/dev/mockAttendance.js --clean --apply\n`);
  await db.end();
}

main().catch((e) => { console.error('\nFailed:', e.message, '\n'); process.exit(1); });
