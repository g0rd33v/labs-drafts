#!/bin/bash
# Daily backup of drafts data with cross-server push and Telegram notifications
# Configurable via env vars:
#   SRC          - source dir (default: auto-detect)
#   DEST         - local backup dir (default: /var/backups/drafts)
#   PREFIX       - archive name prefix (default: auto from hostname)
#   REMOTE_HOST  - remote ssh target (default: auto-detect)
#   REMOTE_PATH  - remote backup dir
#   LOCAL_KEEP_DAYS  - local retention (default: 14)
#   REMOTE_KEEP_DAYS - remote retention (default: 30)

set -uo pipefail

# Defaults based on hostname
HOSTNAME=$(hostname -s 2>/dev/null || hostname)
case "$HOSTNAME" in
  beta*)
    SRC="${SRC:-/var/www/beta.labs.vc/drafts}"
    PREFIX="${PREFIX:-beta_drafts}"
    REMOTE_HOST="${REMOTE_HOST:-root@drafts.labs.vc}"
    REMOTE_PATH="${REMOTE_PATH:-/var/backups/beta-drafts}"
    ;;
  drafts*)
    SRC="${SRC:-/var/lib/drafts}"
    PREFIX="${PREFIX:-drafts1}"
    REMOTE_HOST="${REMOTE_HOST:-root@beta.labs.vc}"
    REMOTE_PATH="${REMOTE_PATH:-/var/backups/drafts1-mirror}"
    ;;
  *)
    SRC="${SRC:-/var/lib/drafts}"
    PREFIX="${PREFIX:-drafts}"
    REMOTE_HOST="${REMOTE_HOST:-}"
    REMOTE_PATH="${REMOTE_PATH:-/var/backups/drafts-mirror}"
    ;;
esac

DEST="${DEST:-/var/backups/drafts}"
LOCAL_KEEP_DAYS="${LOCAL_KEEP_DAYS:-14}"
REMOTE_KEEP_DAYS="${REMOTE_KEEP_DAYS:-30}"

TS=$(date +%Y%m%d_%H%M%S)
ARCHIVE="$DEST/${PREFIX}_${TS}.tar.gz"
LOG="$DEST/backup.log"
NOTIFY=/opt/labs/notify.sh

mkdir -p "$DEST"

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG"; }
notify() { [ -x "$NOTIFY" ] && "$NOTIFY" "$1" 2>/dev/null || true; }
fail() {
  log "FAILED: $1"
  notify "❌ *Backup FAILED* on \`$HOSTNAME\`
$1"
  exit 1
}

log "=== starting backup ($HOSTNAME) ==="

# 1. Local archive
if [ -d "$SRC" ]; then
  if ! tar -czf "$ARCHIVE" --exclude='*/drafts/.git/objects/pack' \
       -C "$(dirname "$SRC")" "$(basename "$SRC")" 2>>"$LOG"; then
    fail "tar failed for $SRC"
  fi
else
  log "WARN: $SRC missing — creating empty placeholder archive"
  tar -czf "$ARCHIVE" -C /tmp --files-from=/dev/null 2>>"$LOG" || fail "empty archive creation failed"
fi

[ -f "$ARCHIVE" ] || fail "archive missing after tar"
SIZE=$(du -h "$ARCHIVE" | cut -f1)
SIZE_BYTES=$(stat -c%s "$ARCHIVE")
log "local: $ARCHIVE ($SIZE)"

# 2. Push to remote
REMOTE_OK=false
if [ -n "$REMOTE_HOST" ]; then
  if ssh -o BatchMode=yes -o ConnectTimeout=15 "$REMOTE_HOST" "mkdir -p $REMOTE_PATH" 2>>"$LOG" && \
     scp -o BatchMode=yes -o ConnectTimeout=30 "$ARCHIVE" "$REMOTE_HOST:$REMOTE_PATH/" 2>>"$LOG"; then
    log "remote push ok: $REMOTE_HOST:$REMOTE_PATH/"
    ssh -o BatchMode=yes "$REMOTE_HOST" \
      "find $REMOTE_PATH -name '${PREFIX}_*.tar.gz' -mtime +$REMOTE_KEEP_DAYS -delete" 2>>"$LOG" || true
    REMOTE_OK=true
  else
    log "WARN: remote push failed"
    notify "⚠️ *Backup WARN* on \`$HOSTNAME\`
local ok ($SIZE) but remote push to \`$REMOTE_HOST\` failed"
  fi
fi

# 3. Local retention
find "$DEST" -name "${PREFIX}_*.tar.gz" -type f -mtime +$LOCAL_KEEP_DAYS -delete
log "retention applied (local=${LOCAL_KEEP_DAYS}d remote=${REMOTE_KEEP_DAYS}d)"

# 4. Success notify (only if everything ok)
COUNT=$(ls "$DEST"/${PREFIX}_*.tar.gz 2>/dev/null | wc -l)
if [ "$REMOTE_OK" = "true" ]; then
  notify "✅ *Backup OK* on \`$HOSTNAME\`
size: $SIZE
remote: \`$REMOTE_HOST\`
local copies: $COUNT"
elif [ -z "$REMOTE_HOST" ]; then
  notify "✅ *Backup OK (local only)* on \`$HOSTNAME\`
size: $SIZE
local copies: $COUNT"
fi

log "=== done ==="
