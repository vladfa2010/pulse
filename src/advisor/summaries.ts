/**
 * =============================================================================
 * PULSE — Advisor module: саммари клиентов (ТЗ-182 Задача 6)
 * =============================================================================
 *
 * Сервис и эндпоинты саммари клиентских портфелей:
 *   GET   /api/advisor/summaries            — read-only (никогда не вызывает LLM)
 *   POST  /api/advisor/summaries/refresh    — принудительная регенерация (1/5 мин на клиента)
 *   PATCH /api/advisor/summaries/schedule   — слоты обновления (UPSERT в advisor_settings)
 *
 * Cron advisorPrecompute (регистрация в src/index.ts):
 *   расписание 7 * * * * (Europe/Moscow), отбор пользователей с multi_portfolio,
 *   у которых текущий час МСК входит в эффективные слоты; concurrency ≤ 3
 *   LLM-вызовов; лог [AdvisorSummaries] slot=HHMSK users=A clients=B
 *   generated=C skipped_empty=D duration=Xs.
 *
 * ТЗ-183: после пула в слоте — алерты сентимента (alerts.ts, после генерации
 * каждого саммари) и TG-дайджест + топ-5 новостей по клиентам (digest.ts,
 * после прогона пула; без дополнительных LLM-вызовов).
 *
 * Зависимости Задачи 5: selectNewsByTags / buildSummaryPrompt / callSummaryLLM
 * (services/userSummary.ts — та же выборка и тот же LLM-контракт, что у ядра;
 * копипаста запрещена, см. риск «дрейф логики» в ТЗ-182 §5).
 */

import { Router } from 'express';
import cron from 'node-cron';
import { query } from '../config/db';
import { AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { z } from 'zod';
import {
  selectNewsByTags, buildSummaryPrompt, callSummaryLLM, SUMMARY_LLM_MODEL,
} from '../services/userSummary';
import { hasFeature } from '../services/subscription';
import { acquireCronLock, releaseCronLock } from '../services/cron';
import { nowSql } from '../utils/nowSql';
import { getOwnedClient } from './service';
import { maybeSendSentimentAlert } from './alerts';
import { sendAdvisorSlotMessages } from './digest';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

/** Разрешённый набор часов слотов (МСК) — ТЗ-182 Задача 6. */
export const ALLOWED_SLOTS = [6, 7, 8, 9, 10, 13, 17, 18, 19, 20, 21] as const;

/** Период саммари по умолчанию (как у ядра GET /api/user/summary). */
const DEFAULT_PERIOD_HOURS = 12;

/** Шаблон пустого саммари — клиенты без новостей не тратят LLM. */
const EMPTY_SUMMARY_TEXT = 'Значимых событий по активам клиента за последние 12 часов не зафиксировано.';

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Текущий час в Europe/Moscow (0–23). МСК = UTC+3, считаем в JS (как calendar.ts). */
export function currentMskHour(d: Date = new Date()): number {
  return new Date(d.getTime() + MSK_OFFSET_MS).getUTCHours();
}

/**
 * Дефолтные слоты, детерминированно разнесённые по user_id (ТЗ-182 Задача 6):
 * утренний = 6 + (user_id % 3) (06/07/08), вечерний = 17 + (user_id % 3) (17/18/19).
 * user_id — UUID; хэш фиксирован: первые 8 hex-символов, parseInt(base 16) % 3.
 * UUID v4: 13-й символ всегда '4' → включение 13-го символа не меняло бы
 * разбиение, поэтому берём строго первые 8.
 */
export function defaultSlotsForUser(userId: string): number[] {
  const hex8 = (userId || '').replace(/-/g, '').slice(0, 8);
  const h = parseInt(hex8, 16);
  const mod = Number.isNaN(h) ? 0 : h % 3;
  return [6 + mod, 17 + mod];
}

interface ClientTags {
  tagId: string | null;
  tagName: string;
  tagType: string | null;
}

async function getClientTags(clientId: number): Promise<ClientTags[]> {
  const result = await query(
    `SELECT tag_id, tag_name, tag_type FROM advisor_client_tags WHERE client_id = $1 ORDER BY id ASC`,
    [clientId]
  );
  return result.rows.map((r: any) => ({ tagId: r.tag_id ?? null, tagName: r.tag_name, tagType: r.tag_type ?? null }));
}

/** Эффективные слоты: advisor_settings.summary_slots (JSON '[8,20]') или дефолт-хэш. */
export async function getEffectiveSlots(userId: string): Promise<number[]> {
  const result = await query(
    `SELECT summary_slots FROM advisor_settings WHERE user_id = $1`,
    [userId]
  );
  const raw = result.rows[0]?.summary_slots;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const slots = [...new Set(parsed.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 23))].sort((a, b) => a - b);
        if (slots.length > 0) return slots;
      }
    } catch { /* битый JSON — дефолт */ }
  }
  return defaultSlotsForUser(userId);
}

