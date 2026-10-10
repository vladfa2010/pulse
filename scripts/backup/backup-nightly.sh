#!/bin/bash
# PULSE — ночной бэкап БД и файловых volume.
# pg_dump БД pulse + tar uploads/music/sfx. Ротация: 3 daily, 2 weekly (пн).
# cron: 30 2 * * * /opt/pulse/backup-nightly.sh >> /opt/pulse/logs/backup.log 2>&1
# На хосте /opt/pulse/backup-nightly.sh — симлинк на этот файл из git-клона
# (ТЗ-152 задача 1).
set -uo pipefail

BACKUP_DIR=/opt/pulse/backups
LOG_PREFIX="[backup $(date '+%F %T')]"
mkdir -p "$BACKUP_DIR"

STAMP=$(date +%F)
DAILY_DB="$BACKUP_DIR/nightly-$STAMP.sql.gz"
DAILY_FILES="$BACKUP_DIR/files-$STAMP.tar.gz"

# ── 1. База данных ──────────────────────────────────────────────────────────
echo "$LOG_PREFIX pg_dump started"
if docker compose -f /opt/pulse/docker-compose.yml exec -T postgres \
     pg_dump -U pulse_user pulse 2>/tmp/pg_dump.err | gzip > "$DAILY_DB"; then
  SIZE=$(du -h "$DAILY_DB" | cut -f1)
  echo "$LOG_PREFIX pg_dump OK: $DAILY_DB ($SIZE)"
else
  echo "$LOG_PREFIX pg_dump FAILED: $(cat /tmp/pg_dump.err)"
  rm -f "$DAILY_DB"
fi

# ── 2. Файлы (uploads, музыка, sfx) ─────────────────────────────────────────
echo "$LOG_PREFIX files tar started"
if tar -czf "$DAILY_FILES" -C /opt/pulse uploads music sfx 2>/tmp/tar.err; then
  SIZE=$(du -h "$DAILY_FILES" | cut -f1)
  echo "$LOG_PREFIX files OK: $DAILY_FILES ($SIZE)"
else
  echo "$LOG_PREFIX files tar FAILED: $(cat /tmp/tar.err)"
  rm -f "$DAILY_FILES"
fi

# ── 3. Weekly-копия по понедельникам ────────────────────────────────────────
if [ "$(date +%u)" = "1" ] && [ -f "$DAILY_DB" ]; then
  cp "$DAILY_DB" "$BACKUP_DIR/weekly-$STAMP.sql.gz"
  echo "$LOG_PREFIX weekly copy created"
fi

# ── 4. Ротация: daily 3 шт, weekly 2 шт ────────────────────────────────────
ls -1t "$BACKUP_DIR"/nightly-*.sql.gz 2>/dev/null | tail -n +4 | xargs -r rm -f
ls -1t "$BACKUP_DIR"/files-*.tar.gz   2>/dev/null | tail -n +4 | xargs -r rm -f
ls -1t "$BACKUP_DIR"/weekly-*.sql.gz  2>/dev/null | tail -n +3 | xargs -r rm -f

# ── 5. Контрольные суммы (ТЗ-152): для выгрузки в S3 и restore-проверок ──────
[ -f "$DAILY_DB" ] && sha256sum "$DAILY_DB" > "$DAILY_DB.sha256"
[ -f "$DAILY_FILES" ] && sha256sum "$DAILY_FILES" > "$DAILY_FILES.sha256"

FREE=$(df -h / | awk 'NR==2{print $4}')
echo "$LOG_PREFIX done. Free disk: $FREE"
