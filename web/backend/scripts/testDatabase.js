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
    ['hr_team_picker_audit', 'team_picker_pagination.sql'],
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
  const routineTests = join(backend, 'tests', 'routine_scheduling.sql');
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
      ...(file.startsWith('0140_') ? ['\\set routine_seed on', `\\i ${quote(routineTests)}`] : []),
      ...(file.startsWith('0149_') ? ['\\set task_authors_seed on', `\\i ${quote(join(backend, 'tests', 'task_comment_authors.sql'))}`] : []),
      `\\i ${quote(join(migrations, file))}`,
      // This migration promises safe reruns; enforce that before running API assertions.
      ...(/^(0129|0133|0134|0137|0138|0139|0140|0141|0142|0143|0144|0145|0146|0147|0148|0149)_/.test(file) ? [`\\i ${quote(join(migrations, file))}`] : []),
    ]),
    '\\set message_requests_seed off',
    '\\set task_authors_seed off',
    `\\i ${quote(join(backend, 'tests', 'task_comment_authors.sql'))}`,
    `\\i ${quote(messageTests)}`,
    `\\i ${quote(join(backend, 'tests', 'chat_preferences.sql'))}`,
    `\\i ${quote(join(backend, 'tests', 'chat_typing.sql'))}`,
    `\\i ${quote(join(backend, 'tests', 'ticket_category_routing.sql'))}`,
    '\\set routine_seed off',
    `\\i ${quote(routineTests)}`,
    `\\i ${quote(join(backend, 'tests', 'section_counts.sql'))}`,
    `\\i ${quote(join(backend, 'tests', 'request_integrity.sql'))}`,
    `\\i ${quote(join(backend, 'tests', 'immediate_account_revocation.sql'))}`,
    `\\i ${quote(join(backend, 'tests', 'report_input_integrity.sql'))}`,
    `\\i ${quote(join(backend, 'tests', 'device_employee_provisioning.sql'))}`,
  ].join('\n'));
  run('createdb', [...connection, messageDatabase]);
  const messageOutput = run('psql', [...connection, '-d', messageDatabase, '-q', '-f', messageBootstrap]);
  console.log(messageOutput.split('\n').filter(line => line.includes('PASS:')).join('\n').trim());
  console.log(run(process.execPath, [join(__dirname, 'testMessageNotificationConcurrency.js'), directory]).trim());
  require('./testAdminPassword')({ run, connection, directory });
  require('./testDeveloperApi')({ run, connection, directory });
  require('./testPayrollIntegrity')({ run, connection, directory });
  require('./testRoleMatrix')({ run, connection: ['-h', directory, '-U', 'audit_owner'], directory });
  require('./testMigrationOwnership')({ run, connection, directory });
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
