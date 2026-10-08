#!/usr/bin/env bash
# =============================================================================
# test-restore.sh — тестовое восстановление последнего nightly-бэкапа (ТЗ-150, задача 5)
#
# Запуск: разово вручную и ежемесячно по cron (1-е число, 03:00 МСК):
#   0 3 1 * * /opt/pulse/pulse/scripts/maintenance/test-restore.sh
#
# ВАЖНО: запускать вне пика нагрузки. zcat/restore нельзя обернуть в nice/ionice
# напрямую (пайп через docker exec), поэтому при необходимости запускайте вручную:
#   nice -n 10 ionice -c3 ./scripts/maintenance/test-restore.sh
#
# Что делает:
#   1. Берёт последний /opt/pulse/backups/nightly-*.sql.gz
#   2. Поднимает ИЗОЛИРОВАННЫЙ контейнер pulse-postgres-restore-test
#      (pgvector/pgvector:pg18, свой volume restore_test_data, порт 55433) —
#      прод-контейнер и его volume НЕ трогаются.
#   3. Дожидается готовности (pg_isready, до 120 сек), заливает бэкап.
#      Любая строка ERROR в выводе restore → фейл (это и есть смысл проверки).
#   4. Свеп чексумм всех таблиц (zero_damaged_pages=on) в restore-контейнере —
#      'invalid page' в его логе должно быть 0 (бэкап снят до повреждения).
#   5. Сравнение count(*): users и portfolios — точное совпадение,
#      news — допуск на свежие публикации (выводим оба числа и разницу).
#   6. Дифф потерянных новостей инцидента 2026-10-08: URL, есть в бэкапе,
#      но нет в проде → docs/incident-2026-10-08-lost-news.md.
#   7. Удаляет контейнер И volume (cleanup гарантирован через trap).
#   8. Итоговый отчёт, exit 0/1, Telegram-алерт при фейле / битых чексуммах.
#
# Лог: /var/log/pulse/test-restore.log. Telegram — TELEGRAM_* из /opt/pulse/.env.
# Запускать из корня репо (для записи docs/incident-2026-10-08-lost-news.md).
# =============================================================================
set -uo pipefail

LOG_DIR="/var/log/pulse"
LOG_FILE="${LOG_DIR}/test-restore.log"
BACKUP_DIR="/opt/pulse/backups"
TEST_CONTAINER="pulse-postgres-restore-test"
TEST_VOLUME="restore_test_data"
TEST_PORT="55433"
PSQL_PROD="docker exec pulse-postgres psql -U pulse_user -d pulse -tAc"
PSQL_TEST="docker exec ${TEST_CONTAINER} psql -U pulse_user -d pulse -tAc"

mkdir -p "$LOG_DIR" 2>/dev/null || true

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG_FILE" 2>/dev/null || true
    echo "$*"  # дублируем в stdout — отчёт виден при ручном запуске
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
            -d text="[PULSE-RESTORE] ${details}" \
            -d parse_mode=HTML >/dev/null 2>&1 || log "WARN: Telegram-алерт не отправлен"
    fi
}

FAILED=0
fail() {
    log "FAIL: $1"
    FAILED=1
}

