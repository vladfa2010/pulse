#!/bin/bash
# =============================================================================
# Backfill Watchdog (ТЗ-162)
# Поднимает воркеров бэкфилла эмбеддингов, если их нет.
#
# Зачем: воркеры (docker exec -d ... backfillEmbeddings.ts) живут ВНУТРИ
# контейнера pulse-backend и погибают при любом пересоздании контейнера
# (деплой: docker compose up -d --build backend). Без watchdog прогон
# простаивает до ручного/почасового перезапуска.
#
# Установка (хост VPS):
#   crontab -e  →  */5 * * * * /opt/pulse/backfill-watchdog.sh
#
# Лог: /opt/pulse/backfill-watchdog.log (записи только о действиях, молчание = ок)
# =============================================================================
set -u

BACKEND_CONTAINER=pulse-backend
POSTGRES_CONTAINER=pulse-postgres
TEI_CONTAINER=pulse-embeddings
PSQL="docker exec $POSTGRES_CONTAINER psql -U pulse_user -d pulse -tA -c"
LOG=/opt/pulse/backfill-watchdog.log
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

log() { echo "$TS $1" >> "$LOG"; }

# 1. Бэкенд должен работать
if ! docker ps --format '{{.Names}}' | grep -q "^${BACKEND_CONTAINER}$"; then
  log "backend container not running — skip"
  exit 0
fi

# 2. Не трогаем свежепересозданный бэкенд (прогрев ~3 мин: миграции, подключение к БД)
STARTED=$(docker inspect -f '{{.State.StartedAt}}' "$BACKEND_CONTAINER" 2>/dev/null)
STARTED_EPOCH=$(date -u -d "$STARTED" +%s 2>/dev/null || echo "")
NOW=$(date -u +%s)
if [ -n "$STARTED_EPOCH" ] && [ $((NOW - STARTED_EPOCH)) -lt 300 ]; then
  log "backend warming up (started $STARTED) — skip"
  exit 0
fi

# 3. Проверяем остаток работы — если бэкфилл завершён, ничего не делаем
MISSING=$($PSQL "SELECT count(*) FROM news WHERE embedding IS NULL AND (title_ru IS NOT NULL OR title_original IS NOT NULL)" 2>/dev/null | tr -d '[:space:]')
if [ -z "$MISSING" ]; then
  log "psql error — skip"
  exit 0
fi
if [ "$MISSING" -eq 0 ]; then
  log "backfill complete (missing=0) — nothing to do"
  exit 0
fi

# 4. Живы ли воркеры (sh-обёртка видна в ps сразу после spawn)
WORKERS=$(docker exec "$BACKEND_CONTAINER" sh -c 'ps aux | grep backfillEmbeddings | grep -v grep | wc -l' 2>/dev/null | tr -d '[:space:]')
if [ -n "$WORKERS" ] && [ "$WORKERS" -gt 0 ]; then
  exit 0
fi

# 5. TEI-лимиты сбрасываются при пересоздании контейнера — восстанавливаем.
#    Целевые: 1 CPU / 9GB — постоянная конфигурация системы (решение
#    владельца 14.10.2026): TEI ограничен 1 ядром, как до апгрейда сервера,
#    чтобы не отнимать CPU у сайта. RAM 9GB: лимиты 5-6GB давали OOM
#    (exit 137, crash-loop при старте, факт 14.10); фактический resident
#    ~2.5-4GB, но пиковые аллокации candle при старте непредсказуемы.
#    Режим: дожим свежих новостей + поисковые запросы (на 1 ядре батч
#    32 текста ~2-3 мин — для дожима приемлемо).
CPUS=$(docker inspect -f '{{.HostConfig.NanoCpus}}' "$TEI_CONTAINER" 2>/dev/null)
MEM=$(docker inspect -f '{{.HostConfig.Memory}}' "$TEI_CONTAINER" 2>/dev/null)
if [ "$CPUS" != "1000000000" ] || [ "$MEM" != "9663676416" ]; then
  docker update --cpus 1 --memory 9g --memory-swap 9g "$TEI_CONTAINER" >/dev/null 2>&1
  log "TEI limits restored (was cpus=$CPUS mem=$MEM)"
fi

# 6. Поднимаем двух воркеров (партиции id % 2)
docker exec -d "$BACKEND_CONTAINER" sh -c "BACKFILL_BATCH_SIZE=32 BACKFILL_MOD=2 BACKFILL_REM=0 npx ts-node --transpile-only src/scripts/backfillEmbeddings.ts > /tmp/backfill-rem0.log 2>&1"
docker exec -d "$BACKEND_CONTAINER" sh -c "BACKFILL_BATCH_SIZE=32 BACKFILL_MOD=2 BACKFILL_REM=1 npx ts-node --transpile-only src/scripts/backfillEmbeddings.ts > /tmp/backfill-rem1.log 2>&1"
log "workers restarted (missing=$MISSING)"
