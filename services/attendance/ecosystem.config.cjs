// pm2 process definition for the attendance service.
//
//   npm run build
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup       # survive a reboot
//   pm2 logs parakkat-attendance
//
// One instance only, deliberately: two would both run the cron schedule and double every sync.
// The work is trivially small (a couple of HTTP calls a minute), so there is nothing to gain from
// clustering and a cursor to corrupt if we tried.
// pm2 does not create missing log directories — without this the app fails to launch (ENOENT).
require('node:fs').mkdirSync(require('node:path').join(__dirname, 'logs'), { recursive: true });

module.exports = {
  apps: [
    {
      name: 'parakkat-attendance',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',

      env: {
        NODE_ENV: 'production',
      },

      // Restart policy. The service is designed to crash rather than continue in an unknown
      // state, so restarts are expected and cheap — but a crash LOOP means a real problem
      // (bad credentials, unreachable database) that restarting cannot fix.
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 5_000,
      exp_backoff_restart_delay: 200,

      // A leak would show up as steadily climbing memory over days; recycle before it bites.
      max_memory_restart: '600M',

      // Give in-flight syncs time to finish on the way down (index.ts drains for up to 30s).
      kill_timeout: 35_000,
      listen_timeout: 10_000,
      wait_ready: false,

      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Never watch in production — a log write would restart the process.
      watch: false,
    },
  ],
};