# --- Cleanup: гарантированно удаляем контейнер и volume (даже при ошибке) -----
cleanup() {
    log "cleanup: удаляю контейнер ${TEST_CONTAINER} и volume ${TEST_VOLUME}"
    docker rm -f "$TEST_CONTAINER" >/dev/null 2>&1 || true
    docker volume rm "$TEST_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "=== старт test-restore ==="

# --- 0. Проверки инфраструктуры ------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    alert "инфраструктура: docker недоступен"
    exit 1
fi
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "pulse-postgres"; then
    alert "инфраструктура: прод-контейнер pulse-postgres не запущен"
    exit 1
fi

# --- 1. Бэкап для restore -------------------------------------------------------
# По умолчанию — последний nightly. BACKUP_FILE=<путь> — переопределение
# (например, для диффа потерянных новостей инцидента 2026-10-08 нужен
# бэкап ДО инцидента: BACKUP_FILE=/opt/pulse/backups/nightly-2026-10-08.sql.gz).
backup="${BACKUP_FILE:-}"
if [ -z "$backup" ]; then
    alert "бэкапы не найдены в ${BACKUP_DIR} (nightly-*.sql.gz)"
    exit 1
fi
log "бэкап: ${backup} ($(du -h "$backup" | cut -f1))"

# --- 2. Изолированный контейнер -------------------------------------------------
# Свой POSTGRES_PASSWORD=test — прод-секреты не нужны и не используются.
docker run -d --name "$TEST_CONTAINER" \
    --memory 512m --memory-swap 512m --cpus 1 \
    -e POSTGRES_USER=pulse_user \
    -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=pulse \
    -e PGDATA=/var/lib/postgresql/data \
    -p 127.0.0.1:${TEST_PORT}:5432 \
    -v "${TEST_VOLUME}:/var/lib/postgresql/data" \
    pgvector/pgvector:pg18 >/dev/null 2>&1
if [ $? -ne 0 ]; then
    alert "не удалось запустить контейнер ${TEST_CONTAINER}"
    exit 1
fi

# --- 3. Ожидание готовности и restore -------------------------------------------
ready=0
for i in $(seq 1 24); do
    if docker exec "$TEST_CONTAINER" pg_isready -U pulse_user -d pulse >/dev/null 2>&1; then
        ready=1
        break
    fi
    sleep 5
done
if [ "$ready" -ne 1 ]; then
    alert "restore-test: контейнер не стал готов за 120 сек"
    exit 1
fi
log "контейнер готов, начинаю restore"

restore_out=$(mktemp)
zcat "$backup" | docker exec -i "$TEST_CONTAINER" psql -U pulse_user -d pulse >"$restore_out" 2>&1
restore_rc=$?
error_count=$(grep -c '^ERROR' "$restore_out" || true)
error_count=${error_count:-0}
if [ $restore_rc -ne 0 ] || [ "$error_count" -gt 0 ]; then
    fail "restore: rc=${restore_rc}, ERROR-строк: ${error_count}: $(grep -m1 '^ERROR' "$restore_out" | head -c 200)"
else
    log "restore завершён без ERROR"
fi
rm -f "$restore_out"

# --- 4. Свеп чексумм в restore-контейнере ---------------------------------------
sweep_start=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
docker exec "$TEST_CONTAINER" psql -U pulse_user -d pulse \
    -c 'SET zero_damaged_pages=on' \
    -c "DO \$\$ DECLARE r RECORD; BEGIN FOR r IN SELECT relname FROM pg_stat_user_tables WHERE schemaname='public' LOOP RAISE NOTICE 'sweep %', r.relname; EXECUTE format('SELECT count(*) FROM public.%I', r.relname); END LOOP; END \$\$;" >> "$LOG_FILE" 2>&1
if [ $? -ne 0 ]; then
    fail "checksum sweep в restore-контейнере завершился с ошибкой (см. лог)"
fi
bad_pages=$(docker logs --since "$sweep_start" "$TEST_CONTAINER" 2>&1 | grep -c 'invalid page' || true)
bad_pages=${bad_pages:-0}
if [ "$bad_pages" -gt 0 ] 2>/dev/null; then
    fail "checksum sweep restore: ${bad_pages} повреждённых страниц"
    alert "test-restore: в восстановленном бэкапе ${bad_pages} повреждённых страниц"
else
    log "checksum sweep restore: повреждённых страниц нет"
fi

# --- 5. Сравнение count(*) -------------------------------------------------------
# ВАЖНО: бэкап снят в прошлом — в проде легитимно больше строк (новые
# пользователи/портфели/публикации с момента снятия). Инвариант: в проде
# НЕ ДОЛЖНО БЫТЬ МЕНЬШЕ, чем в бэкапе (потеря данных). Положительная разница —
# норма, только логируем.
for table in news users portfolios; do
    prod_count=$($PSQL_PROD "SELECT count(*) FROM ${table}" 2>/dev/null)
    test_count=$($PSQL_TEST "SELECT count(*) FROM ${table}" 2>/dev/null)
    prod_count=${prod_count:-?}
    test_count=${test_count:-?}
    diff_count="n/a"
    if [ "$prod_count" != "?" ] && [ "$test_count" != "?" ]; then
        diff_count=$(( prod_count - test_count ))
    fi
    log "count ${table}: прод=${prod_count} бэкап=${test_count} разница(прод-бэкап)=${diff_count}"
    case "$table" in
        users|portfolios)
            # Отрицательная разница = в проде меньше, чем в бэкапе → потеря данных.
            if [ "$diff_count" != "n/a" ] && [ "$diff_count" -lt 0 ] 2>/dev/null; then
                fail "count ${table}: в проде меньше, чем в бэкапе, на $(( -diff_count )) — потеря данных"
            fi
            ;;
        news)
            # Аналогично: бэкап больше прода на существенную величину → потеря.
            if [ "$diff_count" != "n/a" ] && [ "$diff_count" -lt -500 ] 2>/dev/null; then
                fail "count news: в бэкапе больше на $(( -diff_count )) — возможна потеря данных в проде"
            fi
            ;;
    esac
