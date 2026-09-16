// Disposable local PostgreSQL QA; never reads .env or changes application files/fixtures.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hrms-extra-db-'));
const data = path.join(directory, 'pgdata');
let started = false;
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  for (const relative of ['web/backend/scripts', 'web/backend/tests', 'web/backend/supabase', 'web/src/test']) {
    fs.cpSync(path.join(root, relative), path.join(directory, relative), { recursive: true });
  }
  run('initdb', ['-D', data, '-A', 'trust', '-U', 'audit_owner', '--no-locale']);
  run('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-o', `-c listen_addresses='' -k '${directory}'`, '-w', 'start']);
  started = true;
  const connection = ['-h', directory, '-U', 'audit_owner'];
  require(path.join(directory, 'web/backend/scripts/testRoleMatrix.js'))({ run, connection, directory });
  const output = run('psql', [...connection, '-d', 'hr_role_matrix_audit', '-XqAt', '-f', path.join(__dirname, 'database-extra-probes.sql')]);
  const rows = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const probes = rows.filter(row => 'label' in row);
  const summary = rows.find(row => 'total' in row);
  if (!summary || summary.total !== probes.length) throw new Error('Probe report did not complete');
  const report = { summary, probes };
  fs.writeFileSync(path.join(__dirname, 'database-extra-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (summary.failed) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
} finally {
  if (started) {
    try { run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); }
    catch (error) { console.error(error.message); process.exitCode = 2; }
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
