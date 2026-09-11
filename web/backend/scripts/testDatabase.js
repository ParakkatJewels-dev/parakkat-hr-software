// Starts a new private cluster for contract tests. Never reads .env or a connection URL.
const { mkdtempSync, rmSync } = require('node:fs');
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
