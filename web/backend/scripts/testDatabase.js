// Starts a new private cluster for contract tests. Never reads .env or a connection URL.
const { mkdtempSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const directory = mkdtempSync(join(tmpdir(), 'hr-database-audit-'));
const data = join(directory, 'data');
let started = false;
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  run('initdb', ['-D', data, '-A', 'trust', '-U', 'audit_owner', '--no-locale']);
  // A private UNIX socket removes port collisions and excludes all TCP clients.
  run('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-c listen_addresses='' -k '${directory}'`, '-w', 'start']);
  started = true;
  for (const [database, filename] of [
    ['hr_account_audit', 'user_account_integrity.sql'],
    ['hr_workflow_audit', 'workflow_integrity.sql'],
  ]) {
    const connection = ['-h', directory, '-U', 'audit_owner'];
    run('createdb', [...connection, database]);
    const output = run('psql', [...connection, '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', join(__dirname, '..', 'tests', filename)]);
    console.log(output.split('\n').filter(line => line.includes('PASS:')).join('\n').trim());
  }
  // Seed a real legacy conversation immediately before the request migration, then assert the
  // upgrade and API boundaries after replaying the same migration history used in production.
  const messageDatabase = 'hr_message_requests_audit';
  const connection = ['-h', directory, '-U', 'audit_owner'];
  const backend = join(__dirname, '..');
  const migrations = join(backend, 'supabase', 'migrations');
  const messageTests = join(backend, 'tests', 'message_requests.sql');
  const quote = (path) => `'${path.replace(/'/g, "''")}'`;
  const messageBootstrap = join(directory, 'message-requests-bootstrap.sql');
  writeFileSync(messageBootstrap, [
    '\\set ON_ERROR_STOP on',
    `\\i ${quote(join(backend, 'tests', 'supabase_fixture.sql'))}`,
    ...readdirSync(migrations).filter(file => file.endsWith('.sql')).sort().flatMap(file => [
      ...(file.startsWith('0062_') ? [
        "insert into public.shifts(code,name,start_time,end_time) values ('GN','Synthetic configured baseline','09:00','17:30');",
      ] : []),
      ...(file.startsWith('0129_') ? ['\\set message_requests_seed on', `\\i ${quote(messageTests)}`] : []),
      `\\i ${quote(join(migrations, file))}`,
      // This migration promises safe reruns; enforce that before running API assertions.
      ...(file.startsWith('0129_') ? [`\\i ${quote(join(migrations, file))}`] : []),
    ]),
    '\\set message_requests_seed off',
    `\\i ${quote(messageTests)}`,
  ].join('\n'));
  run('createdb', [...connection, messageDatabase]);
  const messageOutput = run('psql', [...connection, '-d', messageDatabase, '-q', '-f', messageBootstrap]);
  console.log(messageOutput.split('\n').filter(line => line.includes('PASS:')).join('\n').trim());
  require('./testRoleMatrix')({ run, connection: ['-h', directory, '-U', 'audit_owner'], directory });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (started) {
    try { run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
  rmSync(directory, { recursive: true, force: true });
}
