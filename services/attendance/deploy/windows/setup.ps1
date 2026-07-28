# Parakkat HRMS - attendance sync installer for the Easy Time Pro machine (Windows).
#
# Run from the service folder:
#   powershell -ExecutionPolicy Bypass -File deploy\windows\setup.ps1
#
# What it does, in order:
#   1. Verifies Node.js 20+ is installed (points you to the download if not)
#   2. Asks for the Easy Time Pro login and writes it into .env (first run only)
#   3. Installs dependencies, builds, and runs the connection doctor
#   4. Registers it as a Windows Service that starts automatically at boot
#
# Safe to re-run at any time - every step skips what is already done.

$ErrorActionPreference = 'Stop'
$ServiceRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $ServiceRoot
Write-Host "`n=== Parakkat attendance sync setup ===" -ForegroundColor Cyan
Write-Host "Service folder: $ServiceRoot`n"

# --- 1. Node.js ------------------------------------------------------------
try {
  $nodeVersion = (node --version) -replace 'v', ''
} catch {
  Write-Host 'Node.js is not installed.' -ForegroundColor Red
  Write-Host 'Download the LTS installer from https://nodejs.org , run it (Next -> Next -> Finish),'
  Write-Host 'then close this window and run this script again.'
  exit 1
}
if ([int]($nodeVersion.Split('.')[0]) -lt 20) {
  Write-Host "Node.js $nodeVersion is too old (need 20+). Install the LTS from https://nodejs.org and re-run." -ForegroundColor Red
  exit 1
}
Write-Host "Node.js $nodeVersion  OK" -ForegroundColor Green

# --- 2. .env ---------------------------------------------------------------
if (-not (Test-Path '.env')) {
  Write-Host '.env file is missing. Copy the WHOLE services\attendance folder from the main project' -ForegroundColor Red
  Write-Host '(it contains a prepared .env) and run this script again.'
  exit 1
}
$envText = Get-Content '.env' -Raw -Encoding UTF8

# 2a. Easy Time Pro address - always confirmed, so the same installer works on any machine
# (on the Easy Time Pro machine itself use 127.0.0.1:8081; from another machine use its IP).
$currentUrl = if ($envText -match 'BIOTIME_BASE_URL="([^"]*)"') { $Matches[1] } else { '' }
if (-not $currentUrl) {
  Write-Host 'The .env file looks malformed: no BIOTIME_BASE_URL="..." line found.' -ForegroundColor Red
  Write-Host 'Copy a fresh services\attendance folder (with its .env) and run this script again.'
  exit 1
}
Write-Host "Easy Time Pro address - paste what the browser shows, e.g. 192.168.1.45:8081" -ForegroundColor Yellow
Write-Host "(the /login part is removed automatically; if Easy Time Pro runs on THIS machine, use 127.0.0.1:8081)"
$addr = Read-Host "Address [press Enter to keep $currentUrl]"
if ($addr.Trim()) {
  $a = $addr.Trim()
  if ($a -notmatch '^https?://') { $a = 'http://' + $a }
  try {
    $uri = [Uri]$a
    $a = $uri.Scheme + '://' + $uri.Authority
    if ($uri.IsDefaultPort) {
      Write-Host "Note: no port in that address, so port 80 will be used. Easy Time Pro usually runs" -ForegroundColor Yellow
      Write-Host "on a specific port (e.g. :8081) - if the browser shows a number after a colon, include it." -ForegroundColor Yellow
    }
  } catch {
    Write-Host "Could not understand '$addr' as an address. Use a form like 192.168.1.45:8081 and re-run." -ForegroundColor Red
    exit 1
  }
  # .Replace() is a literal string swap - regex -replace would mangle values containing '$'.
  $envText = $envText.Replace('BIOTIME_BASE_URL="' + $currentUrl + '"', 'BIOTIME_BASE_URL="' + $a + '"')
  Set-Content '.env' $envText -NoNewline -Encoding UTF8
  Write-Host "Address saved: $a" -ForegroundColor Green
} else {
  Write-Host "Keeping: $currentUrl" -ForegroundColor Green
}

