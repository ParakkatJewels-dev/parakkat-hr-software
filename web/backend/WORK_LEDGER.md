# Work Ledger

A personal work ledger inside the HR app, rebuilt from the Creative Head's Google Sheet + Apps Script
"Work Ledger": tasks through a review workflow, daily progress notes, help given to the team, ideas,
campaigns, reminders, and the daily / weekly / monthly report that is edited and shared with
management. Anyone with `ledger.use` (every standard role) gets their own ledger on first open.

## Who can see what

| | Owner | Their line manager | HR, super admins, peers |
| --- | --- | --- | --- |
| Tasks, progress, help, ideas, campaigns, library, reports, insights | read and change | **read only** (Team ledgers) | nothing |
| Reminders and Google Calendar | yes | never | never |

"Line manager" is anyone holding `ledger.read_team` (entity admin, zonal manager, branch manager,
department head) through a role assignment that covers the owner's company, zone, branch or
department **and** ranks above the owner. Super admins are deliberately excluded (`app.ledger_can_read`
does not use `app.has_perm`, which has a super-admin bypass). Every write is an owner-only RPC; the
tables have no client write grants. Deletes are soft.

## Migrations

| File | What it adds |
| --- | --- |
| `0169_work_ledger.sql` | Tables, privacy, starter data, reports, CSV export, the importer |
| `0170_work_ledger_writes.sql` | Task / child / reminder writes, the `ledger-files` bucket (50 MB), Google Calendar storage, Home, search |
| `0171_work_ledger_planning.sql` | Campaigns, ideas, library, festival dates 2026–28, insights |
| `0172_work_ledger_assistant.sql` | The "Work Ledger" area for Hermes keys (`ledger:manage`) — needs `0168_hermes_agent_api.sql` first |

Apply them in order with the normal migration runner, then deploy `web` (it adds `api/google/[action].js`).
In Supabase, **Storage → Settings**, the upload limit must be at least 50 MB for attachments.

## Google Calendar

Reminders become real Google Calendar events (15 minutes long, pop-ups at the time and 10 minutes
before; repeats become calendar series). Today's and tomorrow's meetings appear in the Home schedule.
The refresh token is encrypted on the server with `GOOGLE_TOKEN_KEY` and bound to the owner; it never
reaches the browser, and no Supabase service-role key is used.

### 1. Create the OAuth client (Google Cloud console)

1. Create (or pick) a project at <https://console.cloud.google.com>, then **APIs & Services → Library →
   Google Calendar API → Enable**.
2. **OAuth consent screen**:
   - Company Google Workspace accounts only: choose **Internal**. No Google review is needed and
     connections do not expire.
   - Any personal Gmail accounts: choose **External**, add the scope
     `https://www.googleapis.com/auth/calendar.events`, and submit for verification. Until Google
     approves it (days to weeks), only listed test users can connect and **their connection expires
     every 7 days** — the app then shows "Reconnect Google Calendar".
3. **Credentials → Create credentials → OAuth client ID → Web application**. Authorised redirect URI:
   `https://parakkat-hr-software.vercel.app/api/google/callback` (use the real production address).

### 2. Vercel environment variables (Production)

| Variable | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | from step 3 |
| `GOOGLE_CLIENT_SECRET` | from step 3 |
| `GOOGLE_REDIRECT_URI` | exactly the redirect URI registered above |
| `GOOGLE_TOKEN_KEY` | 32 random bytes, base64: `openssl rand -base64 32`. Keep it safe — changing it means everyone reconnects |
| `GOOGLE_CLIENT_KIND` | `workspace` (default) or `external` |

The function also uses the existing `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. If any Google
variable is missing, the ledger works normally and Settings says Calendar is not set up.

### 3. Connect

Each person opens **Work Ledger → Settings → Connect Google Calendar**. On the phone app, Google opens
in the system browser and returns to the web app; connecting from a desktop browser is simplest.

## Importing the old Google Sheet

**Settings → Import** reads the whole workbook as one `.xlsx` (Google Sheets: File → Download →
Microsoft Excel), shows a dry run (counts, broken references, rows already edited here), then imports in
batches. Re-running updates by original sheet row and never duplicates. After the final import at
switch-over, lock the import. **Compare with the old app** shows a line-by-line diff between a pasted old
report and ours.

## Hermes

With migration 0172, a personal assistant key can include the **Work Ledger** area. Tools:
`ledger_home`, `ledger_list_tasks`, `ledger_get_task`, `ledger_report` (with ready-to-share text),
`ledger_list_ideas`, `ledger_list_reminders`, `ledger_list_campaigns`, `ledger_add_task`,
`ledger_update_task`, `ledger_mark_done`, `ledger_log_progress`, `ledger_log_help`, `ledger_add_idea`,
`ledger_add_reminder` (mirrored to Google Calendar straight away). Nothing deletes. The key acts as its
owner, so it only ever reaches the owner's own ledger.

## Verification

- `npm --prefix web/backend test` (run with `LC_ALL=C`) runs `tests/work_ledger.sql`,
  `work_ledger_writes.sql`, `work_ledger_planning.sql` and `developer_api_ledger.sql`: the privacy
  matrix, every task / campaign / idea rule with pinned dates, reminders and the calendar outbox, import
  re-runs, and the assistant tools.
- `npm --prefix web test` covers the quick-capture grammar, share text, documents, importer parsing,
  Google OAuth and sync, the MCP tools, and the screens (`WorkLedger.test.js`).
- `?qa-ledger` opens the screens with in-memory demo data (add `&qa-role=dept_head` and go to
  `#/team-ledgers` for the manager's view).
