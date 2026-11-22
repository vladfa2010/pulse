/**
 * =============================================================================
 * PULSE — Пуши бакетов «Пока вас не было» (ТЗ-219)
 * =============================================================================
 *
 * Отправка в момент закрытия окна (06:00/12:00/18:00 МСК): title «Пока вас
 * не было: Ночь», body — первое предложение готового саммари bucket_summaries
 * (при отсутствии — топ-новость окна) + «· N новостей». LLM в момент
 * отправки НЕ вызываем — только чтение готового (критерий 8 ТЗ-219).
 *
 * Гарды (правило 4): подписка buckets/push enabled; активный push-канал
 * (user_channels ИЛИ push_subscriptions); ≥3 непрочитанных в окне; юзер
 * НЕактивен в окне (user_sessions.last_connected_at < range_start, строки нет
 * = неактивен); тихие часы → skip без defer. «Вечер» (00:00) не пушим.
 * Дедupe: last_sent_at строки матрицы (user_id, 'buckets', 'push').
 * Отправка ОБЕИМИ ветками: FCM + VAPID (критерий 1 — десктоп).
 * Порог ≥3 считается по группам наборов тегов — без N+1 (блокер v5).
 */

import { createHash } from 'crypto';
import { query } from '../config/db';
import { sendPushNotification } from './push';
import { sendWebPushToUser } from './webPush';
import { getQuietHours } from './notifications/subscriptions';
import { isQuietHoursMsk } from './notifications/quietHours';
import { BucketKey } from './bucketTime';
import { bucketTagsHash } from './bucketSummary';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const MIN_UNREAD = 3;
const BODY_MAX = 120;

export interface BucketWindow {
  key: BucketKey;
  rangeStart: Date;
  rangeEnd: Date;
}

export interface BucketPushStats {
  candidates: number;
  sent: number;
  skipped: number;
}

const BUCKET_TITLES: Record<string, string> = {
  night: 'Ночь',
  morning: 'Утро',
  day: 'День',
  evening: 'Вечер',
};

function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut) + '…';
}

function tagConds(tagIds: string[], params: unknown[], alias = 'n'): string {
  if (USE_SQLITE) {
    const conds = tagIds.map(() => `${alias}.matched_tags LIKE ?`);
    for (const t of tagIds) params.push(`%"${t}"%`);
    return conds.join(' OR ');
  }
  params.push(tagIds);
  return `${alias}.matched_tags && $${params.length}::text[]`;
}

/** Count непрочитанных в окне по набору тегов (один запрос на группу). */
async function countUnreadInWindow(userId: string, tagIds: string[], w: BucketWindow): Promise<number> {
  const params: unknown[] = [];
  const tc = tagConds(tagIds, params);
  const ph = (v: unknown) => { params.push(v); return USE_SQLITE ? '?' : `$${params.length}`; };
  if (USE_SQLITE) {
    // SQLite: ? в текстовом порядке — [tags, start, end, userId]
    const litParams: unknown[] = [];
    const litTc = tagIds.map(() => 'n.matched_tags LIKE ?').join(' OR ');
    for (const t of tagIds) litParams.push(`%"${t}"%`);
    litParams.push(w.rangeStart.toISOString().replace('T', ' ').slice(0, 19));
    litParams.push(w.rangeEnd.toISOString().replace('T', ' ').slice(0, 19));
    litParams.push(userId);
    const resLite = await query(
      `SELECT COUNT(*) AS count FROM news n
       WHERE (${litTc})
         AND n.published_at > ?
         AND n.published_at <= ?
         AND NOT EXISTS (SELECT 1 FROM user_news_reads r WHERE r.user_id = ? AND r.news_id = n.id)`,
      litParams
    );
    return Number(resLite.rows[0]?.count || 0);
  }
  const nr = `NOT EXISTS (SELECT 1 FROM user_news_reads r WHERE r.user_id = ${ph(userId)} AND r.news_id = n.id)`;
  const res = await query(
    `SELECT COUNT(*) AS count FROM news n
     WHERE ${tc}
       AND n.published_at > ${ph(w.rangeStart.toISOString())}
       AND n.published_at <= ${ph(w.rangeEnd.toISOString())}
       AND ${nr}`,
    params
  );
  return Number(res.rows[0]?.count || 0);
}

interface Candidate {
  userId: string;
  tagIds: string[];
}

