// Private-cluster helper. Replays real migrations with pre-upgrade payroll rows; no .env/remote IO.
const { readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

module.exports = function testPayrollIntegrity({ run, connection, directory }) {
  const database = 'hr_payroll_integrity_audit';
  const backend = join(__dirname, '..');
  const migrations = join(backend, 'supabase', 'migrations');
  const test = join(backend, 'tests', 'payroll_output_integrity.sql');
  const quote = (path) => `'${path.replace(/'/g, "''")}'`;
  const bootstrap = join(directory, 'payroll-integrity-bootstrap.sql');
  writeFileSync(bootstrap, [
    '\\set ON_ERROR_STOP on',
    `\\i ${quote(join(backend, 'tests', 'supabase_fixture.sql'))}`,
    ...readdirSync(migrations).filter(file => file.endsWith('.sql')).sort().flatMap(file => [
      ...(file.startsWith('0062_') ? [
        "insert into public.shifts(code,name,start_time,end_time) values ('GN','Synthetic configured baseline','09:00','17:30');",
      ] : []),
      ...(file.startsWith('0143_') ? ['\\set payroll_seed on', `\\i ${quote(test)}`] : []),
      `\\i ${quote(join(migrations, file))}`,
      ...(file.startsWith('0143_') ? [`\\i ${quote(join(migrations, file))}`] : []),
    ]),
    '\\set payroll_seed off',
    `\\i ${quote(test)}`,
  ].join('\n'));
  run('createdb', [...connection, database]);
  const output = run('psql', [...connection, '-d', database, '-Xq', '-f', bootstrap]);
  console.log(output.split('\n').filter(line => line.includes('PASS:')).join('\n').trim());
};
