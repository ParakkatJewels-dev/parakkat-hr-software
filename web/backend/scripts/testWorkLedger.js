const { readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

// Work Ledger: replays every production migration (0169+ twice, to prove they rerun safely), then
// runs the ledger contract tests in their own disposable database.
module.exports = function testWorkLedger({ run, connection, directory }) {
  const database = 'hr_work_ledger_audit';
  const backend = join(__dirname, '..');
  const migrations = join(backend, 'supabase', 'migrations');
  const bootstrap = join(directory, 'work-ledger-bootstrap.sql');
  const quote = (path) => `'${path.replace(/'/g, "''")}'`;
  writeFileSync(bootstrap, [
    '\\set ON_ERROR_STOP on',
    `\\i ${quote(join(backend, 'tests', 'supabase_fixture.sql'))}`,
    ...readdirSync(migrations).filter(file => file.endsWith('.sql')).sort().flatMap(file => [
      ...(file.startsWith('0062_') ? [
        "insert into public.shifts(code,name,start_time,end_time) values ('GN','Synthetic configured baseline','09:00','17:30');",
      ] : []),
      `\\i ${quote(join(migrations, file))}`,
      ...(Number(file.slice(0, 4)) >= 169 ? [`\\i ${quote(join(migrations, file))}`] : []),
    ]),
    `\\i ${quote(join(backend, 'tests', 'work_ledger.sql'))}`,
  ].join('\n'));
  run('createdb', [...connection, database]);
  const output = run('psql', [...connection, '-d', database, '-q', '-f', bootstrap]);
  console.log(output.split('\n').filter(line => line.includes('PASS:')).join('\n').trim());
};