/** Получатели одним запросом: матрица + активный канал + анти-активность + дедupe. */
async function selectCandidates(w: BucketWindow): Promise<Candidate[]> {
  const params: unknown[] = [];
  const ph = (v: unknown) => { params.push(v); return `$${params.length}`; };
  // $1 — анти-активность (активен В окне?); $2 — дедupe. Дедupe сравниваем с
  // КОНЦОМ окна: отправка идёт в момент закрытия (≈rangeEnd), и markSent пишет
  // ≈rangeEnd — при сравнении с rangeStart следующее окно детерминированно
  // отсекалось бы (БЛОКЕР ревью). Повтор того же окна: last_sent_at >= rangeEnd → skip ✓
  const rs = ph(w.rangeStart.toISOString());
  const re = ph(w.rangeEnd.toISOString());
  const res = await query(
    USE_SQLITE
      ? `SELECT p.user_id, GROUP_CONCAT(p.tag_id, '|') AS tag_ids_csv
         FROM portfolios p
         WHERE p.is_frozen = 0
           AND EXISTS (
             SELECT 1 FROM notification_subscriptions ns
             WHERE ns.user_id = p.user_id AND ns.product = 'buckets' AND ns.channel = 'push' AND ns.enabled = TRUE
               AND (ns.last_sent_at IS NULL OR ns.last_sent_at < ?)
           )
           AND (
             EXISTS (SELECT 1 FROM user_channels uc WHERE uc.user_id = p.user_id AND uc.channel = 'push' AND uc.is_active = 1)
             OR EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = p.user_id AND ps.is_active = 1)
           )
           AND NOT EXISTS (
             SELECT 1 FROM user_sessions s
             WHERE s.user_id = p.user_id AND s.last_connected_at >= ?
           )
         GROUP BY p.user_id`
      : `SELECT p.user_id, array_agg(p.tag_id ORDER BY p.tag_id) AS tag_ids
         FROM portfolios p
         WHERE p.is_frozen = FALSE
           AND EXISTS (
             SELECT 1 FROM notification_subscriptions ns
             WHERE ns.user_id = p.user_id AND ns.product = 'buckets' AND ns.channel = 'push' AND ns.enabled = TRUE
               AND (ns.last_sent_at IS NULL OR ns.last_sent_at < ${re}::timestamptz)
           )
           AND (
             EXISTS (SELECT 1 FROM user_channels uc WHERE uc.user_id = p.user_id AND uc.channel = 'push' AND uc.is_active = TRUE)
             OR EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = p.user_id AND ps.is_active = TRUE)
           )
           AND NOT EXISTS (
             SELECT 1 FROM user_sessions s
             WHERE s.user_id = p.user_id AND s.last_connected_at >= ${rs}::timestamptz
           )
         GROUP BY p.user_id`,
    // SQLite: плейсхолдеры ? в текстовом порядке — дедupe(rangeEnd) затем анти-активность(rangeStart)
    USE_SQLITE ? [w.rangeEnd.toISOString().replace('T', ' ').slice(0, 19), w.rangeStart.toISOString().replace('T', ' ').slice(0, 19)] : params
  );
  return res.rows.map((r: any) => ({
    userId: r.user_id,
    tagIds: Array.isArray(r.tag_ids) ? r.tag_ids : String(r.tag_ids_csv || '').split('|').filter(Boolean),
  }));
}

/** Живая топ-новость окна (fallback критерия 8, когда bucket_summaries пуст). */
async function readTopTitleLive(tagIds: string[], w: BucketWindow): Promise<string | null> {
  const params: unknown[] = [];
  const tc = tagConds(tagIds, params);
  const ph = (v: unknown) => { params.push(v); return USE_SQLITE ? '?' : `$${params.length}`; };
  const nullsLast = USE_SQLITE ? '' : ' NULLS LAST';
  const res = await query(
    `SELECT COALESCE(n.title_ru, n.title_original) AS title
     FROM news n
     WHERE ${tc}
       AND n.published_at > ${ph(USE_SQLITE ? w.rangeStart.toISOString().replace('T', ' ').slice(0, 19) : w.rangeStart.toISOString())}
       AND n.published_at <= ${ph(USE_SQLITE ? w.rangeEnd.toISOString().replace('T', ' ').slice(0, 19) : w.rangeEnd.toISOString())}
     ORDER BY n.source_count DESC, n.sentiment_score DESC${nullsLast}
     LIMIT 1`,
    params
  );
  return res.rows[0]?.title || null;
}

/** Чтение саммари по полному квантованному ключу ТЗ-218 (без LLM). */
async function readSummary(userId: string, tagIds: string[], w: BucketWindow): Promise<{ summary: string | null; topTitle: string | null }> {
  const key = bucketTagsHash(tagIds, 'bucket', w.rangeStart, w.rangeEnd, '');
  const res = await query(
    `SELECT summary, top_news FROM bucket_summaries WHERE user_id = $1 AND tags_hash = $2 AND variant = 'bucket'`,
    [userId, key]
  );
  const row = res.rows[0];
  let topTitle: string | null = null;
  if (row?.top_news) {
    try {
      const tops = typeof row.top_news === 'string' ? JSON.parse(row.top_news) : row.top_news;
      topTitle = tops?.[0]?.title || null;
    } catch { /* top_news бит — fallback на summary */ }
  }
  return { summary: row?.summary ?? null, topTitle };
}

