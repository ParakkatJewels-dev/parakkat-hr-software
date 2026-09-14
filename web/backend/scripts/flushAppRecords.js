#!/usr/bin/env node
/**
 * Clear the operational records the app accumulated, and nothing that came from Easy Time Pro.
 *
 *   node scripts/flushAppRecords.js                      dry run (default)
 *   node scripts/flushAppRecords.js --apply
 *   node scripts/flushAppRecords.js --restore backups/<file>.json --apply
 *
 * WHY THIS IS NOT "DELETE EVERYTHING EXCEPT THE DEVICE TABLES"
 *
 * attendance.employee_id references employees ON DELETE CASCADE, so removing the roster would take
 * all 64,857 attendance rows with it — silently, as part of the same statement. raw_punches is
 * SET NULL rather than CASCADE, so the punches would survive but belong to nobody, which is worse
 * than losing them: the rows are still there and every report over them is wrong.
 *
 * The roster IS device data. 163 enrolments were adopted from Easy Time Pro, and biotime_employees
 * points at employees rather than the other way round. So the line this script draws is not
 * "device tables vs app tables" but "records people created IN the app vs everything the device,
 * the roster and the permission system depend on".
 *
 * WHAT IT NEVER TOUCHES
 *   employees, entities, departments, branches, zones, designations
 *   attendance, raw_punches, attendance_recompute_queue, attendance_pre_weekoff_fix
 *   biotime_employees, sync_runs, sync_state, devices, service_commands
 *   profiles, roles, permissions, role_permissions, role_assignments
 *   shifts, employee_shift_assignments, holiday_calendars, holidays, leave_types, org_settings
 *
 * Those are asserted, not assumed: every one is counted before and after, and any change at all
 * rolls the whole thing back. A cascade nobody predicted is exactly the failure this guards.
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

/*
 * Children before parents, so no delete is refused by a foreign key that is not CASCADE.
 * help_requests sits above tasks deliberately: help_requests.task_id references tasks, and the
 * other way round the task delete is refused.
 *
 * notifications and audit_log come LAST on purpose. Triggers write to both as rows disappear, so
 * clearing them first would leave them repopulated by this script's own work.
 */
const TARGETS = [
  'task_checklist_items', 'task_comments', 'task_attachments', 'task_assignees',
  'help_requests', 'tasks',
  'routine_ticks', 'routine_items',
  'asset_assignments', 'assets',
  'messages', 'conversation_members', 'conversations', 'chat_typing', 'chat_preferences',
  'payslip_lines', 'payslips', 'payroll_runs', 'salary_structures', 'pay_components',
  'leave_balances', 'leaves',
  'attendance_status_history', 'attendance_regularizations',
  'department_moves',
  'documents', 'tickets', 'expenses',
  'goals', 'exits', 'onboarding', 'candidates', 'jobs',
  'notifications', 'audit_log',
];

const PROTECTED = [
  'employees', 'entities', 'departments', 'branches', 'zones', 'designations',
  'attendance', 'raw_punches', 'attendance_recompute_queue', 'attendance_pre_weekoff_fix',
  'biotime_employees', 'sync_runs', 'sync_state', 'devices', 'service_commands',
  'profiles', 'roles', 'permissions', 'role_permissions', 'role_assignments',
  'shifts', 'employee_shift_assignments', 'holiday_calendars', 'holidays',
  'leave_types', 'org_settings', 'user_screen_overrides',
];

/*
 * Tables the attendance service writes WHILE this script runs.
 *
 * Not a guess: sync_runs and attendance_recompute_queue both gained rows between two counts taken
 * seconds apart. They are held to "must not shrink" rather than "must not change" below.
 */
const LIVE = new Set([
  'attendance', 'raw_punches', 'attendance_recompute_queue', 'sync_runs', 'sync_state',
  'service_commands', 'attendance_pre_weekoff_fix',
]);

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

function connectionString() {
  const env = loadEnv();
  let url = env.SUPABASE_DB_URL || env.DATABASE_URL || '';
  if (!url) throw new Error('SUPABASE_DB_URL is not set in backend/.env.local');
  if (env.SUPABASE_DB_PASSWORD && url.includes('[YOUR-PASSWORD]')) {
    url = url.replace('[YOUR-PASSWORD]', encodeURIComponent(env.SUPABASE_DB_PASSWORD));
  }
  return url;
}

const exists = async (db, t) => (await db.query(
  `select 1 from information_schema.tables where table_schema='public' and table_name=$1`, [t]
)).rowCount > 0;

const countOf = async (db, t) => (await db.query(`select count(*)::int n from public."${t}"`)).rows[0].n;

async function snapshot(db, tables) {
  const out = {};
  for (const t of tables) if (await exists(db, t)) out[t] = await countOf(db, t);
  return out;
}

