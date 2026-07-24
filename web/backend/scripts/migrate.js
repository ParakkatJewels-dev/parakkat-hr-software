// backend/scripts/migrate.js
//
// Applies every backend/supabase/migrations/*.sql to the HOSTED Supabase Postgres,
// in filename order, each file exactly once, inside its own transaction.
// No Supabase CLI required — connects directly with node-postgres.
//
//   npm run migrate                 apply pending migrations
//   npm run migrate -- --baseline   mark ALL current files as applied WITHOUT running
//                                   them (use when the schema was already created by
//                                   hand in the dashboard, so the tracker starts in sync)
//
// Set SUPABASE_DB_URL in backend/.env.local to the project's **Session pooler** URI
// (Dashboard -> Connect -> Session pooler). Session mode (port 5432) is required
// because each migration runs in an explicit BEGIN/COMMIT spanning several statements.

const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');

const BACKEND_DIR = join(__dirname, '..');
const MIGRATIONS_DIR = join(BACKEND_DIR, 'supabase', 'migrations');
const ENV_PATH = join(BACKEND_DIR, '.env.local');
const BASELINE = process.argv.includes('--baseline');

// Minimal .env parser so the only dependency is `pg` (no dotenv).
function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

function resolveConnectionString() {
  const fileEnv = loadEnvFile(ENV_PATH);
  const get = (k) => process.env[k] || fileEnv[k] || '';

  let url = get('SUPABASE_DB_URL') || get('DATABASE_URL');
  if (!url) return '';

  // Convenience: paste the dashboard URI verbatim (it keeps a password placeholder) and put
  // the raw password in SUPABASE_DB_PASSWORD — we URL-encode it so special chars can't break
  // the connection string.
  const placeholder = /\[YOUR-PASSWORD\]|<db-password>|\[db-password\]/i;
  if (placeholder.test(url)) {
    const password = get('SUPABASE_DB_PASSWORD');
    if (!password) {
      console.error(
        '\nx  SUPABASE_DB_URL still contains a password placeholder.\n' +
          '   Either replace it with the real password, or set SUPABASE_DB_PASSWORD in .env.local.\n'
      );
      process.exit(1);
    }
    url = url.replace(placeholder, encodeURIComponent(password));
  }
  return url;
}

function missingConnMessage() {
  return [
    '',
    'x  No database connection string found.',
    '',
    '   Add this to backend/.env.local (Supabase dashboard -> Connect -> "Session pooler"):',
    '',
    '     SUPABASE_DB_URL=postgresql://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres',
    '',
    '   Use the SESSION pooler (port 5432), not the transaction pooler (6543): each migration',
    '   runs inside its own BEGIN/COMMIT. The <db-password> is the database password',
    '   (Settings -> Database), NOT the service_role key.',
    '',
  ].join('\n');
}

async function main() {
  const connectionString = resolveConnectionString();
  if (!connectionString) {
    console.error(missingConnMessage());
    process.exit(1);
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    console.log('No .sql files in supabase/migrations/. Nothing to do.');
    return;
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }, // Supabase requires TLS; pooler chain isn't in Node's store
  });

  try {
    await client.connect();
  } catch (err) {
    console.error(`\nx  Could not connect to the database:\n   ${err.message}\n`);
    console.error('   Check SUPABASE_DB_URL (host, password, and port 5432 session pooler).\n');
    process.exit(1);
  }

  try {
    // Tracker lives in a private schema (not `public`, so it is never exposed via PostgREST).
    await client.query('create schema if not exists _migrations');
    await client.query(`
      create table if not exists _migrations.applied (
        version    text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const { rows } = await client.query('select version from _migrations.applied');
    const applied = new Set(rows.map((r) => r.version));

    if (BASELINE) {
      const pending = files.filter((f) => !applied.has(f));
      for (const file of pending) {
        await client.query('insert into _migrations.applied (version) values ($1)', [file]);
        console.log(`[baseline] ${file}`);
      }
      console.log(
        pending.length
          ? `\nMarked ${pending.length} file(s) as applied (not executed).`
          : '\nNothing to baseline — tracker already lists every file.'
      );
      return;
    }

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[skip]  ${file}`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`[apply] ${file} ... `);
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into _migrations.applied (version) values ($1)', [file]);
        await client.query('commit');
        console.log('ok');
        ran += 1;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        console.log('FAILED');
        console.error(`\nx  ${file} failed and was rolled back:\n   ${err.message}\n`);
        if (/already exists/i.test(err.message)) {
          console.error(
            '   This object already exists — the schema was likely created by hand already.\n' +
              '   If the DB is already up to date, run:  npm run migrate -- --baseline\n'
          );
        } else {
          console.error('   Fix the migration or DB state, then re-run `npm run migrate`.\n');
        }
        process.exitCode = 1;
        return;
      }
    }
    console.log(ran ? `\nDone. Applied ${ran} migration(s).` : '\nDatabase already up to date.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\nx  Unexpected error:', err.message);
  process.exit(1);
});
