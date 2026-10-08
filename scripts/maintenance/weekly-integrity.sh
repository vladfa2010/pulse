#!/usr/bin/env bash
# =============================================================================
# weekly-integrity.sh — еженедельная проверка целостности БД PULSE (ТЗ-150, задача 4)
#
# Запуск: воскресенье ~04:00 МСК, root crontab:
#   0 4 * * 0 /opt/pulse/pulse/scripts/maintenance/weekly-integrity.sh
#
# Что делает:
#   1. CREATE EXTENSION IF NOT EXISTS amcheck;
#   2. bt_index_check() для КАЖДОГО btree-индекса таблицы news
#      (HNSW pgvector amcheck не поддерживает — не трогаем, GIN не трогаем).
#      Любая ошибка → Telegram [PULSE-INTEGRITY] amcheck failed: <индекс> — <ошибка>
#   3. Свеп контрольных сумм ВСЕХ пользовательских таблиц (read-only):
#      SET zero_damaged_pages=on + SELECT count(*) по каждой таблице
#      (битые страницы обнуляются только в памяти, на диск не пишутся).
#      Предупреждения zero_damaged_pages уходят в лог контейнера postgres —
#      считаем 'invalid page' с момента старта свипа; ненулевое → алерт
#      [PULSE-INTEGRITY] checksum sweep: N повреждённых страниц.
#
# Лог: /var/log/pulse/weekly-integrity.log. Telegram — TELEGRAM_* из /opt/pulse/.env.
# Exit 0 всегда. См. docs/incident-2026-10-08-corrupt-news-aio.md.
# =============================================================================
set -uo pipefail

LOG_DIR="/var/log/pulse"
LOG_FILE="${LOG_DIR}/weekly-integrity.log"
CONTAINER="pulse-postgres"
PSQL="docker exec ${CONTAINER} psql -U pulse_user -d pulse -tAc"

mkdir -p "$LOG_DIR" 2>/dev/null || true

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG_FILE" 2>/dev/null || true
}

# --- Загрузка токенов Telegram ------------------------------------------------
set -a
[ -f /opt/pulse/.env ] && . /opt/pulse/.env
set +a

alert() {
    local details="$1"
    log "ALERT: ${details}"
    if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_ADMIN_CHAT_ID:-}" ]; then
        curl -s -m 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            -d chat_id="${TELEGRAM_ADMIN_CHAT_ID}" \
            -d text="[PULSE-INTEGRITY] ${details}" \
            -d parse_mode=HTML >/dev/null 2>&1 || log "WARN: Telegram-алерт не отправлен"
    else
        log "WARN: TELEGRAM_* не заданы в /opt/pulse/.env, алерт только в лог"
    fi
}

log "=== старт weekly-integrity ==="

# --- Проверка инфраструктуры ---------------------------------------------------
if ! command -v docker >/dev/null 2>&1 || ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
    alert "инфраструктура: docker или контейнер ${CONTAINER} недоступны"
    log "=== финиш (инфраструктура недоступна) ==="
    exit 0
fi

# --- Шаг 1: расширения amcheck и pg_stat_statements ---------------------------
if ! docker exec "$CONTAINER" psql -U pulse_user -d pulse -c 'CREATE EXTENSION IF NOT EXISTS amcheck;' >/dev/null 2>&1; then
    alert "amcheck: не удалось создать расширение (уже установлено? нет прав?)"
    log "WARN: CREATE EXTENSION amcheck не выполнен"
fi
# pg_stat_statements: библиотека подключена через shared_preload_libraries
# (docker-compose.yml, ТЗ-150 задача 6) — здесь только создаём расширение.
if ! docker exec "$CONTAINER" psql -U pulse_user -d pulse -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;' >/dev/null 2>&1; then
    log "WARN: CREATE EXTENSION pg_stat_statements не выполнен"
fi

# --- Шаг 2: bt_index_check по каждому btree-индексу таблицы news ----------------
# HNSW (pgvector) и GIN amcheck не поддерживают — фильтруем по amname='btree'.
indexes=$($PSQL "SELECT i.indexrelid::regclass::text || '|' || i.indexrelid FROM pg_index i JOIN pg_class a ON a.oid=i.indexrelid JOIN pg_am ON pg_am.oid=a.relam WHERE i.indrelid='news'::regclass AND pg_am.amname='btree'" 2>/dev/null)
if [ -z "$indexes" ]; then
    log "WARN: btree-индексы таблицы news не найдены"
else
    checked=0
    while IFS='|' read -r idx_name idx_oid; do
        [ -z "$idx_oid" ] && continue
        err=$(docker exec "$CONTAINER" psql -U pulse_user -d pulse -c "SELECT bt_index_check(${idx_oid});" 2>&1 >/dev/null)
        if [ $? -ne 0 ] || echo "$err" | grep -q 'ERROR'; then
            alert "amcheck failed: ${idx_name} — $(echo "$err" | grep -m1 'ERROR' | head -c 300)"
        else
            checked=$((checked + 1))
        fi
    done <<< "$indexes"
    log "amcheck: проверено btree-индексов news: ${checked}"
fi

# --- Шаг 3: свеп контрольных сумм всех пользовательских таблиц -------------------
# zero_damaged_pages=on: при встрече битой страницы чтение продолжается с нулевой
# страницей (только в памяти текущей сессии, WAL не пишется).
sweep_start=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

docker exec "$CONTAINER" psql -U pulse_user -d pulse \
    -c 'SET zero_damaged_pages=on' \
    -c "DO \$\$ DECLARE r RECORD; BEGIN FOR r IN SELECT relname FROM pg_stat_user_tables WHERE schemaname='public' LOOP RAISE NOTICE 'sweep %', r.relname; EXECUTE format('SELECT count(*) FROM public.%I', r.relname); END LOOP; END \$\$;" \
    >> "$LOG_FILE" 2>&1
psql_rc=$?
if [ $psql_rc -ne 0 ]; then
    alert "checksum sweep: сам свип завершился с ошибкой (rc=${psql_rc}), см. лог"
fi

# Предупреждения zero_damaged_pages идут в лог контейнера — считаем их.
bad_pages=$(docker logs --since "$sweep_start" "$CONTAINER" 2>&1 | grep -c 'invalid page' || true)
bad_pages=${bad_pages:-0}
if [ "$bad_pages" -gt 0 ] 2>/dev/null; then
    alert "checksum sweep: ${bad_pages} повреждённых страниц"
else
    log "checksum sweep: повреждённых страниц нет"
fi

log "=== финиш weekly-integrity ==="
exit 0