# 2b. Easy Time Pro login - asked only while the placeholders are still in place.
# (To change it later, edit .env or set the two values back to "FILL_ME" and re-run.)
if ($envText -match 'FILL_ME') {
  Write-Host 'Enter the Easy Time Pro login (what HR types at the /login page).' -ForegroundColor Yellow
  $etpUser = Read-Host 'Easy Time Pro username'
  $etpPassSecure = Read-Host 'Easy Time Pro password' -AsSecureString
  $etpPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($etpPassSecure))
  # dotenv parses double-quoted values, so a quote, newline or edge whitespace would silently
  # corrupt the stored password and look like "wrong password" later.
  if ($etpPass -match '"' -or $etpPass -match "[`r`n]" -or $etpPass -ne $etpPass.Trim()) {
    Write-Host 'The password contains a double-quote, a line break, or leading/trailing spaces.' -ForegroundColor Red
    Write-Host 'Those cannot be stored safely in the config file - re-run and retype it, or change'
    Write-Host 'the Easy Time Pro password to one without those characters.'
    exit 1
  }
  if ($etpUser -match '"' -or $etpUser -ne $etpUser.Trim()) {
    Write-Host 'The username contains a double-quote or edge spaces - retype it and re-run.' -ForegroundColor Red
    exit 1
  }
  # .Replace() is a literal string swap - regex -replace would mangle passwords containing '$'.
  $envText = $envText.Replace('BIOTIME_USERNAME="FILL_ME"', 'BIOTIME_USERNAME="' + $etpUser + '"')
  $envText = $envText.Replace('BIOTIME_PASSWORD="FILL_ME"', 'BIOTIME_PASSWORD="' + $etpPass + '"')
  if ($envText -match 'FILL_ME') {
    Write-Host 'Could not write the login into .env (the file format has changed). Fix .env by hand.' -ForegroundColor Red
    exit 1
  }
  Set-Content '.env' $envText -NoNewline -Encoding UTF8
  Write-Host 'Login saved into .env' -ForegroundColor Green
} else {
  Write-Host '.env already configured  OK' -ForegroundColor Green
}

# --- 3. install, build, doctor ----------------------------------------------
# Stop the service FIRST. On a re-run the service is already running, and it holds
# node_modules\.prisma\client\query_engine-windows.dll.node open. Windows will not let anything
# rename over a DLL that is loaded, so `prisma generate` dies with:
#
#   EPERM: operation not permitted, rename '...query_engine-windows.dll.node.tmp35848'
#
# which reads like a permissions problem and is not one. Nothing here needs the service running.
$svc = Get-Service -Name 'parakkatattendancesync.exe' -ErrorAction SilentlyContinue
if (-not $svc) { $svc = Get-Service -DisplayName '*Parakkat Attendance*' -ErrorAction SilentlyContinue }

if ($svc -and $svc.Status -ne 'Stopped') {
  Write-Host "`nStopping the running service so its files can be replaced..." -ForegroundColor Cyan
  try {
    Stop-Service -InputObject $svc -Force -ErrorAction Stop
    # Stop-Service returns before the process has actually exited and released its handles.
    $svc.WaitForStatus('Stopped', '00:00:30')
    Start-Sleep -Seconds 2
    Write-Host 'Service stopped  OK' -ForegroundColor Green
  } catch {
    Write-Host 'Could not stop the service automatically.' -ForegroundColor Yellow
    Write-Host 'Open services.msc, stop "Parakkat Attendance Sync", then run this again.' -ForegroundColor Yellow
    exit 1
  }
}

Write-Host "`nInstalling dependencies (a few minutes on first run)..."
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Host 'npm install failed - check the error above.' -ForegroundColor Red; exit 1 }

npx prisma generate
if ($LASTEXITCODE -ne 0) {
  Write-Host 'prisma generate failed - check the error above.' -ForegroundColor Red
  Write-Host 'If it says EPERM ... query_engine-windows.dll.node, something still has the file open:' -ForegroundColor Yellow
  Write-Host '  1. services.msc  ->  stop "Parakkat Attendance Sync"' -ForegroundColor Yellow
  Write-Host '  2. close any window running "npm run dev" in this folder' -ForegroundColor Yellow
  Write-Host '  3. run Install.bat again' -ForegroundColor Yellow
  exit 1
}

