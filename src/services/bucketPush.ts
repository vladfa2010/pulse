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


interface Candidate {
  userId: string;
  tagIds: string[];
  /** БЛОКЕР-фикс: число НЕПРОЧИТАННЫХ юзера в окне (per-user, не групповое). */
  unreadCount: number;
}

/** Получатели одним запросом: матрица + активный канал + анти-активность + дедupe
 *  + ПОРОГ per-user (HAVING COUNT непрочитанных >= MIN_UNREAD). Один SQL на всех —
 *  read-state каждого юзера свой (аудит ТЗ-219, критерии 2/3). */
async function selectCandidates(w: BucketWindow): Promise<Candidate[]> {
  const rsIso = w.rangeStart.toISOString();
  const reIso = w.rangeEnd.toISOString();
  const res = await query(
    USE_SQLITE
      ? `SELECT p.user_id,
                GROUP_CONCAT(p.tag_id, '|') AS tag_ids_csv,
                (SELECT COUNT(DISTINCT n.id) FROM news n
                 WHERE EXISTS (
                     SELECT 1 FROM portfolios pt
                     WHERE pt.user_id = p.user_id AND pt.is_frozen = 0
                       AND n.matched_tags LIKE '%"' || pt.tag_id || '"%'
                   )
                   AND n.published_at > ?
                   AND n.published_at <= ?
                   AND NOT EXISTS (SELECT 1 FROM user_news_reads r WHERE r.user_id = p.user_id AND r.news_id = n.id)
                ) AS unread_count
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
         GROUP BY p.user_id
         HAVING (SELECT COUNT(DISTINCT n.id) FROM news n
                 WHERE EXISTS (
                     SELECT 1 FROM portfolios pt
                     WHERE pt.user_id = p.user_id AND pt.is_frozen = 0
                       AND n.matched_tags LIKE '%"' || pt.tag_id || '"%'
                   )
                   AND n.published_at > ?
                   AND n.published_at <= ?
                   AND NOT EXISTS (SELECT 1 FROM user_news_reads r WHERE r.user_id = p.user_id AND r.news_id = n.id)
                ) >= ${MIN_UNREAD}`
      : `WITH cand AS (
           SELECT p.user_id, array_agg(p.tag_id ORDER BY p.tag_id)::text[] AS tag_ids
           FROM portfolios p
           WHERE p.is_frozen = FALSE
             AND EXISTS (
               SELECT 1 FROM notification_subscriptions ns
               WHERE ns.user_id = p.user_id AND ns.product = 'buckets' AND ns.channel = 'push' AND ns.enabled = TRUE
                 AND (ns.last_sent_at IS NULL OR ns.last_sent_at < $1::timestamptz)
             )
             AND (
               EXISTS (SELECT 1 FROM user_channels uc WHERE uc.user_id = p.user_id AND uc.channel = 'push' AND uc.is_active = TRUE)
               OR EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = p.user_id AND ps.is_active = TRUE)
             )
             AND NOT EXISTS (
               SELECT 1 FROM user_sessions s
               WHERE s.user_id = p.user_id AND s.last_connected_at >= $2::timestamptz
             )
           GROUP BY p.user_id
         )
         SELECT c.user_id, c.tag_ids, COUNT(DISTINCT n.id) AS unread_count
         FROM cand c
         JOIN news n ON n.matched_tags && c.tag_ids
         WHERE n.published_at > $3::timestamptz
           AND n.published_at <= $4::timestamptz
           AND NOT EXISTS (SELECT 1 FROM user_news_reads r WHERE r.user_id = c.user_id AND r.news_id = n.id)
         GROUP BY c.user_id, c.tag_ids
         HAVING COUNT(DISTINCT n.id) >= ${MIN_UNREAD}`,
    USE_SQLITE
      ? [rsIso.replace('T', ' ').slice(0, 19), reIso.replace('T', ' ').slice(0, 19),
         reIso.replace('T', ' ').slice(0, 19), rsIso.replace('T', ' ').slice(0, 19),
         rsIso.replace('T', ' ').slice(0, 19), reIso.replace('T', ' ').slice(0, 19)]
      : [reIso, rsIso, rsIso, reIso] // $1 дедupe(rangeEnd), $2 анти-активность(rangeStart), $3/$4 окно
  );
  return res.rows.map((r: any) => ({
    userId: r.user_id,
    tagIds: Array.isArray(r.tag_ids) ? r.tag_ids : String(r.tag_ids_csv || '').split('|').filter(Boolean),
    unreadCount: Number(r.unread_count || 0),
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

    const title = `Пока вас не было: ${BUCKET_TITLES[w.key] || w.key}`;

    // hoist: топ-заголовок окна один на tag-набор (критерий 8 fallback)
    const topTitleByTags = new Map<string, Promise<string | null>>();
    for (const c of candidates) {
      const k = [...c.tagIds].sort().join('|');
      if (!topTitleByTags.has(k)) topTitleByTags.set(k, readTopTitleLive(c.tagIds, w));
    }

    for (const c of candidates) {
      try {
        // БЛОКЕР-фикс: count — непрочитанные самого юзера (per-user из selectCandidates)
        const count = c.unreadCount;

        // тихие часы → skip без defer (контент ждёт в карусели)
        const quiet = await getQuietHours(c.userId);
        if (quiet?.enabled && isQuietHoursMsk(quiet.start, quiet.end)) { stats.skipped++; continue; }

        let { summary, topTitle } = await readSummary(c.userId, c.tagIds, w);
        // критерий 8: строки саммари нет (LLM лежал) — топ-новость окна (hoisted на группу)
        if (!summary && !topTitle) topTitle = (await topTitleByTags.get([...c.tagIds].sort().join('|'))) ?? null;
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
