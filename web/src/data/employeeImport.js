// Bulk employee import — parsing and writing.
//
// Kept out of the component so the parsing rules are testable and the UI stays about the UI.
//
// The real spreadsheets are not clean exports: they carry a company banner above the header, the
// header is not on row 1, columns differ per file (only the Branches sheet has a Branch column),
// and there are no employee numbers at all. So this sniffs the header row rather than assuming
// one, matches columns by what they are called, and generates codes where none exist.
import { supabase } from '../lib/supabaseClient';

/** Column aliases, in the order we prefer them. Matching is loose — these are human-typed files. */
const FIELD_ALIASES = {
  full_name: ['employee name', 'name', 'staff name', 'full name'],
  employee_code: ['employee code', 'emp code', 'code', 'employee id', 'emp id', 'staff id'],
  designation: ['designation', 'title', 'job title', 'role'],
  branch: ['branch', 'location', 'shop', 'outlet'],
  department: ['department', 'dept'],
  email: ['email', 'e-mail', 'email id'],
  phone: ['phone', 'mobile', 'contact', 'phone number'],
  join_date: ['join date', 'date of joining', 'doj', 'joined'],
  // Statutory and banking (migration 0047). These are what a second, follow-up spreadsheet
  // usually carries — HR collects bank details after the roster exists.
  pan: ['pan', 'pan no', 'pan number', 'pan card'],
  aadhaar: ['aadhaar', 'aadhar', 'aadhaar no', 'aadhar number', 'uid'],
  uan: ['uan', 'uan no', 'uan number', 'pf uan'],
  esi_number: ['esi', 'esi no', 'esi number', 'esic'],
  bank_account: ['bank account', 'account no', 'account number', 'a/c no', 'ac no', 'bank a/c'],
  bank_ifsc: ['ifsc', 'ifsc code', 'ifs code'],
  bank_name: ['bank', 'bank name'],
  date_of_birth: ['date of birth', 'dob', 'birth date', 'birthday'],
  gender: ['gender', 'sex'],
};

/** Fields that may be filled in on an EXISTING person rather than only on a new one. */
const UPDATABLE = [
  'pan', 'aadhaar', 'uan', 'esi_number',
  'bank_account', 'bank_ifsc', 'bank_name',
  'date_of_birth', 'gender', 'email', 'phone', 'join_date',
];

const PRETTY = { pan: 'PAN', uan: 'UAN', esi_number: 'ESI', bank_account: 'bank account',
  bank_ifsc: 'IFSC', bank_name: 'bank', date_of_birth: 'date of birth', aadhaar: 'Aadhaar' };
const prettyField = (f) => PRETTY[f] ?? f.replace(/_/g, ' ');

const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const key = (v) => norm(v).toLowerCase().replace(/[^a-z0-9 ]/g, '');

/** Values that turn up in a Branch column but are job titles, not places. */
const NOT_A_BRANCH = /^(regional manager|zonal manager|head office|ho)$/i;

/**
 * Find the header row and map its columns onto our fields.
 * Returns { headerRow, columns: { field -> colIndex }, headers: string[] }.
 */
export function detectLayout(rows) {
  let best = { score: 0, row: 0, columns: {} };

  // Only the first handful of rows are plausible headers; below that it is data.
  for (let r = 0; r < Math.min(rows.length, 12); r++) {
    const cells = rows[r] ?? [];
    const columns = {};
    let score = 0;
    cells.forEach((cell, i) => {
      const k = key(cell);
      if (!k) return;
      for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
        if (columns[field] !== undefined) continue;
        if (aliases.some((a) => k === a || k.startsWith(a))) {
          columns[field] = i;
          score += field === 'full_name' ? 3 : 1; // a name column is what makes it a roster
          break;
        }
      }
    });
    if (score > best.score) best = { score, row: r, columns };
  }

  return {
    headerRow: best.row,
    columns: best.columns,
    headers: (rows[best.row] ?? []).map(norm),
    usable: best.columns.full_name !== undefined,
  };
}

