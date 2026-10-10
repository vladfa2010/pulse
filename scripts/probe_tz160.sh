#!/usr/bin/env bash
# =============================================================================
# PULSE — probe ТЗ-160: разведка инфраструктуры смыслового поиска (READ-ONLY)
#
# ВАЖНО: скрипт НИЧЕГО не создаёт и не меняет. Только SELECT / EXPLAIN / curl GET.
# Запускать на продовом сервере (где лежит /opt/pulse/docker-compose.yml).
# Тяжёлый EXPLAIN (секция 2) — один раз, вне пиковой нагрузки.
#
# Использование:  bash scripts/probe_tz160.sh           — секции 1, 3, 4
#                 bash scripts/probe_tz160.sh --explain — + секция 2 (тяжёлая)
# =============================================================================
set -euo pipefail

PSQL="docker exec pulse-postgres psql -U pulse_user -d pulse"
RUN_EXPLAIN=0
[ "${1:-}" = "--explain" ] && RUN_EXPLAIN=1

hr() { printf '\n========== %s ==========\n' "$1"; }

hr "1a. Версии PostgreSQL и pgvector"
$PSQL -c "SELECT version();"
$PSQL -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';"

hr "1b. Индексы таблицы news (ищем hnsw/embedding — мог быть построен вручную по ТЗ-91 задача 6)"
$PSQL -c "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'news' ORDER BY indexname;"

hr "1c. Объёмы: всего / с вектором / за 90 дней"
$PSQL -c "
SELECT count(*) AS total,
       count(embedding) AS with_embedding,
       count(*) FILTER (WHERE published_at > NOW() - INTERVAL '90 days') AS last_90d,
       count(embedding) FILTER (WHERE published_at > NOW() - INTERVAL '90 days') AS with_emb_90d
FROM news;"

hr "1d. Размер таблицы news"
$PSQL -c "SELECT pg_size_pretty(pg_total_relation_size('news')) AS news_total,
                 pg_size_pretty(pg_relation_size('news'))     AS news_data;"

if [ "$RUN_EXPLAIN" = "1" ]; then
  hr "2. EXPLAIN ANALYZE смыслового запроса БЕЗ индекса (тяжёлый, один прогон, вне пика)"
  VEC=$($PSQL -tA -c "SELECT embedding::text FROM news WHERE embedding IS NOT NULL AND published_at > NOW() - INTERVAL '90 days' LIMIT 1;")
  $PSQL -c "
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, 1 - (embedding <=> '${VEC}'::vector) AS sim
FROM news
WHERE embedding IS NOT NULL
  AND published_at > NOW() - INTERVAL '90 days'
ORDER BY embedding <=> '${VEC}'::vector
LIMIT 10;"
else
  hr "2. Пропущено (запустите с --explain вне пика)"
fi

hr "3. TEI: латентность одиночного эмбеддинга (5 прогонов, из backend — та же сеть, что прод)"
for i in 1 2 3 4 5; do
  docker exec pulse-backend curl -s -o /dev/null -w "прогон $i: %{time_total} s\n" \
    -X POST http://embeddings:80/embed \
    -H 'Content-Type: application/json' \
    -d '{"inputs":["что с пошлинами Трампа и ростом цен на нефть"]}'
done
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" | grep -i embeddings || true

hr "4. Ресурсы под постройку HNSW"
df -h /var/lib/docker | tail -1
free -m | head -2
$PSQL -c "SHOW maintenance_work_mem;"

hr "Готово. Пришлите весь вывод одним сообщением (результат ТЗ-160, задача 5)."
