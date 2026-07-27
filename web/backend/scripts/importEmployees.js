#!/usr/bin/env node
/**
 * Import the staff roster from the four CompanyDetails spreadsheets.
 *
 *   node scripts/importEmployees.js            dry run — prints exactly what it would do
 *   node scripts/importEmployees.js --apply    actually writes
 *
 * Idempotent: re-running only adds what is missing. Matching is on (entity, full_name), because
 * the sheets carry no employee number — see the note on codes below.
 *
 * What it creates, in dependency order:
 *   1. the company, if it does not exist yet
 *   2. branches, from the Branch column of the Branches sheet
 *   3. designations, from the Designation column
 *   4. employees, placed into the above
 *
 * ---------------------------------------------------------------------------------------------
 * ABOUT EMPLOYEE CODES
 *
 * The spreadsheets have no employee number — only a serial within each sheet. Codes are therefore
 * GENERATED here as <ENTITY>-0001. That is fine for HR, but it will NOT match the codes the
 * ZKTeco terminals use, and attendance auto-linking matches on exactly that. Once the attendance
 * service has synced its device roster, either
 *   - update employees.employee_code to the device's number, or
 *   - map each person once in Time & Attendance -> Setup.
 * Nothing here guesses at that mapping: a wrong link silently attributes one person's punches to
 * another, which is worse than no link at all.
 * ---------------------------------------------------------------------------------------------
 */
const path = require('node:path');
const fs = require('node:fs');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const SHEET_DIR = path.join(ROOT, 'CompanyDetails');
const APPLY = process.argv.includes('--apply');

// exceljs lives in the attendance service; no need for a second copy.
const ExcelJS = require(path.join(ROOT, '..', '..', 'services', 'attendance', 'node_modules', 'exceljs'));

/** Which sheet belongs to which company, and what to call it if it does not exist yet. */
const FILES = [
  { match: /PP IMITATIONS/i,       code: 'PPL',  name: 'PP IMMITATIONS' },
  { match: /HEAD OFFICE/i,         code: 'HO90', name: 'HO PARAKKAT' },
  { match: /BRANCHES/i,            code: 'PKT',  name: 'PARAKKAT JEWELS AND PEARLS', hasBranches: true },
  { match: /Jewels Trading/i,      code: 'PJT',  name: 'PARAKKAT JEWELS TRADING' },
];

// Values that appear in the Branch column but are not branches — they are job titles that leaked
// across. Those people simply have no branch.
const NOT_A_BRANCH = /^(REGIONAL MANAGER|ZONAL MANAGER)$/i;

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const titleCase = (s) =>
  s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bC\.k\b/i, 'C.K');

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

/** Pull people out of one workbook. */
async function readSheet(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(SHEET_DIR, file));
  const ws = wb.worksheets[0];

  // The header row is not always row 1 — these sheets carry a title banner above it.
  let header = null;
  for (let r = 1; r <= 8 && !header; r++) {
    ws.getRow(r).eachCell({ includeEmpty: true }, (c) => {
      if (/Employee Name/i.test(clean(c.value))) header = r;
    });
  }
  if (!header) throw new Error(`${file}: could not find the "Employee Name" header row`);

  const people = [];
  for (let r = header + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = clean(row.getCell(3).value);
    if (!name || /^total$/i.test(name)) continue;
    const branch = clean(row.getCell(5).value);
    people.push({
      full_name: titleCase(name),
      designation: clean(row.getCell(4).value) || null,
      branch: branch && !NOT_A_BRANCH.test(branch) ? branch.toUpperCase() : null,
    });
  }
  return people;
}