async function restore(db, file) {
  const p = path.isAbsolute(file) ? file : path.join(ROOT, file);
  const dump = JSON.parse(fs.readFileSync(p, 'utf8'));
  console.log(`\n  Backup taken ${dump.takenAt}`);
  const present = TARGETS.filter((t) => (dump.rows?.[t] ?? []).length > 0);
  for (const t of present) console.log(`    ${t}: ${dump.rows[t].length} rows`);
  if (!present.length) console.log('    (the backup holds no rows — nothing to put back)');
  if (!APPLY) { console.log('\n  Dry run — re-run with --apply to restore.\n'); return; }

  await db.query('begin');
  try {
    // Parents before children on the way back in: the reverse of the delete order.
    for (const t of [...TARGETS].reverse()) {
      for (const r of dump.rows?.[t] ?? []) {
        const cols = Object.keys(r);
        await db.query(
          `insert into public."${t}" (${cols.map((c) => `"${c}"`).join(',')})
           values (${cols.map((_, i) => `$${i + 1}`).join(',')}) on conflict do nothing`,
          cols.map((c) => (r[c] && typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c]))
        );
      }
    }
    await db.query('commit');
    console.log('\n  Restored.\n');
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}

async function main() {
  const db = new Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
  await db.connect();

  if (RESTORE) { await restore(db, RESTORE); await db.end(); return; }

  const before = await snapshot(db, TARGETS);
  const keepBefore = await snapshot(db, PROTECTED);
  const doomed = Object.entries(before).filter(([, n]) => n > 0);
  const total = doomed.reduce((s, [, n]) => s + n, 0);

  console.log('\n  WILL BE CLEARED');
  console.log('  ' + '-'.repeat(46));
  if (!doomed.length) console.log('    nothing — every target table is already empty');
  for (const [t, n] of doomed) console.log(`    ${t.padEnd(30)} ${String(n).padStart(7)}`);
  const emptyAlready = Object.entries(before).filter(([, n]) => n === 0).length;
  console.log(`\n    ${total} rows across ${doomed.length} tables (${emptyAlready} target tables already empty)`);

  console.log('\n  WILL NOT BE TOUCHED — asserted after the delete, and rolled back if any moves');
  console.log('  ' + '-'.repeat(46));
  for (const [t, n] of Object.entries(keepBefore)) {
    if (n > 0) console.log(`    ${t.padEnd(30)} ${String(n).padStart(7)}`);
  }

  if (!APPLY) {
    console.log('\n  Dry run — nothing was changed. Re-run with --apply.\n');
    await db.end();
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dump = { takenAt: new Date().toISOString(), rows: {} };
  for (const t of TARGETS) if (await exists(db, t)) {
    dump.rows[t] = (await db.query(`select * from public."${t}"`)).rows;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `app-records-before-flush-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(dump, null, 2));
  console.log(`\n  Backed up every row about to be deleted -> ${path.relative(ROOT, file)}`);

  await db.query('begin');
  try {
    let deleted = 0;
    for (const t of TARGETS) {
      if (!(await exists(db, t))) continue;
      const r = await db.query(`delete from public."${t}"`);
      if (r.rowCount) { deleted += r.rowCount; console.log(`    cleared ${t} (${r.rowCount})`); }
    }

    /*
     * The guard.
     *
     * Split in two, because the attendance service is LIVE. sync_runs and the recompute queue gain
     * rows while this transaction is open, and READ COMMITTED means the second count sees them, so
     * strict equality would roll back a perfectly good flush because somebody clocked in.
     *
     * A stray cascade can only ever REMOVE rows. So "did not shrink" is the assertion that actually
     * catches the failure, and it is immune to the sync service working alongside it. Every table
     * the service does not write is still held to exact equality.
     */
    const keepAfter = await snapshot(db, PROTECTED);
    const moved = Object.entries(keepBefore)
      .filter(([t, n]) => (LIVE.has(t) ? keepAfter[t] < n : keepAfter[t] !== n))
      .map(([t, n]) => `${t}: ${n} -> ${keepAfter[t]}${LIVE.has(t) ? '  (SHRANK)' : ''}`);
    if (moved.length) {
      throw new Error(`protected tables changed, refusing to commit:\n      ${moved.join('\n      ')}`);
    }

    await db.query('commit');
    console.log(`\n  Committed. ${deleted} rows deleted.`);
  } catch (err) {
    await db.query('rollback');
    console.error(`\n  ROLLED BACK — nothing changed: ${err.message}`);
    console.error(`  Backup still at ${path.relative(ROOT, file)}\n`);
    await db.end();
    process.exit(1);
  }

  const after = await snapshot(db, PROTECTED);
  console.log('\n  Device and roster data, confirmed intact:');
  for (const t of ['employees', 'attendance', 'raw_punches', 'biotime_employees', 'sync_runs', 'devices']) {
    if (after[t] !== undefined) console.log(`    ${t.padEnd(22)} ${String(after[t]).padStart(7)}`);
  }
  console.log(`\n  Undo:  node scripts/flushAppRecords.js --restore ${path.relative(ROOT, file)} --apply\n`);
  await db.end();
}

main().catch((e) => { console.error('\nFailed:', e.message, '\n'); process.exit(1); });