async function markSent(userId: string): Promise<void> {
  await query(
    USE_SQLITE
      ? `UPDATE notification_subscriptions SET last_sent_at = datetime('now')
         WHERE user_id = ? AND product = 'buckets' AND channel = 'push'`
      : `UPDATE notification_subscriptions SET last_sent_at = NOW()
         WHERE user_id = $1 AND product = 'buckets' AND channel = 'push'`,
    [userId]
  );
}

/**
 * Отправка пушей бакета. Вызывается из cron-прегенерации (03/09/15 UTC) —
 * независимо от результата LLM (критерий 8). Идемпотентна (last_sent_at).
 */
export async function sendBucketPushes(w: BucketWindow): Promise<BucketPushStats> {
  const stats: BucketPushStats = { candidates: 0, sent: 0, skipped: 0 };
  try {
    const candidates = await selectCandidates(w);
    stats.candidates = candidates.length;
    if (candidates.length === 0) {
      console.log(`[BucketPush] window=${w.key}: 0 candidates`);
      return stats;
    }

    // порог ≥3 по группам наборов тегов — один count-запрос на группу (без N+1)
    const groupHash = (tagIds: string[]) =>
      createHash('sha1').update([...tagIds].sort().join('|')).digest('hex');
    const groups = new Map<string, { tagIds: string[]; members: Candidate[] }>();
    for (const c of candidates) {
      const h = groupHash(c.tagIds);
      if (!groups.has(h)) groups.set(h, { tagIds: c.tagIds, members: [] });
      groups.get(h)!.members.push(c);
    }
    const groupCounts = new Map<string, number>();
    // Порог групповой: count по read-state первого члена группы применяется ко всей
    // группе с одинаковыми тегами — компромисс ради запрета N+1 (аудит ТЗ-219 N3)
    for (const [h, g] of groups) {
      groupCounts.set(h, await countUnreadInWindow(g.members[0].userId, g.tagIds, w));
    }
    // hoist: топ-заголовок окна один на tag-группу (критерий 8 fallback)
    const groupTopTitles = new Map<string, Promise<string | null>>();
    for (const [h, g] of groups) {
      groupTopTitles.set(h, readTopTitleLive(g.tagIds, w));
    }

    const title = `Пока вас не было: ${BUCKET_TITLES[w.key] || w.key}`;

    for (const c of candidates) {
      try {
        const count = groupCounts.get(groupHash(c.tagIds)) ?? 0;
        if (count < MIN_UNREAD) { stats.skipped++; continue; }

        // тихие часы → skip без defer (контент ждёт в карусели)
        const quiet = await getQuietHours(c.userId);
        if (quiet?.enabled && isQuietHoursMsk(quiet.start, quiet.end)) { stats.skipped++; continue; }

        let { summary, topTitle } = await readSummary(c.userId, c.tagIds, w);
        // критерий 8: строки саммари нет (LLM лежал) — топ-новость окна (hoisted на группу)
        if (!summary && !topTitle) topTitle = (await groupTopTitles.get(groupHash(c.tagIds))) ?? null;
        const firstSentence = summary ? summary.split(/(?<=[.!?])\s+/)[0] : (topTitle || '');
        const body = truncateAtWord(`${firstSentence} · ${count} новостей`, BODY_MAX);

        const data: Record<string, string> = {
          type: 'bucket',
          key: w.key,
          range_start: w.rangeStart.toISOString(),
          range_end: w.rangeEnd.toISOString(),
          // ТЗ-219 + диплинк: data.url открывает главную с раскрытием панели бакета
          url: `/?bucket=${w.key}`,
        };

        // обе ветки: FCM (мобильные) + VAPID (десктоп) — критерий 1
        const [fcmOk, vapidCount] = await Promise.all([
          // skipEnabledCheck/skipQuietHours: гарды матрицы и тихих часов свои (выше),
          // иначе legacy-колонка push_enabled глушит FCM-ветку при выключенном news_alert
          sendPushNotification(c.userId, title, body, data, { skipQuietHours: true, skipEnabledCheck: true }),
          sendWebPushToUser(c.userId, title, body, data),
        ]);
        if (fcmOk || vapidCount > 0) {
          await markSent(c.userId);
          stats.sent++;
        } else {
          stats.skipped++;
        }
      } catch (err: any) {
        stats.skipped++;
        console.error(`[BucketPush] user=${c.userId} failed: ${err.message?.slice(0, 100)}`);
      }
    }
    console.log(`[BucketPush] window=${w.key}: ${stats.candidates} candidates, ${stats.sent} sent, ${stats.skipped} skipped`);
  } catch (err: any) {
    console.error(`[BucketPush] window=${w.key} fatal:`, err.message);
  }
  return stats;
}