/** Turn raw sheet rows into people, using a column map. */
export function extractPeople(rows, layout) {
  const { headerRow, columns } = layout;
  const out = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const full_name = norm(row[columns.full_name]);
    // Skip blanks and the "Total" line these sheets often end with.
    if (!full_name || /^total\b/i.test(full_name)) continue;

    const branchRaw = columns.branch !== undefined ? norm(row[columns.branch]) : '';
    out.push({
      full_name,
      employee_code: columns.employee_code !== undefined ? norm(row[columns.employee_code]) : '',
      designation: columns.designation !== undefined ? norm(row[columns.designation]) : '',
      branch: branchRaw && !NOT_A_BRANCH.test(branchRaw) ? branchRaw.toUpperCase() : '',
      department: columns.department !== undefined ? norm(row[columns.department]) : '',
      email: columns.email !== undefined ? norm(row[columns.email]).toLowerCase() : '',
      phone: columns.phone !== undefined ? norm(row[columns.phone]) : '',
      join_date: columns.join_date !== undefined ? toIsoDate(row[columns.join_date]) : null,
      pan: columns.pan !== undefined ? norm(row[columns.pan]).toUpperCase() : '',
      aadhaar: columns.aadhaar !== undefined ? norm(row[columns.aadhaar]).replace(/\D/g, '') : '',
      uan: columns.uan !== undefined ? norm(row[columns.uan]).replace(/\D/g, '') : '',
      esi_number: columns.esi_number !== undefined ? norm(row[columns.esi_number]) : '',
      bank_account: columns.bank_account !== undefined ? norm(row[columns.bank_account]).replace(/\s/g, '') : '',
      bank_ifsc: columns.bank_ifsc !== undefined ? norm(row[columns.bank_ifsc]).toUpperCase().replace(/\s/g, '') : '',
      bank_name: columns.bank_name !== undefined ? norm(row[columns.bank_name]) : '',
      date_of_birth: columns.date_of_birth !== undefined ? toIsoDate(row[columns.date_of_birth]) : null,
      gender: columns.gender !== undefined ? normGender(row[columns.gender]) : '',
      _row: r + 1, // 1-based, for error messages that match what the user sees in Excel
    });
  }
  return out;
}

/** 'M', 'male', 'MALE' all mean the same thing to a person filling in a sheet. */
function normGender(v) {
  const g = norm(v).toLowerCase();
  if (!g) return '';
  if (g.startsWith('m')) return 'Male';
  if (g.startsWith('f') || g.startsWith('w')) return 'Female';
  return 'Other';
}

