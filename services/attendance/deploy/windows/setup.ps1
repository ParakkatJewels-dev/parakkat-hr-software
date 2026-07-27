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
Write-Host "`nInstalling dependencies (a few minutes on first run)..."
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Host 'npm install failed - check the error above.' -ForegroundColor Red; exit 1 }

npx prisma generate
if ($LASTEXITCODE -ne 0) { Write-Host 'prisma generate failed - check the error above.' -ForegroundColor Red; exit 1 }

npm run build
if ($LASTEXITCODE -ne 0) { Write-Host 'Build failed - check the error above.' -ForegroundColor Red; exit 1 }

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
