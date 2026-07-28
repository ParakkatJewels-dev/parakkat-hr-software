#!/usr/bin/env node
/**
 * Bring the department list in line with Easy Time Pro, and tidy the branches HR never filled in.
 *
 *   node scripts/syncOrgFromDevice.js                     dry run
 *   node scripts/syncOrgFromDevice.js --apply
 *   node scripts/syncOrgFromDevice.js --branches --apply  also drop empty/unnamed branches
 *
 * WHAT EASY TIME PRO CAN AND CANNOT GIVE YOU
 *
 * Departments: yes. It has 18 real ones and they describe the factory accurately — SMITH UNIT,
 * CUTTING & SEALING, TYING & PACKING, RAW SECTION. HR is missing five of them and carries nine
 * placeholders (Accounts, Sales, Production, Cleaning, Creative, Customer Support) that have never
 * had a single employee and do not exist on any terminal.
 *
 * Branches: no. Not "incomplete" — absent. An enrolment carries area, department and office_tel
 * and nothing else organisational; there is no branch, site, location or region field anywhere in
 * the payload. There is one area, "parakkat", holding all 163 people, served by one terminal. So
 * there is no branch list to import, and this script does not invent one. What it can do, with
 * --branches, is remove the branches in HR that are empty AND unnamed AND therefore unusable.
 *
 * Companies: no, and it would not be safe to try. Easy Time Pro has that same single area, while
 * PPL, PKT, HO90 and PJT are four separate registered companies that file their own returns.
 * employees.entity_id is NOT NULL, so deleting them would mean inventing one company called
 * "parakkat" and filing all 163 people under it — collapsing the top level of every permission
 * scope in the system. That is a business decision with tax consequences, not a data sync, so this
 * script refuses to touch entities at all.
 */
const path = require('node:path');
const fs = require('node:fs');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const DO_BRANCHES = process.argv.includes('--branches');
const BACKUP_DIR = path.join(ROOT, 'backups');

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

/** Only two device department names identify a company outright. */
function entityFor(dept) {
  const d = String(dept || '').toUpperCase();
  if (d.includes('PP IMITATION')) return 'PPL';
  if (d.includes('PEARL')) return 'PKT';
  return 'HO90';
}