npm run build
if ($LASTEXITCODE -ne 0) { Write-Host 'Build failed - check the error above.' -ForegroundColor Red; exit 1 }

# A LAN address is the one thing here that no amount of retrying can recover from. If the router
# hands this machine a different lease after a power cut, http://192.168.1.x stops resolving to
# Easy Time Pro and the sync is broken until somebody edits .env. Loopback never changes — so if
# Easy Time Pro is answering on this very machine, say so now rather than after an outage.
$envUrl = (Select-String -Path '.env' -Pattern '^BIOTIME_BASE_URL' -ErrorAction SilentlyContinue).Line
if ($envUrl -and $envUrl -notmatch '127\.0\.0\.1|localhost') {
  $port = 8081
  if ($envUrl -match ':(\d+)') { $port = $Matches[1] }

  $local = $false
  try {
    $probe = New-Object Net.Sockets.TcpClient
    $probe.Connect('127.0.0.1', [int]$port)
    $local = $probe.Connected
    $probe.Close()
  } catch { $local = $false }

  if ($local) {
    Write-Host "`n  NOTE: Easy Time Pro is answering on this machine (127.0.0.1:$port)." -ForegroundColor Yellow
    Write-Host '  Your .env points at a LAN address instead. If this router ever gives this' -ForegroundColor Yellow
    Write-Host '  machine a different IP, the sync will stop until someone edits .env.' -ForegroundColor Yellow
    Write-Host "  Safer: set BIOTIME_BASE_URL=http://127.0.0.1:$port in .env - loopback cannot change." -ForegroundColor Yellow
  } else {
    Write-Host "`n  NOTE: Easy Time Pro is on another machine. Give that machine a fixed IP" -ForegroundColor Yellow
    Write-Host '  (a DHCP reservation on the router) so this address keeps working.' -ForegroundColor Yellow
  }
}

Write-Host "`nRunning the connection doctor (checks Easy Time Pro login + database)..." -ForegroundColor Cyan
npm run doctor
if ($LASTEXITCODE -ne 0) {
  Write-Host "`nDoctor found a problem - read its message above. Common causes:" -ForegroundColor Red
  Write-Host ' - Easy Time Pro is not running on this machine (open it and re-run)'
  Write-Host ' - Wrong username/password (edit the .env file, or delete the BIOTIME_USERNAME/'
  Write-Host '   BIOTIME_PASSWORD values back to "FILL_ME" and re-run this script)'
  Write-Host ' - No internet connection (the database lives in the cloud)'
  exit 1
}

# --- 4. Install as a Windows Service ----------------------------------------
# A service, not pm2: pm2-windows-startup only fires when somebody logs in, so a machine sitting
# at the lock screen after a reboot would quietly stop syncing. A service starts at boot.
Write-Host "`nInstalling the background service (starts automatically at boot)..." -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path 'logs' | Out-Null

# Windows-only helper, so it is not in package.json.
npm install node-windows --no-save --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Could not install node-windows - check the error above.' -ForegroundColor Red
  exit 1
}

node "deploy\windows\service.cjs" install
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Could not register the service - check the error above.' -ForegroundColor Red
  Write-Host 'Make sure you started this from Install.bat so it runs as administrator.' -ForegroundColor Yellow
  exit 1
}

# --- 5. Make Windows itself responsible for keeping it alive -----------------
# node-windows gives up after 10 restarts in a minute, which is the right call for a crash loop
# (bad password, unreachable database) — thrashing fixes nothing. But "gave up" means the service
# stays stopped until a person notices, and the whole point of this install is that nobody has to.
#
# So hand the job to the Windows Service Control Manager underneath it: restart after 60 seconds,
# every time, forever, with the failure count resetting daily. A machine that boots before the
# Wi-Fi is up, or loses the network for an hour, recovers on its own.
Write-Host "`nTelling Windows to restart the service if it ever stops unexpectedly..."

$svcName = (Get-Service -DisplayName '*Parakkat Attendance*' -ErrorAction SilentlyContinue |
            Select-Object -First 1).Name

