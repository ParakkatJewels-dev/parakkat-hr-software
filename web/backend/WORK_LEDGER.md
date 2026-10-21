# Work Ledger

The one place for work in the HR app. It started as a personal ledger rebuilt from the Creative Head's
Google Sheet; since `0173` it runs on Task Management's own records (`public.tasks`), so every task,
subtask, comment, file, help request and routine is the same row everywhere. Task Management's Team,
Requests, Routines and Deleted views are mounted inside the Ledger; the Ledger adds review steps, rounds
of changes, progress notes, deliverables, history, focus / pin, the help log, reports, insights, quick
add, reminders and Google Calendar. The menu shows **Work Ledger** where Tasks used to be.

## Who can see what

| | The person | Managers in scope, HR, super admins | The creative team |
| --- | --- | --- | --- |
| Tasks and everything on them | as Task Management today | as Task Management today (`app.can_read_task` / `can_write_task`) | — |
| Help log, reports, insights | yes | read (`task.read` covering the person) | — |
| Pin and today's focus | own only | never | — |
| Reminders and Google Calendar | yes | never | — |
| Campaigns, ideas, library (vendors, templates, key dates, brand notes) | — | managers whose `task.read` covers a creative department | read and change, shared |

The creative team is the departments a super admin ticks in **Work Ledger → Settings → Creative team**
(`org_settings.creative_departments`, `app.is_creative_member()`). Members also see brand, work type,
campaign, vendor and costs on tasks, the creative block on Home, and the Sheet import. Nothing on the
creative tables is ever hard-deleted.

## Migrations

| File | What it adds |
| --- | --- |
| `0169`–`0172` | The original personal ledger; only its reminders, Google Calendar link, date helpers and festival calendar are still used |
| `0173_work_ledger_tasks.sql` | Ledger fields and rules on `tasks`; history, progress notes, deliverables, marks, help log; Home / report / insights / search reads; reminders linked to tasks |
| `0174_work_creative.sql` | The creative team setting; shared campaigns (+ log), ideas, vendors, templates, key dates, brands; `tasks.campaign_id` / `vendor_id`; creative report and insight parts |
| `0175_work_import.sql` | The old Google Sheet import onto tasks and the shared tables |
| `0176_work_assistant.sql` | Hermes's Work Ledger tools on task records; review step and more in the Tasks tools |
| `0177_work_ledger_cleanup.sql` | Removes the personal-ledger tables and functions and the `ledger-files` storage rules (the bucket too, if empty) |

Apply them in order with the normal migration runner, then deploy `web`.

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

For creative team members: **Settings → Bring over the old Google Sheet** reads the workbook as one
`.xlsx` (Google Sheets: File → Download → Microsoft Excel), shows the counts and any broken references,
**Check what is already here** lists rows changed here since, then imports in batches. WorkLog rows
become the importer's own tasks (support rows go to their help log) with the Sheet's own dates, rounds
of changes and approved versions — no history or notifications are invented. Campaigns, vendors and
brands that already exist by name are linked, never overwritten. Re-running updates only rows that still
hold exactly what was imported; anything changed or removed here is left alone (`app.work_import_map`).

## Hermes

An assistant key with the **Work Ledger** area (0172, on task records since `0176_work_assistant.sql`)
acts as its owner on the same tasks every screen shows: `ledger_home`, `ledger_list_tasks` (my tasks, by
step), `ledger_get_task`, `ledger_report` (with ready-to-share text; a manager may name someone they
manage), `ledger_list_reminders`, `ledger_add_task` (for myself), `ledger_update_task`, `ledger_mark_done`,
`ledger_log_progress`, `ledger_add_deliverable`, `ledger_log_help`, `ledger_add_reminder`; and for the
creative team `ledger_list_ideas`, `ledger_list_campaigns`, `ledger_add_idea`. The old step names (Brief,
Internal Review, Delivered…) still work. The Tasks area's `update_task` / `get_task` also know the review
step, waiting on, depends on, outcome, progress notes, deliverables and history. Nothing deletes.

## Verification

- `LC_ALL=C npm --prefix web/backend test` includes `tests/work_ledger_base.sql` (people, dates,
  reminders and Google Calendar), `work_tasks.sql`, `work_creative.sql`, `work_import.sql`, and
  `developer_api_ledger.sql` for Hermes: review steps and notifications, the checklist
  rollup, focus, visibility for every role, the creative team's access, campaign / idea rules, report and
  insight parts, and import re-runs.
- `npm --prefix web test` covers the screens (`WorkLedger.test.js`), routes and redirects from `/tasks`,
  quick capture, share text and the importer's parsing.
- `npm run qa:browser` then `?qa-ledger` opens the Ledger with in-memory demo data; add `&qa-creative`
  (or `&qa-creative=admin` to also choose the creative departments) for the creative tabs.
