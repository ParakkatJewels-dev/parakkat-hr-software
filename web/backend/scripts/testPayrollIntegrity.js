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
      // Verify the historical contract before the stricter register workflow is installed.
      // Its sparse-attendance fixtures deliberately exercise the old calendar fallback.
      ...(file.startsWith('0158_') ? ['\\set payroll_seed off', `\\i ${quote(test)}`] : []),
      `\\i ${quote(join(migrations, file))}`,
      ...(/^(0143|0158|0159)_/.test(file) ? [`\\i ${quote(join(migrations, file))}`] : []),
    ]),
    `\\i ${quote(join(backend, 'tests', 'payroll_salary_register.sql'))}`,
    `\\i ${quote(join(backend, 'tests', 'payroll_bulk_monthly_inputs.sql'))}`,
  ].join('\n'));
  run('createdb', [...connection, database]);
  const output = run('psql', [...connection, '-d', database, '-Xq', '-f', bootstrap]);
  console.log(output.split('\n').filter(line => line.includes('PASS:')).join('\n').trim());
  console.log(run(process.execPath, [join(__dirname, 'testPayrollConcurrency.js'), connection[1]]).trim());
};
