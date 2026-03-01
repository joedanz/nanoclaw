---
name: backup
description: "Set up automated backups of NanoClaw data (messages, group memory). Optionally includes credentials, session transcripts, and mount allowlist. Creates a backup script and schedules it via launchd/cron. Supports local, external drive, and cloud (rclone) destinations."
---

# NanoClaw Backup

Creates `scripts/backup.sh` with the user's configuration baked in, schedules it via launchd (macOS) or cron (Linux), and runs the first backup immediately to verify.

**Principle:** Do the work. Generate the script, install the schedule, run the backup. Only ask questions for genuine choices (destination, retention, schedule).

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## What Gets Backed Up

**Always included (irreplaceable core data):**

| Data | Method | Why |
|------|--------|-----|
| `store/messages.db` | `sqlite3 .backup` | Safe online backup — handles WAL/locks correctly while NanoClaw runs |
| `groups/*/` (excluding `logs/`) | `rsync -a --exclude='logs/'` | Per-group memory, CLAUDE.md, agent-created files |

**Optional (user chooses in step 5):**

| Data | Method | Risk / Note |
|------|--------|-------------|
| **Credentials** (`.env` + `store/auth/`) | `cp` + `rsync -a` (chmod 600) | **Security-sensitive.** API keys, OAuth tokens, WhatsApp device credentials. If backup compromised, attacker gains account access. Recreatable from provider dashboards / QR re-scan. |
| **Session transcripts** (`data/sessions/`) | `rsync -a` | **Can be large** (100s of MB). Per-group Claude conversation history (JSONL). Not recreatable. |
| **Mount allowlist** (`~/.config/nanoclaw/mount-allowlist.json`) | `cp` (chmod 600) | Small file. Agent filesystem access rules. Old backup may re-enable revoked paths. Avoids re-running `/setup` step 9. |

**Not backed up:** `groups/*/logs/` (bulky, recreatable), `node_modules/`, `dist/`, `data/env/` (derived from `.env`), `data/ipc/` (ephemeral).

## Flow

### 1. Detect Existing Config

Check if `scripts/backup.sh` already exists:

```bash
[ -f scripts/backup.sh ] && echo "EXISTS" || echo "NEW"
```

**If EXISTS:** AskUserQuestion with options:
- Reconfigure backup settings (regenerate script)
- Run a backup now (execute existing script)
- Show current config (display script header)

**If NEW:** Continue to step 2.

### 2. Ask Backup Destination

AskUserQuestion:

| Option | Description |
|--------|-------------|
| **Local directory** (Recommended) | Default: `~/nanoclaw-backups/`. Simple, no dependencies. |
| **External/mounted drive** | User provides the mount path (e.g., `/Volumes/Backup/nanoclaw/`) |
| **Cloud via rclone** | S3, Google Drive, Dropbox, etc. Requires rclone installed and configured. |