async function getLastRunAt(userId: string): Promise<string | null> {
  const result = await query(
    `SELECT MAX(s.generated_at) AS last_run_at
     FROM advisor_summaries s
     JOIN advisor_clients c ON c.id = s.client_id
     WHERE c.advisor_user_id = $1`,
    [userId]
  );
  const v = result.rows[0]?.last_run_at;
  return v ? new Date(v).toISOString() : null;
}

/**
 * Ближайший слот после текущего момента (МСК). Если сегодня слотов не осталось
 * — первый слот завтра. Возвращает ISO-дату (UTC) соответствующего часа МСК.
 */
export function computeNextRunAt(slots: number[], now: Date = new Date()): string {
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  const sorted = [...slots].sort((a, b) => a - b);
  for (const slot of sorted) {
    if (slot > msk.getUTCHours()) {
      return new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate(), slot, 0, 0, 0) - MSK_OFFSET_MS).toISOString();
    }
  }
  const tomorrow = new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() + 1, sorted[0] ?? 8, 0, 0, 0) - MSK_OFFSET_MS);
  return tomorrow.toISOString();
}

// ─── Генерация саммари ──────────────────────────────────────────────────────

export interface GenerateSummaryResult {
  generated: boolean;
  skippedEmpty: boolean;
  articlesCount: number;
  summary: string;
}

/**
 * Генерация саммари клиента за окно `hours`:
 *   1. Теги клиента → selectNewsByTags (библиотека Задачи 5);
 *   2. articles_count = 0 → БЕЗ LLM, UPSERT шаблона (sentiment_mix NULL);
 *   3. иначе buildSummaryPrompt + LLM (тот же клиент/модель, что ядро),
 *      UPSERT в advisor_summaries: sentiment_mix {pos,neg,neu} — доли в %
 *      (аналог подсчёта ядра для /api/user/summary; накопительный, округление
 *      largest remainder до суммы 100), tags_snapshot — имена тегов.
 */
export async function generateClientSummary(clientId: number, hours: number = DEFAULT_PERIOD_HOURS): Promise<GenerateSummaryResult> {
  const client = await query(`SELECT id, name FROM advisor_clients WHERE id = $1`, [clientId]);
  if (client.rows.length === 0) throw new Error('advisor_client_not_found');
  const clientName = client.rows[0].name as string;

  const tags = await getClientTags(clientId);
  const tagIds = [...new Set(tags.map((t) => t.tagId).filter((v): v is string => !!v))];
  const tagNames = tags.map((t) => t.tagName);

  let articles: Awaited<ReturnType<typeof selectNewsByTags>> = [];
  if (tagIds.length > 0) {
    articles = await selectNewsByTags(tagIds, hours);
  }

  if (articles.length === 0) {
    await upsertSummary(clientId, hours, EMPTY_SUMMARY_TEXT, 0, null, tags);
    console.log(`[AdvisorSummaries] Client ${clientId} (${clientName}): no news for ${hours}h — template saved, LLM skipped`);
    return { generated: false, skippedEmpty: true, articlesCount: 0, summary: EMPTY_SUMMARY_TEXT };
  }

  const llm = await callSummaryLLM(buildSummaryPrompt(tagNames, articles, hours));
  const mix = computeSentimentMix(articles);
  await upsertSummary(clientId, hours, llm.text, articles.length, mix, tags);
  console.log(`[AdvisorSummaries] Client ${clientId} (${clientName}): generated ${llm.text.length} chars, articles=${articles.length}, model=${SUMMARY_LLM_MODEL}`);
  return { generated: true, skippedEmpty: false, articlesCount: articles.length, summary: llm.text };
}

