// Exercise hosted-style object ownership in a disposable local database; never loads .env.
const { readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

module.exports = function testMigrationOwnership({ run, connection, directory }) {
  const database = 'hr_migration_ownership_audit';
  const backend = join(__dirname, '..');
  const migrations = join(backend, 'supabase', 'migrations');
  const quote = (path) => `'${path.replace(/'/g, "''")}'`;
  const migration = join(migrations, '0144_immediate_account_revocation.sql');
  const bootstrap = join(directory, 'migration-ownership-bootstrap.sql');
  writeFileSync(bootstrap, [
    '\\set ON_ERROR_STOP on',
    'set client_min_messages=warning;',
    `\\i ${quote(join(backend, 'tests', 'supabase_fixture.sql'))}`,
    ...readdirSync(migrations).filter(file => file.endsWith('.sql') && file < '0144_').sort().flatMap(file => [
      ...(file.startsWith('0062_') ? [
        "insert into public.shifts(code,name,start_time,end_time) values ('GN','Synthetic configured baseline','09:00','17:30');",
      ] : []),
      `\\i ${quote(join(migrations, file))}`,
    ]),
    `\\i ${quote(join(backend, 'tests', 'migration_ownership_fixture.sql'))}`,
    'set role hr_migration_test_owner;',
    `\\i ${quote(migration)}`,
    `\\i ${quote(migration)}`,
    'reset role;',
    `\\i ${quote(join(backend, 'tests', 'migration_ownership.sql'))}`,
  ].join('\n'));
  run('createdb', [...connection, database]);
  const output = run('psql', [...connection, '-d', database, '-Xq', '-f', bootstrap]);
  console.log(output.split('\n').filter(line => line.includes('PASS:')).join('\n').trim());

  // An application table with broken ownership must fail visibly. Silently skipping tables
  // the migration cannot modify would leave authenticated accounts with a revocation bypass.
  const negative = join(directory, 'migration-ownership-denied.sql');
  writeFileSync(negative, [
    '\\set ON_ERROR_STOP on',
    'set role hr_migration_test_owner;',
    `\\i ${quote(migration)}`,
  ].join('\n'));
  let denied = false;
  try {
    run('psql', [...connection, '-d', database, '-Xq', '-f', negative]);
  } catch (error) {
    if (!error.message.includes('must be owner of table ownership_foreign_hr_table')) throw error;
    denied = true;
  }
  if (!denied) throw new Error('Migration silently accepted an unprotected foreign-owned HR table');
  run('psql', [...connection, '-d', database, '-Xq', '-v', 'ON_ERROR_STOP=1', '-c', `
    do $$ begin
      assert not exists(select 1 from pg_policy where polrelid='public.ownership_foreign_hr_table'::regclass
        and polname='active_account_required'),'failed migration must not commit a partial guard';
      assert exists(select 1 from pg_policy where polrelid='storage.objects'::regclass
        and polname='active_account_required' and not polpermissive),'prior successful guard survives failed rerun';
    end $$;
  `]);
  console.log('PASS: foreign-owned HR tables cause a visible migration failure; failed rerun preserves installed protection');
};