if ($svcName) {
  # reset= 86400 : forget past failures after a day, so an old blip never exhausts the actions
  # actions= restart/60000 (x3) : the third entry applies to every subsequent failure too
  & sc.exe failure $svcName reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null
  # Recover from a clean-but-unexpected exit too, not only from a crash.
  & sc.exe failureflag $svcName 1 | Out-Null
  # Delay the start slightly so it is not racing the network stack at boot.
  & sc.exe config $svcName start= delayed-auto | Out-Null
  Write-Host 'Windows will restart it automatically after any failure.' -ForegroundColor Green
} else {
  Write-Host 'Could not find the service to set its recovery policy - set it by hand in' -ForegroundColor Yellow
  Write-Host 'services.msc > Parakkat Attendance Sync > Recovery > Restart the Service.' -ForegroundColor Yellow
}

# --- 6. Let the office network reach the service API -------------------------
# Windows blocks inbound connections to a new listener by default, so the admin screen's manual
# buttons (sync now, backfill, recompute, Excel export) fail from any other machine even when
# everything is running. Punch collection is unaffected either way — that is this machine dialling
# out to Easy Time Pro and to Supabase, not anything dialling in.
#
# Scoped to private/domain profiles so opening it does not expose the port on a public hotspot.
$apiPort = 8091
$portLine = (Select-String -Path '.env' -Pattern '^API_PORT\s*=' -ErrorAction SilentlyContinue).Line
if ($portLine -and $portLine -match '=\s*"?(\d+)') { $apiPort = [int]$Matches[1] }

Write-Host "`nAllowing the office network to reach the service on port $apiPort..."
$ruleName = 'Parakkat Attendance Sync API'
try {
  Get-NetFirewallRule -DisplayName $ruleName -ErrorAction Stop | Remove-NetFirewallRule -ErrorAction SilentlyContinue
} catch { }
try {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $apiPort -Profile Private,Domain -ErrorAction Stop | Out-Null
  Write-Host "Firewall rule added for TCP $apiPort (private/domain networks only)." -ForegroundColor Green
} catch {
  Write-Host "Could not add the firewall rule - the sync still works, but the admin screen's" -ForegroundColor Yellow
  Write-Host "manual buttons will not reach this machine from other PCs." -ForegroundColor Yellow
}

# The rule above is scoped to Private/Domain on purpose. If Windows has classified the office
# Wi-Fi as Public — which it does by default when you join a network and decline "make this PC
# discoverable" — the rule matches nothing and silently does no good. Worth catching here rather
# than leaving somebody to wonder why an added rule changed nothing.
$publicNets = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue |
                Where-Object { $_.NetworkCategory -eq 'Public' })
if ($publicNets.Count -gt 0) {
  Write-Host ''
  Write-Host '  WARNING: this machine treats its network as "Public", so the rule just added' -ForegroundColor Yellow
  Write-Host '  does not apply and other PCs still cannot reach the service. To fix:' -ForegroundColor Yellow
  foreach ($n in $publicNets) {
    Write-Host ("    Set-NetConnectionProfile -InterfaceAlias '{0}' -NetworkCategory Private" -f $n.InterfaceAlias) -ForegroundColor Yellow
  }
  Write-Host '  (Punch collection is unaffected either way - it dials out, nothing dials in.)' -ForegroundColor Yellow
}

# Sleep stops the syncing as surely as switching the machine off. Set it here rather than asking
# somebody to remember a Settings page.
Write-Host "`nStopping this machine from sleeping while plugged in..."
powercfg /change standby-timeout-ac 0      2>$null
powercfg /change hibernate-timeout-ac 0    2>$null
powercfg /change disk-timeout-ac 0         2>$null
Write-Host 'Sleep disabled on mains power (the screen can still turn off).' -ForegroundColor Green

Write-Host "`n=== ALL GOOD ===" -ForegroundColor Green
Write-Host 'The attendance sync is running as a Windows Service.'
Write-Host 'It starts by itself every time this machine boots - nobody needs to log in.'
Write-Host ''
Write-Host 'To check on it:'
Write-Host '  services.msc                    look for "Parakkat Attendance Sync"'
Write-Host '  logs\out.log                    what it is doing'
Write-Host '  npm run doctor                  re-test Easy Time Pro and the database'
Write-Host ''
Write-Host 'To remove it:  double-click Uninstall.bat'