function toIsoDate(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = norm(v);
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/); // dd/mm/yyyy, as used locally
  if (dmy) {
    const [, d, m, y] = dmy;
    const yr = y.length === 2 ? `20${y}` : y;
    return `${yr}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * Compare the parsed people against what is already in this company.
 * Nothing is written — this is what the preview shows.
 */
export function planImport(people, { existingByName, existingByCode, branches, designations }) {
  const seen = new Set();
  const rows = people.map((p) => {
    const nameKey = p.full_name.toLowerCase();
    const codeKey = p.employee_code.toLowerCase();
    // An existing person is matched by code first (unambiguous), then by name.
    const match = (codeKey && existingByCode.get(codeKey)) || existingByName.get(nameKey) || null;

    let status = 'new';
    let note = '';
    let updates = {};

    if (seen.has(nameKey)) {
      status = 'duplicate'; note = 'appears twice in this file';
    } else if (match) {
      // Already here — so the useful question is whether this row FILLS ANYTHING IN. Only blanks
      // are filled: a spreadsheet should never silently overwrite a value somebody typed into the
      // app, which is the difference between a helpful import and a destructive one.
      for (const f of UPDATABLE) {
        const incoming = p[f];
        if (incoming === '' || incoming == null) continue;
        // Unknown is not blank. The roster this plan compares against is the LIST select, which
        // no longer carries the statutory and banking columns — for those, `match[f]` is not a
        // null value but a missing key. Treating that as "blank, fill it in" silently overwrote
        // PAN, Aadhaar and bank details the database already held, while the preview promised it
        // was only filling gaps. A column we did not fetch is a column we may not judge.
        if (!(f in match)) continue;
        const current = match[f];
        if (current === null || current === '') updates[f] = incoming;
      }
      const n = Object.keys(updates).length;
      status = n ? 'update' : 'skip';
      note = n ? `fills in ${Object.keys(updates).map(prettyField).join(', ')}` : 'already complete';
    }
    seen.add(nameKey);

    return {
      ...p,
      status,
      note,
      updates,
      matchId: match?.id ?? null,
      newBranch: Boolean(p.branch) && !branches.has(p.branch.toUpperCase()),
      newDesignation: Boolean(p.designation) && !designations.has(p.designation.toUpperCase()),
    };
  });

  return {
    rows,
    counts: {
      total: rows.length,
      create: rows.filter((r) => r.status === 'new').length,
      update: rows.filter((r) => r.status === 'update').length,
      skip: rows.filter((r) => r.status === 'skip').length,
      duplicate: rows.filter((r) => r.status === 'duplicate').length,
      newBranches: new Set(rows.filter((r) => r.newBranch).map((r) => r.branch)).size,
      newDesignations: new Set(rows.filter((r) => r.newDesignation).map((r) => r.designation)).size,
    },
  };
}

/**
 * Write the plan. Creates missing branches and designations first, then the people.
 * `onProgress(done, total)` is called as it goes — 242 inserts is not instant.
 */
/**
 * @param createOrg  May this caller create branches and designations the sheet names but the
 *   company lacks? Both inserts need org.manage, which hr_manager does not hold — and the run
 *   used to attempt them regardless, dying on a raw RLS error midway with the update phase
 *   already written. Without the permission the run now skips creation: those people are still
 *   imported, placed nowhere, and the preview says so before anything is written.
 */
export async function runImport({ entityId, entityCode, rows, onProgress, createOrg = true }) {
  const todo = rows.filter((r) => r.status === 'new');
  const edits = rows.filter((r) => r.status === 'update' && r.matchId);
  if (!todo.length && !edits.length) return { created: 0, updated: 0, branches: 0, designations: 0 };

  // ---- fill in existing people first ----------------------------------------------------------
  // Done before any inserts so that if the run fails half way, what completed is the harmless
  // half: filling blanks on people who already exist, not partially created records.
  let updated = 0;
  for (const r of edits) {
    const { error } = await supabase.from('employees').update(r.updates).eq('id', r.matchId);
    if (error) {
      throw new Error(
        `Updating ${r.full_name} (row ${r._row}) failed: ${error.message}. ` +
        `${updated} people were updated before this; nothing was created yet.`
      );
    }
    updated += 1;
    onProgress?.(updated, edits.length + todo.length);
  }

  if (!todo.length) return { created: 0, updated, branches: 0, designations: 0 };

  // ---- branches -----------------------------------------------------------------------------
  const { data: haveBranches } = await supabase
    .from('branches').select('id, code').eq('entity_id', entityId);
  const branchByCode = new Map((haveBranches ?? []).map((b) => [b.code.toUpperCase(), b.id]));

  const missingBranches = [...new Set(todo.map((r) => r.branch).filter((b) => b && !branchByCode.has(b)))];
  if (createOrg && missingBranches.length) {
    const { data, error } = await supabase.from('branches')
      .insert(missingBranches.map((code) => ({ entity_id: entityId, code }))).select('id, code');
    if (error) throw new Error(`Could not create branches: ${error.message}`);
    (data ?? []).forEach((b) => branchByCode.set(b.code.toUpperCase(), b.id));
  }

  // ---- designations -------------------------------------------------------------------------
  const { data: haveTitles } = await supabase
    .from('designations').select('id, title').eq('entity_id', entityId);
  const titleByName = new Map((haveTitles ?? []).map((d) => [d.title.toUpperCase(), d.id]));

  const missingTitles = [...new Set(todo.map((r) => r.designation).filter((t) => t && !titleByName.has(t.toUpperCase())))];
  if (createOrg && missingTitles.length) {
    const { data, error } = await supabase.from('designations')
      .insert(missingTitles.map((title) => ({ entity_id: entityId, title }))).select('id, title');
    if (error) throw new Error(`Could not create designations: ${error.message}`);
    (data ?? []).forEach((d) => titleByName.set(d.title.toUpperCase(), d.id));
  }

  // ---- employees ----------------------------------------------------------------------------
  // Codes are generated only where the sheet has none, continuing from the highest already used
  // so a second import does not collide with the first.
  const { data: coded } = await supabase
    .from('employees').select('employee_code').eq('entity_id', entityId).like('employee_code', `${entityCode}-%`);
  let seq = (coded ?? []).reduce((max, r) => {
    const n = parseInt(String(r.employee_code).split('-').pop(), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);

  const payload = todo.map((r) => ({
    entity_id: entityId,
    branch_id: r.branch ? branchByCode.get(r.branch.toUpperCase()) ?? null : null,
    designation_id: r.designation ? titleByName.get(r.designation.toUpperCase()) ?? null : null,
    employee_code: r.employee_code || `${entityCode}-${String(++seq).padStart(4, '0')}`,
    full_name: r.full_name,
    email: r.email || null,
    phone: r.phone || null,
    join_date: r.join_date || null,
    status: 'Active',
  }));

  // Chunked so one oversized request cannot time out, and so progress means something.
  const CHUNK = 50;
  let created = 0;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const slice = payload.slice(i, i + CHUNK);
    const { error } = await supabase.from('employees').insert(slice);
    if (error) {
      throw new Error(
        `Created ${created} of ${payload.length} before failing on row ${todo[i]?._row}: ${error.message}. ` +
        `Those already created are saved — re-run the same file and they will be recognised.`
      );
    }
    created += slice.length;
    onProgress?.(updated + created, edits.length + payload.length);
  }

  return { created, updated, branches: missingBranches.length, designations: missingTitles.length };
}
