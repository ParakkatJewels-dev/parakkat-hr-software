#!/usr/bin/env node
/**
 * Compare our attendance against Easy Time Pro's own Monthly Status Report.
 *
 *   node scripts/compareWithDeviceReport.js "../../easy pro time data/Monthly Status Report....xlsx"
 *   node scripts/compareWithDeviceReport.js <file> --employee 1013     one person, day by day
 *
 * This is the only way to check our engine against the system everyone already trusts. Every rule
 * in processDay was written from a description of the policy; this compares the OUTPUT of those
 * rules against the output of theirs, on the same punches, for the same month.
 *
 * The report's shape: one 12-row block per employee. A header line carrying the name, device id,
 * department and the month's totals, then a date row, then one row each for Status, Clock In,
 * Clock Out, Total WK, Late, Early, OT and Timetable — a column per day of the month.
 */
const path = require('node:path');
const fs = require('node:fs');
const { Client } = require('pg');
const XLSX = require(path.join(__dirname, '..', '..', 'node_modules', 'xlsx'));

const ROOT = path.join(__dirname, '..');
const file = process.argv[2];
const onlyEmp = process.argv.includes('--employee')
  ? String(process.argv[process.argv.indexOf('--employee') + 1])
  : null;

if (!file) {
  console.log('\n  Give it the path to the Monthly Status Report .xlsx\n');
  process.exit(1);
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

/** 'HH:MM' -> minutes. Their durations and clock times share this format. */
const toMinutes = (v) => {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{1,3}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Pull every employee block out of the sheet. */
function parseReport(rows) {
  const blocks = [];
  rows.forEach((r, i) => {
    if (typeof r[0] === 'string' && r[0].startsWith('Employee Name:')) blocks.push(i);
  });

  const out = [];
  for (const start of blocks) {
    const header = String(rows[start][0]).replace(/\s+/g, ' ');
    const pick = (label) => {
      const m = header.match(new RegExp(`${label}:\\s*([^,]*)`, 'i'));
      return m ? m[1].trim() : '';
    };

    const dateRow = rows[start + 1] ?? [];
    // "1 W", "2 Th" -> day-of-month numbers, keeping the column position.
    const days = dateRow.map((cell, col) => {
      const m = typeof cell === 'string' ? cell.match(/^(\d{1,2})\s/) : null;
      return m ? { col, day: Number(m[1]) } : null;
    }).filter(Boolean);

    const rowFor = (label) => {
      for (let i = start + 2; i < start + 11; i++) {
        if (String(rows[i]?.[1] ?? '').trim().toLowerCase() === label) return rows[i];
      }
      return [];
    };

    out.push({
      name: pick('Employee Name'),
      empCode: pick('Employee ID'),
      department: pick('Department'),
      totalWk: pick('Total WK'),
      present: Number(pick('Present') || 0),
      absent: Number(pick('Absent') || 0),
      late: pick('Late'),
      lateTimes: Number(pick('Late Times') || 0),
      days,
      status: rowFor('status'),
      clockIn: rowFor('clock in'),
      clockOut: rowFor('clock out'),
      totalWkRow: rowFor('total wk'),
      lateRow: rowFor('late'),
      otRow: rowFor('ot'),
    });
  }
  return out;
}

/**
 * Their status letters -> ours.
 *
 * LT (late) and EL (early leave) are not separate outcomes for us: the person attended, and the
 * lateness or the early exit is recorded as minutes on the day rather than as a different status.
 * EL was unmapped at first, which reported 77 real agreements as disagreements.
 */
const THEIR_STATUS = {
  P: 'Present', A: 'Absent',
  LT: 'Present', EL: 'Present',
  E: 'Present', H: 'Holiday', W: 'Weekly Off', L: 'On Leave',
};

async function main() {
  const wb = XLSX.readFile(path.isAbsolute(file) ? file : path.join(process.cwd(), file));
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  // "From July 01 2026 To July 31 2026"
  const period = String(rows[1]?.[0] ?? '');
  const pm = period.match(/From\s+(\w+)\s+(\d{1,2})\s+(\d{4})\s+To\s+(\w+)\s+(\d{1,2})\s+(\d{4})/i);
  const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const month = pm ? MONTHS.indexOf(pm[1].toLowerCase()) + 1 : null;
  const year = pm ? Number(pm[3]) : null;
  if (!month || !year) { console.log('\n  Could not read the report period.\n'); process.exit(1); }

  const blocks = parseReport(rows);
  console.log(`\n  Easy Time Pro report: ${pm[1]} ${year}, ${blocks.length} employees\n`);

  const db = new Client({ connectionString: loadEnv().SUPABASE_DB_URL });
  await db.connect();

  const ours = new Map();
  const { rows: mine } = await db.query(`
    select b.emp_code, to_char(a.work_date, 'DD')::int as dom, a.status, a.worked_minutes,
           a.late_minutes, a.ot_minutes,
           to_char(a.check_in  at time zone 'Asia/Kolkata', 'HH24:MI') as ci,
           to_char(a.check_out at time zone 'Asia/Kolkata', 'HH24:MI') as co
      from public.attendance a
      join public.biotime_employees b on b.employee_id = a.employee_id
     where extract(month from a.work_date) = $1 and extract(year from a.work_date) = $2
  `, [month, year]);
  for (const r of mine) {
    if (!ours.has(r.emp_code)) ours.set(r.emp_code, new Map());
    ours.get(r.emp_code).set(r.dom, r);
  }

  // --- one person, in detail ------------------------------------------------------------------
  if (onlyEmp) {
    const b = blocks.find((x) => x.empCode === onlyEmp);
    if (!b) { console.log(`  No employee ${onlyEmp} in the report.\n`); await db.end(); return; }
    const mineFor = ours.get(onlyEmp) ?? new Map();

    console.log(`  ${b.name} (${b.empCode}) — ${b.department}`);
    console.log(`  their month: WK ${b.totalWk}, present ${b.present}, absent ${b.absent}, late ${b.late} x${b.lateTimes}\n`);
    console.log(`    ${'day'.padStart(3)}  ${'THEIRS'.padEnd(34)}  OURS`);
    console.log(`    ${''.padStart(3)}  ${'status in-out       wk    late'.padEnd(34)}  status in-out       wk    late`);
    console.log('    ' + '-'.repeat(76));
    for (const { col, day } of b.days) {
      const th = {
        st: b.status[col], ci: b.clockIn[col], co: b.clockOut[col],
        wk: b.totalWkRow[col], late: b.lateRow[col],
      };
      const us = mineFor.get(day);
      if (!th.st && !us) continue;
      const t = `${String(th.st ?? '-').padEnd(6)} ${String(th.ci ?? '--:--')}-${String(th.co ?? '--:--')}  ${String(th.wk ?? '-').padEnd(6)}${String(th.late ?? '')}`;
      const o = us
        ? `${String(us.status).slice(0, 6).padEnd(6)} ${String(us.ci ?? '--:--')}-${String(us.co ?? '--:--')}  ${(Math.floor(us.worked_minutes / 60) + ':' + String(us.worked_minutes % 60).padStart(2, '0')).padEnd(6)}${us.late_minutes ? us.late_minutes + 'm' : ''}`
        : '(no row)';
      const wkTheirs = toMinutes(th.wk);
      const diff = wkTheirs != null && us ? us.worked_minutes - wkTheirs : null;
      console.log(`    ${String(day).padStart(3)}  ${t.padEnd(34)}  ${o}${diff ? `   ${diff > 0 ? '+' : ''}${diff}m` : ''}`);
    }
    await db.end();
    return;
  }

  // --- everyone: where do the two disagree? ----------------------------------------------------
  let compared = 0, statusMatch = 0, wkExact = 0;
  let wkDiffTotal = 0;
  const worst = [];
  const statusDiffs = new Map();

  for (const b of blocks) {
    const mineFor = ours.get(b.empCode);
    if (!mineFor) continue;

    for (const { col, day } of b.days) {
      const theirStatus = b.status[col];
      if (!theirStatus) continue;
      const us = mineFor.get(day);
      if (!us) continue;

      compared += 1;

      const expect = THEIR_STATUS[String(theirStatus).trim().toUpperCase()];
      if (expect && (us.status === expect || (expect === 'Present' && us.status === 'Half Day'))) statusMatch += 1;
      else {
        const key = `${theirStatus} -> ${us.status}`;
        statusDiffs.set(key, (statusDiffs.get(key) ?? 0) + 1);
      }

      const theirWk = toMinutes(b.totalWkRow[col]);
      if (theirWk != null) {
        const d = us.worked_minutes - theirWk;
        wkDiffTotal += d;
        if (d === 0) wkExact += 1;
        else worst.push({ name: b.name, code: b.empCode, day, theirs: theirWk, ours: us.worked_minutes, d });
      }
    }
  }

  console.log('  DAY-BY-DAY COMPARISON');
  console.log(`    ${compared} employee-days present in both`);
  console.log(`    status agrees on ${statusMatch} (${Math.round(statusMatch / compared * 100)}%)`);
  console.log(`    worked time identical on ${wkExact} (${Math.round(wkExact / compared * 100)}%)`);
  console.log(`    our total minus theirs: ${wkDiffTotal > 0 ? '+' : ''}${Math.round(wkDiffTotal / 60)} hours across the month`);

  if (statusDiffs.size) {
    console.log('\n  WHERE THE STATUS DIFFERS  (theirs -> ours)');
    [...statusDiffs.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 10)
      .forEach(([k, n]) => console.log(`    ${String(n).padStart(5)}  ${k}`));
  }

  worst.sort((a, b2) => Math.abs(b2.d) - Math.abs(a.d));
  console.log('\n  BIGGEST WORKED-TIME DIFFERENCES');
  worst.slice(0, 12).forEach((w) =>
    console.log(`    ${String(w.name).slice(0, 20).padEnd(22)} day ${String(w.day).padStart(2)}  theirs ${String(w.theirs).padStart(4)}m  ours ${String(w.ours).padStart(4)}m  ${w.d > 0 ? '+' : ''}${w.d}m`));

  // Their monthly header totals are an independent check on the per-day rows.
  console.log('\n  MONTH TOTALS PER PERSON  (their header vs our sum)');
  console.log(`    ${'name'.padEnd(22)} ${'theirs'.padStart(9)} ${'ours'.padStart(9)} ${'diff'.padStart(8)}`);
  let shown = 0;
  for (const b of blocks) {
    const theirs = toMinutes(b.totalWk);
    const mineFor = ours.get(b.empCode);
    if (theirs == null || !mineFor) continue;
    const oursTotal = [...mineFor.values()].reduce((a, r) => a + r.worked_minutes, 0);
    const d = oursTotal - theirs;
    if (Math.abs(d) < 60) continue; // within an hour is noise at this stage
    if (shown++ >= 12) break;
    console.log(`    ${String(b.name).slice(0, 20).padEnd(22)} ${(Math.round(theirs / 60) + 'h').padStart(9)} ${(Math.round(oursTotal / 60) + 'h').padStart(9)} ${((d > 0 ? '+' : '') + Math.round(d / 60) + 'h').padStart(8)}`);
  }
  if (!shown) console.log('    every person is within an hour of their figure');

  await db.end();
}

main().catch((e) => { console.error('\nFailed:', e.message, '\n'); process.exit(1); });
