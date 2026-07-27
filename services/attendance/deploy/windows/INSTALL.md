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