function computeSentimentMix(articles: { sentiment: string }[]): { pos: number; neg: number; neu: number } {
  const counts = { pos: 0, neg: 0, neu: 0 };
  for (const a of articles) {
    if (a.sentiment === 'positive') counts.pos++;
    else if (a.sentiment === 'negative') counts.neg++;
    else counts.neu++;
  }
  const total = articles.length || 1;
  // Largest remainder: доли в %, сумма строго 100
  const raw = [
    { key: 'pos' as const, value: (counts.pos * 100) / total },
    { key: 'neg' as const, value: (counts.neg * 100) / total },
    { key: 'neu' as const, value: (counts.neu * 100) / total },
  ];
  const floors = raw.map((r) => ({ ...r, floor: Math.floor(r.value), rem: r.value - Math.floor(r.value) }));
  let sum = floors.reduce((acc, r) => acc + r.floor, 0);
  for (const r of floors.sort((a, b) => b.rem - a.rem)) {
    if (sum >= 100) break;
    r.floor += 1;
    sum += 1;
  }
  const mix = { pos: 0, neg: 0, neu: 0 };
  for (const r of floors) mix[r.key] = r.floor;
  return mix;
}

async function upsertSummary(
  clientId: number,
  hours: number,
  summary: string,
  articlesCount: number,
  sentimentMix: { pos: number; neg: number; neu: number } | null,
  tags: ClientTags[]
): Promise<void> {
  const tagsSnapshot = JSON.stringify(tags.map((t) => ({ tag_name: t.tagName, tag_type: t.tagType })));
  const mixJson = sentimentMix ? JSON.stringify(sentimentMix) : null;
  const sql = USE_SQLITE
    ? `INSERT INTO advisor_summaries (client_id, period_hours, summary, articles_count, sentiment_mix, tags_snapshot, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6, ${nowSql()})
       ON CONFLICT (client_id, period_hours) DO UPDATE SET
         summary = EXCLUDED.summary,
         articles_count = EXCLUDED.articles_count,
         sentiment_mix = EXCLUDED.sentiment_mix,
         tags_snapshot = EXCLUDED.tags_snapshot,
         generated_at = EXCLUDED.generated_at`
    : `INSERT INTO advisor_summaries (client_id, period_hours, summary, articles_count, sentiment_mix, tags_snapshot, generated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, ${nowSql()})
       ON CONFLICT (client_id, period_hours) DO UPDATE SET
         summary = EXCLUDED.summary,
         articles_count = EXCLUDED.articles_count,
         sentiment_mix = EXCLUDED.sentiment_mix,
         tags_snapshot = EXCLUDED.tags_snapshot,
         generated_at = EXCLUDED.generated_at`;
  await query(sql, [clientId, hours, summary, articlesCount, mixJson, tagsSnapshot]);
}

// ─── Эндпоинты ──────────────────────────────────────────────────────────────

// GET /api/advisor/summaries?hours=12 — read-only: все не-архивные клиенты +
// последнее саммари на клиента + schedule. Никогда не вызывает LLM.
router.get('/', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const hours = Math.min(Math.max(parseInt(req.query.hours as string) || DEFAULT_PERIOD_HOURS, 1), 168);

    const clientsResult = await query(
      `SELECT c.id, c.name FROM advisor_clients c
       WHERE c.advisor_user_id = $1 AND c.is_archived = FALSE
       ORDER BY c.sort_order ASC, c.created_at ASC`,
      [userId]
    );
    const clientIds = clientsResult.rows.map((r: any) => Number(r.id));

    const summariesByClient = new Map<number, any>();
    if (clientIds.length > 0) {
      const summariesSql = USE_SQLITE
        ? `SELECT client_id, period_hours, summary, articles_count, sentiment_mix, tags_snapshot, generated_at
           FROM advisor_summaries
           WHERE client_id IN (${clientIds.map((_, i) => `$${i + 1}`).join(', ')})
           ORDER BY generated_at DESC`
        : `SELECT client_id, period_hours, summary, articles_count, sentiment_mix, tags_snapshot, generated_at
           FROM advisor_summaries
           WHERE client_id = ANY($1)
           ORDER BY generated_at DESC`;
      const summariesResult = await query(summariesSql, USE_SQLITE ? clientIds : [clientIds]);
      for (const row of summariesResult.rows) {
        const cid = Number(row.client_id);
        // Для каждого клиента — саммари запрошенного периода, иначе самое свежее
        const existing = summariesByClient.get(cid);
        if (!existing) {
          summariesByClient.set(cid, row);
        } else if (row.period_hours === hours && existing.period_hours !== hours) {
          summariesByClient.set(cid, row);
        } else if (row.period_hours === hours && existing.period_hours === hours
                   && new Date(row.generated_at) > new Date(existing.generated_at)) {
          summariesByClient.set(cid, row);
        } else if (existing.period_hours !== hours && row.period_hours !== hours
                   && new Date(row.generated_at) > new Date(existing.generated_at)) {
          summariesByClient.set(cid, row);
        }
      }
    }

    const slots = await getEffectiveSlots(userId);
    const lastRunAt = await getLastRunAt(userId);

    res.json({
      clients: clientsResult.rows.map((r: any) => {
        const cid = Number(r.id);
        const s = summariesByClient.get(cid);
        let sentimentMix = null;
        let tagsSnapshot = null;
        if (s) {
          try { sentimentMix = typeof s.sentiment_mix === 'string' ? JSON.parse(s.sentiment_mix) : s.sentiment_mix; } catch { sentimentMix = null; }
          try { tagsSnapshot = typeof s.tags_snapshot === 'string' ? JSON.parse(s.tags_snapshot) : s.tags_snapshot; } catch { tagsSnapshot = null; }
        }
        return {
          client_id: cid,
          name: r.name,
          summary: s?.summary ?? null,
          articles_count: s ? Number(s.articles_count) : 0,
          sentiment_mix: sentimentMix,
          tags_snapshot: tagsSnapshot,
          generated_at: s?.generated_at ? new Date(s.generated_at).toISOString() : null,
        };
      }),
      schedule: {
        slots,
        last_run_at: lastRunAt,
        next_run_at: computeNextRunAt(slots),
      },
    });
  } catch (err: any) {
    console.error('[AdvisorSummaries] List error:', err.message);
    res.status(500).json({ error: 'Failed to list summaries' });
  }
});

