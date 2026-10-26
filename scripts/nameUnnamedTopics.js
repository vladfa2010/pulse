/**
 * ТЗ-196, Задача 3 — одноразовый джоб разгреба безымянных тем последнего прогона.
 *
 * Контекст: с 11.10 непереведённые новости (title_ru NULL) накопились, нейминг
 * молча фейлился на пустых headlines. Задачи 1–2 чинят крон, этот джоб
 * называет накопленный хвост за один ручной запуск после деплоя.
 *
 * Что делает:
 *   1. Берёт ВСЕ unnamed-темы последнего done-прогона topic_runs (без лимита —
 *      только они видны в /api/market/topics, старые прогоны пользователю не видны).
 *   2. Последовательно вызывает nameTopicWithLlm с паузой 200–500 мс между вызовами.
 *   3. Логирует прогресс «названо X из Y».
 *
 * Идемпотентно: UPDATE в nameTopicWithLlm имеет условие «named=false ИЛИ
 * name IS NULL» — повторный запуск не затирает уже названные темы.
 *
 * Запуск (на VDS, после npm run build и деплоя):
 *   docker exec pulse-backend node scripts/nameUnnamedTopics.js
 *
 * Код выхода: 0 — ок (в т.ч. «нечего называть»), 1 — ошибка прогона.
 */

const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');

const UNNAMED_SQL = `SELECT t.id, t.keywords
  FROM topics t
  WHERE t.run_id = (
    SELECT id FROM topic_runs
    WHERE status = 'done'
    ORDER BY finished_at DESC NULLS LAST
    LIMIT 1
  )
    AND (t.named = false OR t.name IS NULL)
  ORDER BY t.news_count DESC`;

// пауза 200–500 мс между LLM-вызовами — не ддошим Moonshot
function pause() {
  const ms = 200 + Math.floor(Math.random() * 300);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { query } = require(path.join(DIST, 'config', 'db'));
  const { nameTopicWithLlm } = require(path.join(DIST, 'services', 'cron'));

  const rows = (await query(UNNAMED_SQL, [])).rows;
  if (rows.length === 0) {
    console.log('[NameTopics] безымянных тем в последнем прогоне нет — нечего называть');
    return;
  }
  console.log(`[NameTopics] безымянных тем в последнем прогоне: ${rows.length}`);

  let named = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      if (await nameTopicWithLlm({ id: row.id, keywords: row.keywords || [] })) named++;
      else failed++;
    } catch (err) {
      failed++;
      console.warn(`[NameTopics] тема ${row.id}: ${String(err?.message || err).slice(0, 100)}`);
    }
    console.log(`[NameTopics] названо ${named} из ${rows.length} (проверено ${i + 1}, не названо ${failed})`);
    await pause();
  }
  console.log(`[NameTopics] готово: названо ${named}, не названо ${failed} из ${rows.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[NameTopics] фатальная ошибка:', err);
    process.exit(1);
  });