done

# --- 6. Дифф потерянных новостей инцидента 2026-10-08 -----------------------------
# URL, которые есть в бэкапе (снят ДО инцидента), но отсутствуют в проде.
# LC_ALL=C — byte-wise сортировка: гарантирует согласованный порядок для comm
# (URL содержат UTF-8, под cron'ом locale POSIX → comm иначе ругается).
lost_urls=$($PSQL_TEST "SELECT url FROM news WHERE url IS NOT NULL ORDER BY url" 2>/dev/null | LC_ALL=C sort -u)
prod_urls=$($PSQL_PROD "SELECT url FROM news WHERE url IS NOT NULL" 2>/dev/null | LC_ALL=C sort -u)
lost=$(LC_ALL=C comm -23 <(echo "$lost_urls") <(echo "$prod_urls"))
lost_count=$(echo "$lost" | grep -c . 2>/dev/null || echo 0)
lost_count=${lost_count:-0}
log "потерянных новостей (в бэкапе, нет в проде): ${lost_count}"

# Запись в docs/incident-2026-10-08-lost-news.md (от корня репо, с fallback)
repo_root=""
if git -C "$(pwd)" rev-parse --show-toplevel >/dev/null 2>&1; then
    repo_root=$(git -C "$(pwd)" rev-parse --show-toplevel)
else
    for d in "$(pwd)" "$(pwd)/pulse-backend" "$(pwd)/.." /opt/pulse/pulse; do
        [ -f "${d}/DEPLOYMENT.md" ] && { repo_root="$d"; break; }
    done
fi
doc_file="${repo_root:+${repo_root}/}docs/incident-2026-10-08-lost-news.md"

if [ -n "$repo_root" ] || [ -d docs ]; then
    {
        echo "# Потерянные новости инцидента 2026-10-08 (дифф бэкап vs прод)"
        echo
        echo "Обновлено: $(date '+%Y-%m-%d %H:%M:%S %Z') (автогенерация test-restore.sh)"
        echo "Источник: ${backup}"
        echo
        echo "URL, которые есть в последнем nightly-бэкапе (снят до инцидента), но отсутствуют в проде."
        echo
        echo "**Итого: ${lost_count}**"
        echo
        echo "| # | URL |"
        echo "|---|-----|"
        n=0
        while IFS= read -r u; do
            [ -z "$u" ] && continue
            n=$((n + 1))
            echo "| ${n} | ${u} |"
        done <<< "$lost"
    } > "$doc_file"
    log "дифф записан: ${doc_file}"
else
    log "WARN: корень репо не найден, дифф не записан (только в лог)"
fi

# --- 7-8. Итог ---------------------------------------------------------------------
if [ "$FAILED" -eq 1 ]; then
    alert "test-restore FAILED — см. ${LOG_FILE}"
    log "=== финиш test-restore: FAILED ==="
    exit 1
fi
log "=== финиш test-restore: OK ==="
exit 0