// In-memory rate limit refresh: 1 запрос / 5 мин на клиента (ТЗ-182 Задача 6).
const refreshRateLimit = new Map<number, number>();
const REFRESH_LIMIT_MS = 5 * 60 * 1000;

// POST /api/advisor/summaries/refresh { client_id } — принудительная регенерация
router.post('/refresh', validate(z.object({ client_id: z.number().int().positive() })), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const clientId = req.body.client_id as number;

    const client = await getOwnedClient(clientId, userId);
    if (!client) {
      return res.status(403).json({ error: 'advisor_client_forbidden' });
    }
    if (client.is_archived) {
      return res.status(403).json({ error: 'advisor_client_archived' });
    }

    const last = refreshRateLimit.get(clientId);
    if (last && Date.now() - last < REFRESH_LIMIT_MS) {
      const retryAfterSec = Math.ceil((REFRESH_LIMIT_MS - (Date.now() - last)) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'rate_limit', retry_after_sec: retryAfterSec, hint: 'не чаще 1 раза в 5 минут' });
    }
    refreshRateLimit.set(clientId, Date.now());

    const result = await generateClientSummary(clientId, DEFAULT_PERIOD_HOURS);
    res.json({
      client_id: clientId,
      summary: result.summary,
      articles_count: result.articlesCount,
      generated: result.generated,
      skipped_empty: result.skippedEmpty,
      generated_at: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[AdvisorSummaries] Refresh error:', err.message);
    res.status(500).json({ error: 'Failed to refresh summary' });
  }
});

// PATCH /api/advisor/summaries/schedule { slots: [h1, h2] } — 1–2 различных часа
// из разрешённого набора; UPSERT в advisor_settings, хранить отсортированным.
router.patch('/schedule', validate(z.object({ slots: z.array(z.number().int()).min(1).max(2) })), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const slots = req.body.slots as number[];

    const allowed = new Set<number>(ALLOWED_SLOTS);
    const unique = [...new Set(slots)];
    if (unique.length !== slots.length || unique.some((h) => !allowed.has(h))) {
      return res.status(400).json({ error: 'invalid_slots', allowed: [...ALLOWED_SLOTS] });
    }
    const sorted = [...unique].sort((a, b) => a - b);

    const sql = USE_SQLITE
      ? `INSERT INTO advisor_settings (user_id, summary_slots, created_at)
         VALUES ($1, $2, ${nowSql()})
         ON CONFLICT (user_id) DO UPDATE SET summary_slots = EXCLUDED.summary_slots`
      : `INSERT INTO advisor_settings (user_id, summary_slots, created_at)
         VALUES ($1, $2, ${nowSql()})
         ON CONFLICT (user_id) DO UPDATE SET summary_slots = EXCLUDED.summary_slots`;
    await query(sql, [userId, JSON.stringify(sorted)]);

    res.json({ slots: sorted, next_run_at: computeNextRunAt(sorted) });
  } catch (err: any) {
    console.error('[AdvisorSummaries] Schedule error:', err.message);
    res.status(500).json({ error: 'Failed to save schedule' });
  }
});

export default router;

