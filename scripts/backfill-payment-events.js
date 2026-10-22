/**
 * ТЗ-124 — бэкфилл целевых событий оплаты/подписки в user_events.
 *
 * Контекст: логирование payment_completed / subscription_activated появилось
 * 10.07.2026 (91513ef), а последний завершённый платёж на тот момент был
 * 08.07.2026 — поэтому в user_events целей конверсии нет вообще, и дашборд
 * «Пути пользователей» (ТЗ-124) показывал бы пустоту всегда.
 *
 * Восстанавливаем историю из первоисточников (идемпотентно):
 *   - payment_completed      ← payments WHERE status='completed' (paid_at)
 *   - subscription_activated ← subscription_renewals WHERE status='completed' (period_start)
 *
 * Идемпотентность: вставляем только если для того же (user_id, event_type,
 * created_at) ещё нет строки — повторный прогон вставляет 0.
 * Откат: DELETE FROM user_events WHERE event_data->>'tz124_backfill' = 'true';
 *
 * Запуск (на VDS):
 *   npm run build && node scripts/backfill-payment-events.js
 */

const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');

async function main() {
  const { query } = require(path.join(DIST, 'config', 'db'));
  const USE_SQLITE = process.env.USE_SQLITE === 'true';

  // 1. payment_completed из payments
  const payments = await query(
    `SELECT id, user_id, amount, plan_id, method, product_type, paid_at
     FROM payments WHERE status = 'completed' ORDER BY paid_at ASC`,
    []
  );
  let inserted = 0;
  let skipped = 0;
  for (const p of payments.rows) {
    const data = {
      amount: Number(p.amount),
      plan_id: p.plan_id,
      method: p.method || 'yookassa',
      ...(p.product_type ? { product_type: p.product_type } : {}),
      tz124_backfill: 'true',
      source_payment_id: p.id,
    };
    const dup = await query(
      `SELECT 1 AS x FROM user_events
       WHERE user_id = $1 AND event_type = 'payment_completed' AND created_at = $2 LIMIT 1`,
      [p.user_id, p.paid_at]
    );
    if (dup.rows.length > 0) {
      skipped++;
      continue;
    }
    await query(
      `INSERT INTO user_events (user_id, event_type, event_data, created_at)
       VALUES ($1, 'payment_completed', $2, $3)`,
      [p.user_id, USE_SQLITE ? JSON.stringify(data) : data, p.paid_at]
    );
    inserted++;
  }
  console.log(`[Backfill] payment_completed: вставлено ${inserted}, уже было ${skipped}`);

  // 2. subscription_activated из subscription_renewals
  const renewals = await query(
    `SELECT id, user_id, plan_id, period_start FROM subscription_renewals
     WHERE status = 'completed' AND period_start IS NOT NULL ORDER BY period_start ASC`,
    []
  );
  let ins2 = 0;
  let skip2 = 0;
  for (const r of renewals.rows) {
    const data = {
      plan_id: r.plan_id,
      period_start: r.period_start,
      tz124_backfill: 'true',
      source_renewal_id: r.id,
    };
    const dup = await query(
      `SELECT 1 AS x FROM user_events
       WHERE user_id = $1 AND event_type = 'subscription_activated' AND created_at = $2 LIMIT 1`,
      [r.user_id, r.period_start]
    );
    if (dup.rows.length > 0) {
      skip2++;
      continue;
    }
    await query(
      `INSERT INTO user_events (user_id, event_type, event_data, created_at)
       VALUES ($1, 'subscription_activated', $2, $3)`,
      [r.user_id, USE_SQLITE ? JSON.stringify(data) : data, r.period_start]
    );
    ins2++;
  }
  console.log(`[Backfill] subscription_activated: вставлено ${ins2}, уже было ${skip2}`);
  console.log('[Backfill] готово');
}

main().catch((err) => {
  console.error('[Backfill] FATAL:', err);
  process.exit(1);
});
