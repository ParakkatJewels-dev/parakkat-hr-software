// backend/scripts/dev.js
// This backend is a HOSTED Supabase project — there is no local server to "start".
// (The previous version ran `supabase start`, which needs Docker + a local stack this
// project does not use, and is blocked by Windows Smart App Control anyway.)

console.log(`
Parakkat HRMS backend — nothing to "start" here.

The backend is a hosted Supabase project (Postgres + Auth). Common tasks:

  npm run migrate                        apply pending SQL migrations to the hosted DB
  npm run migrate -- --baseline          mark existing schema as applied (already-migrated DB)
  python scripts/import_employees.py     load the staff rosters
  python scripts/create_user.py <email> --super-admin   create the first admin

To run the app UI, use the web dev server (this folder lives inside web/):

  cd .. && npm run dev
`);
