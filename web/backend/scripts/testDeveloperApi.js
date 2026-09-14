const { readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

module.exports = function testDeveloperApi({ run, connection, directory }) {
  const database = 'hr_developer_api_audit';
  const backend = join(__dirname, '..');
  const migrations = join(backend, 'supabase', 'migrations');
  const bootstrap = join(directory, 'developer-api-bootstrap.sql');
  const quote = (path) => `'${path.replace(/'/g, "''")}'`;
  writeFileSync(bootstrap, [
    '\\set ON_ERROR_STOP on',
    `\\i ${quote(join(backend, 'tests', 'supabase_fixture.sql'))}`,
    ...readdirSync(migrations).filter(file => file.endsWith('.sql')).sort().flatMap(file => [
      ...(file.startsWith('0062_') ? [
        "insert into public.shifts(code,name,start_time,end_time) values ('GN','Synthetic configured baseline','09:00','17:30');",
      ] : []),
      `\\i ${quote(join(migrations, file))}`,
      ...(file.startsWith('0135_') ? [`\\i ${quote(join(migrations, file))}`] : []),
    ]),
    `\\i ${quote(join(backend, 'tests', 'developer_api.sql'))}`,
  ].join('\n'));
  run('createdb', [...connection, database]);
  const output = run('psql', [...connection, '-d', database, '-q', '-f', bootstrap]);
  console.log(output.split('\n').filter(line => line.includes('PASS:')).join('\n').trim());
};