// ─── Cron advisorPrecompute ─────────────────────────────────────────────────

const LLM_CONCURRENCY = 3;

interface PoolOptions {
  concurrency: number;
}

/** Мини-пул: не больше `concurrency` параллельных задач (LLM-вызовов). */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const lanes = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (idx < items.length) {
      const item = items[idx++];
      try {
        await worker(item);
      } catch (err: any) {
        console.error('[AdvisorSummaries] Worker error:', err.message);
      }
    }
  });
  await Promise.all(lanes);
}

/**
 * Прогон precompute для часа `hourMsk` (0–23): пользователи с multi_portfolio,
 * у которых есть не-архивные клиенты и hourMsk входит в эффективные слоты.
 * Лог: [AdvisorSummaries] slot=HHMSK users=A clients=B generated=C
 * skipped_empty=D duration=Xs. Возвращает агрегаты (для триггера).
 */
export async function runAdvisorPrecompute(hourMsk?: number, opts?: PoolOptions): Promise<{ slot: number; users: number; clients: number; generated: number; skippedEmpty: number }> {
  const slot = hourMsk ?? currentMskHour();
  const startedAt = Date.now();

  const clientsResult = await query(
    `SELECT c.id AS client_id, c.advisor_user_id AS user_id
     FROM advisor_clients c
     WHERE c.is_archived = FALSE
     ORDER BY c.advisor_user_id, c.sort_order ASC`,
    []
  );

  // Группировка по пользователю с одним проходом hasFeature на пользователя
  const byUser = new Map<string, number[]>();
  for (const row of clientsResult.rows) {
    const uid = row.user_id as string;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid)!.push(Number(row.client_id));
  }

  const jobs: { userId: string; clientId: number }[] = [];
  const slotUsers: string[] = [];
  for (const [userId, clientIds] of byUser) {
    if (!(await hasFeature(userId, 'multi_portfolio'))) continue;
    const slots = await getEffectiveSlots(userId);
    if (!slots.includes(slot)) continue;
    slotUsers.push(userId);
    for (const clientId of clientIds) jobs.push({ userId, clientId });
  }

  let generated = 0;
  let skippedEmpty = 0;
  const usersInSlot = new Set(jobs.map((j) => j.userId)).size;
  const concurrency = opts?.concurrency ?? LLM_CONCURRENCY;

  await runPool(jobs, concurrency, async (job) => {
    const result = await generateClientSummary(job.clientId, DEFAULT_PERIOD_HOURS);
    if (result.skippedEmpty) skippedEmpty++;
    else {
      generated++;
      // ТЗ-183 Задача 5: алерт сентимента по свежему саммари (LLM не нужен)
      try {
        await maybeSendSentimentAlert(job.userId, job.clientId);
      } catch (err: any) {
        console.error('[AdvisorAlerts] Error:', err.message);
      }
    }
  });

  // ТЗ-183 Задачи 3–4: после прогона пула — сводный дайджест и топ-5 новостей
  // в TG пользователям слота (без LLM-вызовов). Ошибки одного пользователя
  // не роняют рассылку остальным.
  for (const userId of slotUsers) {
    try {
      const sent = await sendAdvisorSlotMessages(userId, slot);
      if (sent.digest || sent.news) {
        console.log(`[AdvisorDigest] user=${userId} digest=${sent.digest} news=${sent.news}`);
      }
    } catch (err: any) {
      console.error('[AdvisorDigest] Send error:', err.message);
    }
  }

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[AdvisorSummaries] slot=${String(slot).padStart(2, '0')}MSK users=${usersInSlot} clients=${jobs.length} generated=${generated} skipped_empty=${skippedEmpty} duration=${durationSec}s`);
  return { slot, users: usersInSlot, clients: jobs.length, generated, skippedEmpty };
}

/** Регистрация cron: ежечасно на 7-й минуте, тайзона Europe/Moscow. */
export function startAdvisorSummariesCron(opts?: { isShuttingDown?: () => boolean }): void {
  cron.schedule('7 * * * *', async () => {
    if (opts?.isShuttingDown?.()) return;
    const acquired = await acquireCronLock('advisor-precompute');
    if (!acquired) return;
    try {
      await runAdvisorPrecompute();
    } catch (err: any) {
      console.error('[Cron] Advisor precompute failed:', err.message);
    } finally {
      await releaseCronLock('advisor-precompute');
    }
  }, { timezone: 'Europe/Moscow' });
  console.log('[Cron] Advisor summaries precompute scheduled hourly at :07 Europe/Moscow');
}
