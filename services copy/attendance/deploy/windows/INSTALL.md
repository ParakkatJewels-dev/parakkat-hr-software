# Installing the attendance sync on the Easy Time Pro machine (Windows)

This connects Easy Time Pro (the ZKTeco punching software) to the HR system. After this,
punches appear in the HR dashboards and reports on their own. ~15 minutes, once.

Once installed it runs as a **Windows Service**: it starts by itself every time the machine is
switched on, before anybody logs in, and keeps running when the user signs out.

## What you need

- The Windows machine where Easy Time Pro is installed (currently the HR laptop)
- The Easy Time Pro username & password (what HR types on its login page)
- Internet on that machine
- An administrator account on that machine (needed once, to register the service)

## Steps

1. **Copy the folder.** Copy the whole `services/attendance` folder onto this machine (a pen
   drive is fine) — e.g. to `C:\parakkat\attendance`.

   > **The `.env` file must come with it.** It holds the database connection and is deliberately
   > kept out of git, so a fresh `git clone` will **not** have it. Copy the folder from a machine
   > that already has it, or ask for the file separately. The sync cannot start without it.

2. **Install Node.js** (skip if already installed): https://nodejs.org → download the **LTS**
   Windows installer → Next, Next, Finish.

3. **Double-click `Install.bat`** in `deploy\windows`.

   Windows will ask permission to make changes — say **Yes**. That prompt is the service
   registration; without it the sync could only run while somebody was logged in.

   It then asks you two things:

   - **The Easy Time Pro address** — paste what the browser shows, e.g. `192.168.1.45:8081`
     (the `/login` part is trimmed automatically). If Easy Time Pro is on *this same machine*,
     type `127.0.0.1:8081`. Press Enter to keep the saved one.
   - **The Easy Time Pro username and password** — HR can type these in themselves; they are
     stored only on this machine.

   After that it installs, builds, tests both connections, registers the service and switches off
   sleep-on-mains. Wait for **ALL GOOD**.

That is the whole install. There is no step 4 — sleep is disabled for you, and the service is
already set to start at boot.

## Updating an install that is already running

**Do this whenever the attendance rules change.** The service does not update itself, and a stale
copy is not harmless: it keeps recomputing attendance with whatever rules it was built with, and
quietly overwrites the corrected figures. One stale laptop rewrote fifteen months of attendance in
a single afternoon — re-applying a half-day rule that had been removed, and deducting a flat
40-minute break on every day instead of only the minutes over the allowance. Both cut people's
hours, and nothing on screen said why.

Two steps.

**1. Get the new code onto the machine.**

If the folder is a git clone (there is a `.git` folder inside the project), this is the whole job:

```powershell
git pull
```

`.env`, `node_modules`, `dist` and `logs` are all excluded from git, so a pull replaces the code
and cannot touch the login or the database connection.

If it was copied from a pen drive instead, copy the folder across again — but **keep the existing
`.env`**. The one on the development machine has `FILL_ME` where the Easy Time Pro password should
be, so overwriting the real one stops the sync until somebody notices. Safest is to copy the new
folder beside the old one and move `.env` across:

```powershell
copy C:\parakkat\attendance\.env C:\parakkat\attendance-new\.env
```

**2. Double-click `Install.bat` again.**

It stops the service, installs, rebuilds and starts it back up. It is safe to re-run any number of
times and skips whatever is already done. Wait for **ALL GOOD**.

### Confirming the update actually took

`services.msc` showing *Running* only proves something is running — not that it is the new build.
Two checks that do:

- `logs\out.log` should show fresh startup lines with the current time.
- In the HR web app, open **Attendance → by person** for anyone and look at a Sunday they worked.
  It should read *Weekly Off* with the whole day as overtime. If half days start reappearing on
  ordinary weekdays, the service is still on the old build.

## Checking it works

- Press Start, type `services.msc`, Enter. **Parakkat Attendance Sync** should be *Running*,
  Startup type *Automatic*.
- `logs\out.log` in the service folder shows what it is doing.
- In the HR web app: **Time & Attendance → Setup** should list the ZKTeco terminal within a few
  minutes. Map each device employee code to the right person there.
- Dashboard and Reports fill up as punches arrive.

## If something fails

Open the service folder in PowerShell and run:

```powershell
npm run doctor
```

It says exactly what is wrong — wrong password, Easy Time Pro not running, no internet, database
unreachable. Fix it, then double-click `Install.bat` again; it is safe to re-run any number of
times and skips whatever is already done.

### "EPERM: operation not permitted, rename ... query_engine-windows.dll.node"

The installer is trying to replace a file that the running service has open. It is not a
permissions problem, and **nothing is broken** — the service carries on running with the copy it
already has, so punches keep syncing while you sort this out.

`Install.bat` now stops the service before touching those files, so this should not recur. If it
still appears, something else is holding the folder:

1. `services.msc` → stop **Parakkat Attendance Sync**
2. Close any PowerShell window running `npm run dev` in this folder
3. Run `Install.bat` again

### The device was switched off, or the network changed, and nothing syncs any more

This used to need a manual restart. A run that was mid-request when the network vanished could sit
there forever — the socket stays open as far as Windows is concerned even though the packets go
nowhere — and while it sat there, every later run was skipped because one was "already in
progress". The symptom was silence: the service looked healthy and collected nothing.

Each job now has a deadline (10 minutes for the punch sync). Past it, the run is abandoned, the
connection pool is thrown away so the next attempt dials fresh, and the following tick retries. A
network switch costs you one cycle, not the rest of the day.

To confirm it recovered, check that the newest run is recent and not `running`:

```powershell
npm run doctor
```

Runs interrupted by a shutdown or a lost connection are marked `failed` the next time the service
starts, so a stale `running` row never hides a real outage again.

## Everyday commands

| To do this | Do that |
|---|---|
| See if it is running | `services.msc` → Parakkat Attendance Sync |
| Restart it | `node deploy\windows\service.cjs restart` (as administrator) |
| Watch what it is doing | open `logs\out.log` |
| Re-test the connections | `npm run doctor` |
| Remove it | double-click `Uninstall.bat` |

## Moving to a new machine later

Install Easy Time Pro there, repeat these steps, then run `Uninstall.bat` on the old machine.
Punch history already synced lives in the cloud database and is not affected; the terminal
re-delivers anything the new install missed.

## Good to know

- **A sleeping or switched-off laptop pauses the sync, it does not lose punches.** The terminal
  stores them and the service catches up on the next run — it deliberately re-scans the last few
  days for exactly this reason.
- **The service restarts itself if it crashes**, and backs off if it is crashing repeatedly
  (which means a real problem the restart cannot fix — check `npm run doctor`).
