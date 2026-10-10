#!/usr/bin/env bash
# PULSE — выгрузка nightly-бэкапов в S3 (ТЗ-152).
# cron: 15 3 * * * /opt/pulse/pulse/scripts/backup/s3-upload-backup.sh >> /opt/pulse/logs/s3-upload.log 2>&1
#
# Что выгружается (в s3://<bucket>/pulse/):
#   nightly-*.sql.gz (+ .sha256)  — свежий дамп БД, дата в имени, не перезаписывается
#   files-*.tar.gz   (+ .sha256)  — пользовательские файлы (uploads/music/sfx)
#   env-backup-<дата>             — /opt/pulse/.env, версионируется, держим последние 5
#
# Креды НЕ хранятся в скрипте: профиль pulse-s3 читает ~/.aws/credentials
# (chmod 600). Ротация объектов старше 30 дней — lifecycle-правило бакета
# (см. DEPLOYMENT.md, ТЗ-152 задача 4); env-backup-* подчищаем здесь (≥5 шт).
#
# Telegram-маячок (ТЗ-152 задача 6) намеренно выключен: nit с доступом к
# токенам из incident-watch.sh закрыт не до конца — не плодим второе место
# с кредами. Включать после закрытия nit, по образцу incident-watch.sh.
set -euo pipefail

ENDPOINT="https://s3.ru1.storage.beget.cloud"   # ТЗ-152: endpoint хостера
BUCKET="s3://0fa1c3a824ae-pulses3/pulse"
PROFILE="pulse-s3"
BACKUP_DIR=/opt/pulse/backups
ENV_SRC=/opt/pulse/.env
ENV_KEEP=5   # сколько версий env-backup-* держим в S3

AWS="aws --endpoint-url $ENDPOINT --profile $PROFILE"

LATEST_DB=$(ls -t "$BACKUP_DIR"/nightly-*.sql.gz 2>/dev/null | head -1 || true)
LATEST_FILES=$(ls -t "$BACKUP_DIR"/files-*.tar.gz 2>/dev/null | head -1 || true)

if [ -z "$LATEST_DB" ]; then
  echo "ERROR: $BACKUP_DIR/nightly-*.sql.gz не найден"
  exit 1
fi

# Бэкапы файлов и .env — опциональны (предупреждаем, но не падаем)
[ -z "$LATEST_FILES" ] && echo "WARN: files-*.tar.gz не найден, выгружаем только БД"
[ -f "$ENV_SRC" ] || echo "WARN: $ENV_SRC не найден, выгружаем без секретов"

# Контрольные суммы рядом с файлами (идемпотентно — если nightly-скрипт уже сделал)
for f in "$LATEST_DB" "$LATEST_FILES"; do
  [ -n "$f" ] && [ -f "$f" ] && [ ! -f "${f}.sha256" ] && sha256sum "$f" > "${f}.sha256"
done

# ── Выгрузка дампа + файлов (+ sidecar .sha256) ─────────────────────────────
for f in "$LATEST_DB" "$LATEST_FILES"; do
  [ -n "$f" ] && [ -f "$f" ] || continue
  $AWS s3 cp "$f" "$BUCKET/"
  [ -f "${f}.sha256" ] && $AWS s3 cp "${f}.sha256" "$BUCKET/"
done

# ── .env — версионируемый объект (не перезаписываем один и тот же) ───────────
STAMP=$(date +%F)
if [ -f "$ENV_SRC" ]; then
  $AWS s3 cp "$ENV_SRC" "$BUCKET/env-backup-$STAMP"
  # Ротация версий env: держим последние $ENV_KEEP
  $AWS s3 ls "$BUCKET/" | awk '/env-backup-/ {print $4}' | sort | head -n -$ENV_KEEP \
    | xargs -r -I{} $AWS s3 rm "$BUCKET/{}"
fi

DB_SIZE=$(du -h "$LATEST_DB" | cut -f1)
echo "$(date '+%F %T') S3 upload ok: $(basename "$LATEST_DB") ($DB_SIZE) + files + env-backup-$STAMP"

# ── Telegram-маячок — ВЫКЛЮЧЕН до закрытия nit по кредам (ТЗ-152 задача 6) ──
# source /opt/pulse/.env
# curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
#   -d chat_id="${TELEGRAM_ADMIN_CHAT_ID}" \
#   --data-urlencode text="S3 backup ok: $(basename "$LATEST_DB") ($DB_SIZE, sha ок)" >/dev/null