**If cloud:** Check `which rclone`. If missing, offer to install (`brew install rclone` on macOS, or direct to https://rclone.org/install/). Then ask for remote name — have user run `rclone listremotes` and pick one (or `rclone config` to set one up). Store as `CLOUD_REMOTE` (e.g., `gdrive:nanoclaw-backups`).

**For local/external:** Validate the path exists or offer to create it.

### 3. Ask Retention

AskUserQuestion: How many days of backups to keep?

| Option | Description |
|--------|-------------|
| **14 days** | Two weeks of daily restore points |
| **30 days** (Recommended) | Full month of coverage; good default for small data |
| **90 days** | Maximum safety net; catches slow-moving issues |

### 4. Ask Schedule

AskUserQuestion: When should daily backups run?

| Option | Description |
|--------|-------------|
| **3:00 AM** (Recommended) | Least likely to interfere with usage |
| **Midnight** | Start of day |
| **6:00 AM** | Early morning |

### 5. Ask About Optional Data

AskUserQuestion (multiSelect): Back up additional data?

| Option | Description |
|--------|-------------|
| **Credentials** | `.env` + `store/auth/` — API keys, OAuth tokens, WhatsApp device credentials. ⚠ Security-sensitive: if a backup is compromised, an attacker gains account access. Both are recreatable (API keys from provider dashboards, WhatsApp auth from QR re-scan). |
| **Session transcripts** | `data/sessions/` — per-group Claude conversation history (JSONL). Can be large (100s of MB). **Not recreatable** — your only record of agent conversations. |
| **Mount allowlist** | `~/.config/nanoclaw/mount-allowlist.json` — agent filesystem access rules. Small file, avoids re-running `/setup` step 9. ⚠ An old backup may re-enable filesystem paths that were revoked. |

All three are optional. If none selected, only core data (messages DB + groups) is backed up. Store selections as `BACKUP_CREDENTIALS=true/false`, `BACKUP_SESSIONS=true/false`, and `BACKUP_MOUNT_ALLOWLIST=true/false`.

### 6. Generate `scripts/backup.sh`

Ensure the directory exists, then create the script:

```bash
mkdir -p scripts
```

Create `scripts/backup.sh` with the collected config. The script must:

```bash
#!/bin/bash
# ─────────────────────────────────────────────────────────────
# NanoClaw Backup Script
# Generated by /backup skill on <DATE>
#
# Config:
#   Destination: <BACKUP_DEST>
#   Retention:   <RETENTION_DAYS> days
#   Cloud:       <CLOUD_REMOTE or "none">
#   Credentials: <yes or no>
#   Sessions:    <yes or no>
#   Allowlist:   <yes or no>
#
# RESTORE INSTRUCTIONS:
#   1. Stop NanoClaw:
#      macOS:  launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
#      Linux:  systemctl --user stop nanoclaw
#   2. Pick a backup:  ls <BACKUP_DEST>/nanoclaw-*
#   3. Restore database:
#      cp <backup>/messages.db store/messages.db
#   4. Restore groups:
#      rsync -a <backup>/groups/ groups/
#   5. (If backed up) Restore credentials:
#      rsync -a <backup>/auth/ store/auth/
#      cp <backup>/env .env
#      ⚠ Only restore credentials if you trust the backup source.
#      A compromised backup grants account access via API keys and WhatsApp auth.
#   6. (If backed up) Restore sessions:
#      rsync -a <backup>/sessions/ data/sessions/
#   7. (If backed up) Restore mount allowlist:
#      cp <backup>/config/mount-allowlist.json ~/.config/nanoclaw/mount-allowlist.json
#      chmod 600 ~/.config/nanoclaw/mount-allowlist.json
#      ⚠ Review the restored allowlist before starting NanoClaw.
#      An old backup may re-enable filesystem paths that were revoked.
#      Compare: diff ~/.config/nanoclaw/mount-allowlist.json <backup>/config/mount-allowlist.json
#   8. Start NanoClaw:
#      macOS:  launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
#      Linux:  systemctl --user start nanoclaw
#
#   If restoring from cloud, first download the backup:
#      rclone copy <CLOUD_REMOTE>/nanoclaw-<TIMESTAMP> /tmp/nanoclaw-restore
#      Then follow steps 3-7 using /tmp/nanoclaw-restore as <backup>.
# ─────────────────────────────────────────────────────────────
set -euo pipefail
umask 077

NANOCLAW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DEST="<user-chosen-path>"
RETENTION_DAYS=<N>
CLOUD_REMOTE="<remote:path or empty>"
BACKUP_CREDENTIALS=<true or false>
BACKUP_SESSIONS=<true or false>
BACKUP_MOUNT_ALLOWLIST=<true or false>
LOG_FILE="${NANOCLAW_DIR}/logs/backup.log"

# For external drives: check destination is mounted before proceeding
# (Only include this block if destination is an external/mounted drive)
if [ ! -d "$BACKUP_DEST" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: Backup destination not found: ${BACKUP_DEST}" | tee -a "$LOG_FILE" 2>/dev/null
  echo "Is the external drive mounted?"
  exit 1
fi

# Prevent concurrent backup runs (mkdir is atomic and portable across macOS/Linux)
LOCKDIR="${NANOCLAW_DIR}/.backup.lock"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "Another backup is running. Exiting."
  exit 0
fi

mkdir -p "$(dirname "$LOG_FILE")"

TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)
BACKUP_DIR="${BACKUP_DEST}/nanoclaw-${TIMESTAMP}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

# Clean up partial backup on failure, and always release lock
cleanup() {
  local exit_code=$?
  if [ $exit_code -ne 0 ]; then
    log "Backup failed — cleaning up partial backup"
    rm -rf "${BACKUP_DIR}"
  fi
  rm -rf "$LOCKDIR"
}
trap cleanup EXIT

log "Starting backup to ${BACKUP_DIR}"
mkdir -p "${BACKUP_DIR}"

# 1. SQLite online backup (safe while NanoClaw is running)
log "Backing up database..."
sqlite3 "${NANOCLAW_DIR}/store/messages.db" ".backup '${BACKUP_DIR}/messages.db'"

# Verify integrity
INTEGRITY=$(sqlite3 "${BACKUP_DIR}/messages.db" "PRAGMA integrity_check")
if [ "$INTEGRITY" != "ok" ]; then
  log "ERROR: Database integrity check failed: ${INTEGRITY}"
  exit 1
fi
log "Database integrity: ok"

# 2. Backup groups (excluding logs)
log "Backing up groups..."
rsync -a --exclude='logs/' "${NANOCLAW_DIR}/groups/" "${BACKUP_DIR}/groups/"

# 3. Backup credentials (if enabled)
if [ "$BACKUP_CREDENTIALS" = "true" ]; then
  if [ -d "${NANOCLAW_DIR}/store/auth" ]; then
    log "Backing up WhatsApp auth..."
    rsync -a "${NANOCLAW_DIR}/store/auth/" "${BACKUP_DIR}/auth/"
  fi
  if [ -f "${NANOCLAW_DIR}/.env" ]; then
    log "Backing up .env..."
    cp "${NANOCLAW_DIR}/.env" "${BACKUP_DIR}/env"
    chmod 600 "${BACKUP_DIR}/env"
  fi
fi

# 4. Backup Claude session transcripts (if enabled)
if [ "$BACKUP_SESSIONS" = "true" ] && [ -d "${NANOCLAW_DIR}/data/sessions" ]; then
  log "Backing up session transcripts..."
  rsync -a "${NANOCLAW_DIR}/data/sessions/" "${BACKUP_DIR}/sessions/"
fi

# 5. Backup mount allowlist (if enabled)
if [ "$BACKUP_MOUNT_ALLOWLIST" = "true" ]; then
  ALLOWLIST="${HOME}/.config/nanoclaw/mount-allowlist.json"
  if [ -f "$ALLOWLIST" ]; then
    log "Backing up mount allowlist..."
    mkdir -p "${BACKUP_DIR}/config"
    cp "$ALLOWLIST" "${BACKUP_DIR}/config/mount-allowlist.json"
  fi
fi

# 6. Cloud sync (if configured)
if [ -n "$CLOUD_REMOTE" ]; then
  log "Syncing to cloud: ${CLOUD_REMOTE}"
  rclone copy "${BACKUP_DIR}" "${CLOUD_REMOTE}/nanoclaw-${TIMESTAMP}" --log-level INFO
  log "Cloud sync complete"
fi

# 7. Retention cleanup (local)
log "Cleaning local backups older than ${RETENTION_DAYS} days..."
find "${BACKUP_DEST}" -maxdepth 1 -name "nanoclaw-*" -type d -mtime +${RETENTION_DAYS} -exec rm -rf {} +

# 8. Retention cleanup (cloud, if configured)
if [ -n "$CLOUD_REMOTE" ]; then
  log "Cleaning cloud backups older than ${RETENTION_DAYS} days..."
  rclone delete "${CLOUD_REMOTE}" --min-age "${RETENTION_DAYS}d" --log-level INFO 2>&1 | tee -a "$LOG_FILE" || true
fi

log "Backup complete: ${BACKUP_DIR}"
```

**Important:**
- Replace all placeholder values (`<user-chosen-path>`, `<N>`, `<remote:path or empty>`, `<true or false>`) with the actual user config.
- If `CLOUD_REMOTE` is empty (no cloud), replace the cloud sync block with a comment noting it's disabled.
- If destination is **not** an external drive, remove the mount-check block at the top.
- If `BACKUP_CREDENTIALS` is false, remove the credentials backup block (auth + .env). Same for `BACKUP_SESSIONS` and `BACKUP_MOUNT_ALLOWLIST`.
- The script uses `mkdir`-based locking (not `flock`) because `flock` is not available on macOS.

After writing the file:

```bash
chmod +x scripts/backup.sh
```

### 7. Set Up Scheduling

Detect platform:

```bash
[[ "$(uname)" == "Darwin" ]] && echo "macos" || echo "linux"
```

#### macOS — launchd

Create `~/Library/LaunchAgents/com.nanoclaw.backup.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.backup</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string><NANOCLAW_DIR>/scripts/backup.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string><NANOCLAW_DIR></string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer><HOUR></integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string><NANOCLAW_DIR>/logs/backup.log</string>
    <key>StandardErrorPath</key>
    <string><NANOCLAW_DIR>/logs/backup.error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
```

Replace `<NANOCLAW_DIR>` with the absolute project path and `<HOUR>` with the chosen hour (e.g., 3 for 3 AM).

**If rclone is used**, add rclone's path to the PATH environment variable (find it with `which rclone`).

Load the schedule:

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.backup.plist
```

If it was already loaded (reconfigure flow), unload first:

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.backup.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.nanoclaw.backup.plist
```

#### Linux — cron

Add a crontab entry:

```bash
(crontab -l 2>/dev/null | grep -v 'nanoclaw.*backup'; echo "0 <HOUR> * * * <NANOCLAW_DIR>/scripts/backup.sh >> <NANOCLAW_DIR>/logs/backup.log 2>&1") | crontab -
```

Replace `<HOUR>` and `<NANOCLAW_DIR>` with actual values.

### 8. Run First Backup

Execute immediately to verify:

```bash
bash scripts/backup.sh
```

**If it fails:** Read the error output, fix the issue (missing sqlite3, permission denied, path doesn't exist), and re-run. Common fixes:
- `sqlite3: command not found` → install: `brew install sqlite3` (macOS) or `sudo apt-get install sqlite3` (Linux)
- Permission denied on destination → check path and create parent dirs
- rclone not configured → run `rclone config`

### 9. Verify and Report

After successful first backup, verify and report to the user:

```bash
# Show backup contents
ls -la <BACKUP_DIR>/

# Verify DB integrity
sqlite3 <BACKUP_DIR>/messages.db "PRAGMA integrity_check"

# Show backup size
du -sh <BACKUP_DIR>/
```

Print a summary:

```
Backup configured successfully!

  Location:  <BACKUP_DEST>
  Schedule:  Daily at <TIME>
  Retention: <N> days
  Cloud:     <CLOUD_REMOTE or "none">

  First backup: <BACKUP_DIR> (<SIZE>)

  To run manually:  bash scripts/backup.sh
  To restore:       See comments at top of scripts/backup.sh

  Logs: logs/backup.log
```

## Uninstalling

If the user wants to remove backup scheduling:

**macOS:**
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.backup.plist
rm ~/Library/LaunchAgents/com.nanoclaw.backup.plist
```

**Linux:**
```bash
crontab -l | grep -v 'nanoclaw.*backup' | crontab -
```

The script at `scripts/backup.sh` and existing backups are preserved — user can delete them manually.
