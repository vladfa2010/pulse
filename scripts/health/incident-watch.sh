#!/usr/bin/env bash
# =============================================================================
# incident-watch.sh — пост-инцидентный мониторинг PULSE (ТЗ-150, задача 3)
#
# Запуск: каждую минуту с прод-хоста, root crontab:
#   * * * * * /opt/pulse/pulse/scripts/health/incident-watch.sh
#
# Проверяет 4 условия (см. docs/incident-2026-10-08-corrupt-news-aio.md):
#   1. Зависшие IO/IPC-запросы в PostgreSQL (>60 сек в active)
#   2. io worker'ы postgres на >50% CPU (симптом зависшего io_uring)
#   3. Свежие повреждения страниц в логе контейнера postgres
#   4. p95 замер логина через curl (>5 сек или недоступность)
# Плюс дедуплицированный алерт при падении инфраструктуры (docker/psql).
#
# Алерты: Telegram (TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID из /opt/pulse/.env),
# формат: [PULSE-WATCH] <условие>: <детали>.
# Дедупликация: не чаще 1 алерта на условие за 30 минут (state-файлы в STATE_DIR).
# Exit 0 всегда (крон не должен слать письма). Лог: /var/log/pulse/incident-watch.log
# =============================================================================
set -uo pipefail

# --- Пути и константы ---------------------------------------------------------
LOG_DIR="/var/log/pulse"
LOG_FILE="${LOG_DIR}/incident-watch.log"
STATE_DIR="/var/lib/pulse-watch"
DEDUP_SECONDS=1800          # 30 минут между повторными алертами одного условия
CONTAINER="pulse-postgres"
LOGIN_URL="https://pulse.inside-trade.ru/api/auth/login"
LOGIN_THRESHOLD_SEC="5"

mkdir -p "$LOG_DIR" "$STATE_DIR" 2>/dev/null || true

# --- Логирование (короткие строки с датой) ------------------------------------
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG_FILE" 2>/dev/null || true
}

# --- Загрузка токенов Telegram (без set -e на этом шаге) ----------------------
set -a
[ -f /opt/pulse/.env ] && . /opt/pulse/.env
set +a

# --- Отправка алерта с дедупликацией ------------------------------------------
# Аргументы: $1 — код условия (для state-файла), $2 — текст деталей
alert() {
    local condition="$1"
    local details="$2"
    local state_file="${STATE_DIR}/last-alert-${condition}"
    local now last
    now=$(date +%s)
    last=0
    [ -f "$state_file" ] && last=$(cat "$state_file" 2>/dev/null || echo 0)
    last=${last:-0}
    if [ $(( now - last )) -lt "$DEDUP_SECONDS" ]; then
        return 0  # недавно уже алертил — молчим
    fi
    echo "$now" > "$state_file" 2>/dev/null || true
    log "ALERT ${condition}: ${details}"
    if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_ADMIN_CHAT_ID:-}" ]; then
        curl -s -m 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            -d chat_id="${TELEGRAM_ADMIN_CHAT_ID}" \
            -d text="[PULSE-WATCH] ${condition}: ${details}" \
            -d parse_mode=HTML >/dev/null 2>&1 || log "WARN: не удалось отправить Telegram-алерт (${condition})"
    else
        log "WARN: TELEGRAM_* не заданы в /opt/pulse/.env, алерт (${condition}) только в лог"
    fi
}

# --- Проверка инфраструктуры: docker и контейнер живы -------------------------
if ! command -v docker >/dev/null 2>&1; then
    alert "infra" "docker недоступен на хосте"
    log "infra: docker не найден"
    exit 0
fi

if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
    alert "infra" "контейнер ${CONTAINER} не запущен"
    log "infra: контейнер ${CONTAINER} не в docker ps"
    exit 0
fi

# --- Проверка 1: зависшие IO/IPC-запросы (>60 сек в active) -------------------
PSQL="docker exec ${CONTAINER} psql -U pulse_user -d pulse -tAc"

hung=$($PSQL "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type IN ('IO','IPC') AND state='active' AND now()-query_start > interval '60 seconds'" 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$hung" ]; then
    alert "infra" "psql внутри ${CONTAINER} недоступен или вернул ошибку"
    log "infra: psql запрос не выполнен"
else
    if [ "$hung" -gt 0 ] 2>/dev/null; then
        details=$($PSQL "SELECT string_agg(pid || ' ' || coalesce(wait_event,'?') || ' ' || (now()-query_start)::text || 's ' || left(query,120), E'\n') FROM pg_stat_activity WHERE wait_event_type IN ('IO','IPC') AND state='active' AND now()-query_start > interval '60 seconds'" 2>/dev/null)
        alert "hung-io" "зависших IO-запросов: ${hung}"$'\n'"${details:-детали недоступны}"
    fi
    log "check hung-io: count=${hung}"
fi

# --- Проверка 2: io worker'ы postgres на >50% CPU ----------------------------
# NB: `ps -o comm` для postgres-процессов = просто "postgres"; роль ("io worker")
# видна только в полной командной строке (args) — матчим по ней.
io_workers=$(ps -eo pid,pcpu,args 2>/dev/null | awk '$3=="postgres:" && $4=="io" && $5=="worker" && $2 > 50 {print}' | cut -c1-120)
if [ -n "$io_workers" ]; then
    alert "io-workers" "io worker'ы postgres на >50% CPU:"$'\n'"$(echo "$io_workers" | head -5)"
fi
log "check io-workers: $(echo "$io_workers" | grep -c . 2>/dev/null || echo 0) процессов"

# --- Проверка 3: свежие повреждения страниц в логе контейнера -----------------
corrupt=$(docker logs --since 2m "$CONTAINER" 2>&1 | grep -E 'invalid page|page verification failed' || true)
if [ -n "$corrupt" ]; then
    alert "corrupt-pages" "обнаружены повреждённые страницы за последние 2 мин:"$'\n'"$(echo "$corrupt" | head -3)"
fi
log "check corrupt-pages: $(echo "$corrupt" | grep -c . 2>/dev/null || echo 0) строк"

# --- Проверка 4: p95 замер логина ---------------------------------------------
# curl-таймаут 35 сек: при зависании AIO логин отдаётся ровно за 30.1 сек (statement_timeout).
login_time=$(curl -s -m 35 -o /dev/null -w '%{time_total}' -X POST "$LOGIN_URL" \
    -H 'Content-Type: application/json' \
    -d '{"email":"vladfa@ya.ru","password":"!1234567890"}' 2>/dev/null)
curl_rc=$?
if [ $curl_rc -ne 0 ] || [ -z "$login_time" ]; then
    alert "login-slow" "login endpoint недоступен (curl rc=${curl_rc}, time=${login_time:-n/a})"
elif awk -v t="$login_time" -v th="$LOGIN_THRESHOLD_SEC" 'BEGIN{exit !(t > th)}'; then
    alert "login-slow" "логин занял ${login_time} сек (порог ${LOGIN_THRESHOLD_SEC} сек)"
fi
log "check login: time=${login_time:-failed}s rc=${curl_rc}"

exit 0
