#!/usr/bin/env bash
#
# Daily PostgreSQL backup for the Parakkat HRMS database.
#
#   ./deploy/backup.sh                    # back up using $SUPABASE_DB_URL or $DATABASE_URL
#   BACKUP_DIR=/mnt/backups ./deploy/backup.sh
#
# Install as a cron job (02:45 IST daily, before the engine's nightly pass at 02:30 is long done):
#   45 2 * * *  /opt/parakkat/services/attendance/deploy/backup.sh >> /var/log/parakkat-backup.log 2>&1
#
# Restore procedure is documented in deploy/RESTORE.md. Read it BEFORE you need it.

set -Eeuo pipefail

# --- configuration ----------------------------------------------------------
BACKUP_DIR="${BACKUP_DIR:-/var/backups/parakkat}"
RETAIN_DAILY="${RETAIN_DAILY:-14}"     # keep two weeks of dailies
RETAIN_WEEKLY="${RETAIN_WEEKLY:-8}"    # plus two months of Sunday copies
DB_URL="${SUPABASE_DB_URL:-${DATABASE_URL:-}}"

# Load .env if the variables were not already exported.
if [[ -z "$DB_URL" && -f "$(dirname "$0")/../.env" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$(dirname "$0")/../.env"; set +a
  DB_URL="${DATABASE_URL:-}"
fi

if [[ -z "$DB_URL" ]]; then
  echo "ERROR: no database URL. Set SUPABASE_DB_URL or DATABASE_URL." >&2
  exit 1
fi

command -v pg_dump >/dev/null || { echo "ERROR: pg_dump not found (install postgresql-client)." >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
DOW="$(date +%u)"   # 7 = Sunday
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

DAILY_FILE="$BACKUP_DIR/daily/parakkat-$STAMP.dump"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

cleanup_failed() {
  # Never leave a truncated dump lying around looking like a good backup.
  [[ -f "$DAILY_FILE" ]] && rm -f "$DAILY_FILE"
  log "FAILED — partial dump removed"
}
trap cleanup_failed ERR

log "starting backup -> $DAILY_FILE"

# Custom format (-Fc): compressed, and restorable selectively with pg_restore.
# --no-owner / --no-acl because Supabase manages roles; restoring them fights the platform.
pg_dump "$DB_URL" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-acl \
  --file="$DAILY_FILE"

trap - ERR

SIZE="$(du -h "$DAILY_FILE" | cut -f1)"
log "dump complete ($SIZE)"

# --- verify -----------------------------------------------------------------
# A backup that has never been read is a hope, not a backup. This does not prove the data is
# correct, but it does prove the file is a well-formed archive rather than 4 KB of error text.
if pg_restore --list "$DAILY_FILE" > /dev/null 2>&1; then
  TABLES="$(pg_restore --list "$DAILY_FILE" | grep -c 'TABLE DATA' || true)"
  log "verified: archive is readable, $TABLES tables with data"
  if [[ "$TABLES" -lt 10 ]]; then
    log "WARNING: only $TABLES tables — expected 30+. Check that the dump covered the whole schema."
  fi
else
  log "ERROR: the dump is not a readable archive"
  rm -f "$DAILY_FILE"
  exit 1
fi

# --- weekly copy ------------------------------------------------------------
if [[ "$DOW" == "7" ]]; then
  cp "$DAILY_FILE" "$BACKUP_DIR/weekly/parakkat-weekly-$STAMP.dump"
  log "weekly copy kept"
fi

# --- retention --------------------------------------------------------------
find "$BACKUP_DIR/daily"  -name 'parakkat-*.dump'        -type f -mtime "+$RETAIN_DAILY"        -delete -print | sed 's/^/  pruned /'
find "$BACKUP_DIR/weekly" -name 'parakkat-weekly-*.dump' -type f -mtime "+$((RETAIN_WEEKLY * 7))" -delete -print | sed 's/^/  pruned /'

REMAINING="$(find "$BACKUP_DIR/daily" -name '*.dump' -type f | wc -l)"
log "done. $REMAINING daily backups on disk in $BACKUP_DIR"

# Offsite copy. A backup on the same box as the database survives a bad migration but not a dead
# disk — uncomment and point at wherever the group keeps its offsite storage.
# rclone copy "$DAILY_FILE" remote:parakkat-backups/daily/ && log "copied offsite"
