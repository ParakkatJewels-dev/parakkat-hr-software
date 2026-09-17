/**
 * Register the attendance sync as a real Windows Service.
 *
 *   node service.cjs install     create it and start it (idempotent)
 *   node service.cjs uninstall   stop and remove it
 *   node service.cjs restart     bounce it after a config change
 *
 * Why a service and not pm2:
 *
 * pm2-windows-startup hooks the *logon* event, so the sync only ran once somebody signed in to
 * this machine. A laptop that reboots overnight and sits at the lock screen would silently stop
 * collecting punches until the next morning — exactly the interruption this is meant to prevent.
 *
 * A Windows Service starts at boot, before any login, keeps running when the user signs out, and
 * is restarted by Windows itself if it dies. It also survives the pm2 daemon being killed, which
 * an antivirus sweep is quite capable of doing.
 *
 * node-windows is installed by setup.ps1 rather than listed in package.json: it is Windows-only
 * and would be dead weight in the Mac/Linux dev install.
 */
const path = require('node:path');
const fs = require('node:fs');

let Service;
try {
  ({ Service } = require('node-windows'));
} catch {
  console.error(
    '\nnode-windows is not installed. Run this from the service folder first:\n' +
      '  npm install node-windows --no-save\n'
  );
  process.exit(1);
}

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'dist', 'index.js');
const action = (process.argv[2] || 'install').toLowerCase();

if (action !== 'uninstall' && !fs.existsSync(SCRIPT)) {
  console.error(`\nBuilt output missing: ${SCRIPT}\nRun "npm run build" first.\n`);
  process.exit(1);
}

// Logs land beside the service so they are easy to find and to send on when something is wrong.
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });

const svc = new Service({
  name: 'Parakkat Attendance Sync',
  description:
    'Collects attendance punches from Easy Time Pro and keeps the Parakkat HR system up to date. ' +
    'Starts automatically at boot.',
  script: SCRIPT,
  workingDirectory: ROOT,
  env: [{ name: 'NODE_ENV', value: 'production' }],

  // Restart policy. The service is written to crash rather than run on in an unknown state, so a
  // restart is normal and cheap — but a crash LOOP means something restarting cannot fix (bad
  // credentials, unreachable database), so back off and stop rather than thrash.
  wait: 5,          // seconds before the first restart
  grow: 0.5,        // and longer each time
  maxRestarts: 10,  // within 60s, then give up and let the Event Log show why
});

svc.on('alreadyinstalled', () => {
  console.log('Service already installed — restarting it with the current build.');
  svc.restart();
});
svc.on('install', () => {
  console.log('Service installed. Starting…');
  svc.start();
});
svc.on('start', () => {
  console.log('\n  Parakkat Attendance Sync is RUNNING.');
  console.log('  It will start again by itself every time this machine boots —');
  console.log('  no need for anyone to log in.\n');
});
svc.on('uninstall', () => console.log('Service removed.'));
svc.on('error', (e) => console.error('Service error:', e));

if (action === 'install') svc.install();
else if (action === 'uninstall') svc.uninstall();
else if (action === 'restart') svc.restart();
else {
  console.error(`Unknown action "${action}". Use install, uninstall or restart.`);
  process.exit(1);
}