async function main() {
  const db = new Client({ connectionString: loadEnv().SUPABASE_DB_URL });
  await db.connect();

  const { rows: entities } = await db.query('select id, code from public.entities');
  const entityId = Object.fromEntries(entities.map((e) => [e.code, e.id]));

  // 'Department' is BioTime's placeholder for "not set", not a department.
  const { rows: deviceDepts } = await db.query(`
    select department_name as name, count(*)::int as people
      from public.biotime_employees
     where department_name is not null and department_name <> 'Department'
     group by 1 order by 2 desc
  `);

  const { rows: hrDepts } = await db.query(`
    select d.id, d.name, d.entity_id, en.code as entity,
           (select count(*)::int from public.employees e where e.department_id = d.id) as people
      from public.departments d
      left join public.entities en on en.id = d.entity_id
     order by d.name
  `);

  const hrByName = new Map(hrDepts.map((d) => [d.name.toUpperCase(), d]));
  const deviceNames = new Set(deviceDepts.map((d) => d.name.toUpperCase()));

  const toAdd = deviceDepts.filter((d) => !hrByName.has(d.name.toUpperCase()));
  // Only ever remove what is both unused and unknown to the terminals. A department with even one
  // employee stays, whatever the device thinks.
  const toRemove = hrDepts.filter((d) => d.people === 0 && !deviceNames.has(d.name.toUpperCase()));

  console.log(`\n  DEPARTMENTS — Easy Time Pro has ${deviceDepts.length}, HR has ${hrDepts.length}\n`);

  console.log(`  ADD ${toAdd.length} that exist on the terminals but not in HR:`);
  toAdd.forEach((d) => console.log(`    ${d.name.padEnd(26)} -> ${entityFor(d.name).padEnd(6)} (${d.people} people on the device)`));
  if (!toAdd.length) console.log('    (none)');

  console.log(`\n  REMOVE ${toRemove.length} that have no employees and are on no terminal:`);
  toRemove.forEach((d) => console.log(`    ${d.name.padEnd(26)} [${d.entity}]`));
  if (!toRemove.length) console.log('    (none)');

  const keeping = hrDepts.filter((d) => !toRemove.includes(d));
  console.log(`\n  KEEP ${keeping.length} (${keeping.filter((d) => d.people > 0).length} of them in use)`);

  // --- branches ------------------------------------------------------------------------------
  const { rows: branches } = await db.query(`
    select b.id, b.code, b.name, en.code as entity,
           (select count(*)::int from public.employees e where e.branch_id = b.id) as people
      from public.branches b left join public.entities en on en.id = b.entity_id
     order by b.code
  `);
  const deadBranches = branches.filter((b) => b.people === 0 && !b.name);

  console.log(`\n  BRANCHES — Easy Time Pro has none to import.`);
  console.log(`    it records one area, "parakkat", holding everybody, served by one terminal;`);
  console.log(`    an enrolment has no branch/site/location field at all.`);
  console.log(`    HR has ${branches.length} branches, ${branches.filter((b) => b.people === 0).length} with nobody in them,`);
  console.log(`    ${branches.filter((b) => !b.name).length} with no name.`);
  if (DO_BRANCHES) {
    console.log(`\n    --branches given: would remove ${deadBranches.length} that are BOTH empty AND unnamed:`);
    console.log('      ' + (deadBranches.map((b) => `${b.code}[${b.entity}]`).join(', ') || '(none)'));
    console.log(`    keeping ${branches.length - deadBranches.length}, including every branch with a name or a person.`);
  } else {
    console.log(`    (pass --branches to remove the ${deadBranches.length} that are both empty and unnamed)`);
  }

  console.log('\n  COMPANIES — not touched, and not importable.');
  console.log('    PPL, PKT, HO90 and PJT are four registered companies; the device knows one area.');
  console.log('    employees.entity_id is mandatory, so removing them would mean filing all 163');
  console.log('    people under a single invented company and collapsing every permission scope.\n');

  if (!APPLY) {
    console.log('  Dry run — nothing changed. Re-run with --apply.\n');
    await db.end();
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `org-before-device-sync-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), departments: hrDepts, branches }, null, 2));
  console.log(`  Backed up departments and branches -> ${path.relative(ROOT, file)}`);

  await db.query('begin');
  try {
    let added = 0, removed = 0, branchesRemoved = 0;

    for (const d of toAdd) {
      const ent = entityFor(d.name);
      if (!entityId[ent]) continue;
      await db.query(
        'insert into public.departments (entity_id, name, is_active) values ($1, $2, true)',
        [entityId[ent], d.name]
      );
      added += 1;
    }

    for (const d of toRemove) {
      await db.query('delete from public.departments where id = $1', [d.id]);
      removed += 1;
    }

    if (DO_BRANCHES) {
      for (const b of deadBranches) {
        await db.query('delete from public.branches where id = $1', [b.id]);
        branchesRemoved += 1;
      }
    }

    await db.query('commit');
    console.log(`\n  Added ${added} departments, removed ${removed}.`);
    if (DO_BRANCHES) console.log(`  Removed ${branchesRemoved} empty unnamed branches.`);
  } catch (err) {
    await db.query('rollback');
    console.error(`\n  Failed and rolled back: ${err.message}\n`);
    await db.end();
    process.exit(1);
  }

  const after = await db.query(`
    select (select count(*) from public.departments)::int depts,
           (select count(*) from public.branches)::int branches,
           (select count(*) from public.entities)::int entities
  `);
  const a = after.rows[0];
  console.log(`  Now: ${a.entities} companies, ${a.branches} branches, ${a.depts} departments.\n`);
  await db.end();
}

main().catch((e) => { console.error('\nFailed:', e.message, '\n'); process.exit(1); });