async function main() {
  const env = loadEnv();
  const db = new Client({ connectionString: env.SUPABASE_DB_URL });
  await db.connect();

  console.log(APPLY ? '\n=== IMPORT (writing) ===\n' : '\n=== DRY RUN — nothing will be written ===\n');
  await db.query('begin');

  const summary = [];

  for (const file of fs.readdirSync(SHEET_DIR).filter((f) => f.endsWith('.xlsx'))) {
    const spec = FILES.find((s) => s.match.test(file));
    if (!spec) { console.log(`  ! no company mapping for ${file} — skipped`); continue; }

    const people = await readSheet(file);

    // ---- company ----------------------------------------------------------------------------
    let ent = (await db.query('select id, code from public.entities where code = $1', [spec.code])).rows[0];
    let createdEntity = false;
    if (!ent) {
      ent = (await db.query(
        'insert into public.entities (code, name) values ($1, $2) returning id, code', [spec.code, spec.name]
      )).rows[0];
      createdEntity = true;
    }

    // ---- branches ---------------------------------------------------------------------------
    const wantBranches = [...new Set(people.map((p) => p.branch).filter(Boolean))].sort();
    const haveBranches = new Map(
      (await db.query('select id, code from public.branches where entity_id = $1', [ent.id]))
        .rows.map((r) => [r.code.toUpperCase(), r.id])
    );
    let newBranches = 0;
    for (const code of wantBranches) {
      if (haveBranches.has(code)) continue;
      const r = await db.query(
        'insert into public.branches (entity_id, code) values ($1, $2) returning id', [ent.id, code]
      );
      haveBranches.set(code, r.rows[0].id); newBranches++;
    }

    // ---- designations -----------------------------------------------------------------------
    const wantTitles = [...new Set(people.map((p) => p.designation).filter(Boolean))].sort();
    const haveTitles = new Map(
      (await db.query('select id, title from public.designations where entity_id = $1', [ent.id]))
        .rows.map((r) => [r.title.toUpperCase(), r.id])
    );
    let newTitles = 0;
    for (const title of wantTitles) {
      if (haveTitles.has(title.toUpperCase())) continue;
      const r = await db.query(
        'insert into public.designations (entity_id, title) values ($1, $2) returning id', [ent.id, title]
      );
      haveTitles.set(title.toUpperCase(), r.rows[0].id); newTitles++;
    }

    // ---- employees --------------------------------------------------------------------------
    const existing = new Set(
      (await db.query('select lower(full_name) n from public.employees where entity_id = $1', [ent.id]))
        .rows.map((r) => r.n)
    );
    const nextSeq = (await db.query(
      `select coalesce(max(substring(employee_code from '[0-9]+$')::int), 0) m
         from public.employees where entity_id = $1 and employee_code like $2`,
      [ent.id, `${ent.code}-%`]
    )).rows[0].m;

    let seq = Number(nextSeq);
    let added = 0, skipped = 0;
    for (const p of people) {
      if (existing.has(p.full_name.toLowerCase())) { skipped++; continue; }
      seq += 1;
      await db.query(
        `insert into public.employees
           (entity_id, branch_id, designation_id, employee_code, full_name, status)
         values ($1, $2, $3, $4, $5, 'Active')`,
        [
          ent.id,
          p.branch ? haveBranches.get(p.branch) ?? null : null,
          p.designation ? haveTitles.get(p.designation.toUpperCase()) ?? null : null,
          `${ent.code}-${String(seq).padStart(4, '0')}`,
          p.full_name,
        ]
      );
      existing.add(p.full_name.toLowerCase()); added++;
    }

    summary.push({ company: spec.code, createdEntity, newBranches, newTitles, added, skipped, total: people.length });
  }

  console.table(summary);

  if (APPLY) {
    await db.query('commit');
    const n = (await db.query('select count(*)::int c from public.employees')).rows[0].c;
    console.log(`\n  Committed. public.employees now holds ${n} people.\n`);
  } else {
    await db.query('rollback');
    console.log('\n  Dry run — rolled back. Re-run with --apply to write.\n');
  }
  await db.end();
}

main().catch((e) => { console.error('\nImport failed:', e.message, '\n'); process.exit(1); });
