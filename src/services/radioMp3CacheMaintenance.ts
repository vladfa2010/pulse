/**
 * =============================================================================
 * PULSE — Обслуживание MP3-кэша радио (ТЗ-65)
 * =============================================================================
 *
 * Запускает периодические задачи:
 *  - snapshot истории каждые 60 сек (ring buffer для графиков в админке)
 *  - проверка порогов алертов каждые 5 мин (TG-уведомления админам)
 *
 * Регистрируется в src/index.ts по аналогии с startGlobalSummaryCron.
 * В services/cron.ts не добавляем — там RSS-крон, это другое доменное ядро.
 */

import { startHistoryCron } from './radioMp3CacheHistory';
import { checkCacheAlerts } from './radioCacheAlerts';

export function startRadioCacheMaintenance(options: {
  isShuttingDown: () => boolean;
}): void {
  const { isShuttingDown } = options;

  // Snapshot истории (in-memory ring buffer)
  startHistoryCron();

  // Алерты каждые 5 мин
  setInterval(() => {
    if (isShuttingDown()) return;
    checkCacheAlerts().catch((e: any) =>
      console.error('[RadioCacheAlerts] check failed:', e.message)
    );
  }, 5 * 60 * 1000);

  console.log('[RadioCacheMaintenance] Started — history 60s, alerts 5m');
}
