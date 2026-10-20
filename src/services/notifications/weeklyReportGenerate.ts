/**
 * PULSE — Фаза генерации снапшотов еженедельного отчёта (ТЗ-191, Задача 1).
 *
 * Воскресенье 11:00 МСК, ДО рассылки (13:00): по всем entitled-юзерам
 * (свежая проверка тарифа getEntitlement — quiet hours и подписки на каналы
 * здесь НЕ участвуют, страница обещана всем entitled) строится контент,
 * генерируются AI-саммари (≤6 LLM-вызовов) и всё сохраняется одним upsertом.
 *
 * Конкурентность ≤5 юзеров одновременно (пул на промисах, без зависимостей),
 * LLM-вызовы внутри юзера последовательные (пауза 1–2 с — в weeklySummaryAI).
 * Per-user изоляция: ошибка юзера → console.error + счётчик, остальные получают
 * отчёты. Повторный прогон в ту же неделю — upsert, id стабилен (решение 4).
 */

import { query } from '../../config/db';
import { getEntitlement } from './entitlement';
import { hasFeature } from '../subscription';
import { buildWeeklyReportContent } from './weeklyReportContent';
import { generateWeeklyAISummaries } from './weeklySummaryAI';
import {
  saveWeeklyReportSnapshot,
  issueReportAccessToken,
} from './weeklyReportSnapshot';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const CONCURRENCY = 5;

export interface WeeklyGenerateResult {
  /** снапшотов создано/обновлено */
  generated: number;
  /** юзеров с ошибкой (LLM/БД/что угодно) */
  errors: number;
  /** фактических HTTP-вызовов Moonshot (аудит) */
  llmCalls: number;
}

/**
 * Кандидаты на генерацию: юзеры на платном плане (price_monthly > 0) внутри
 * оплаченного периода или grace (3 дня — константа GRACE_DAYS). Это только
 * предфильтр: финальное решение — getEntitlement per-user (свежая проверка).
 */
async function listCandidateUsers(): Promise<string[]> {
  const graceThreshold = USE_SQLITE
    ? "datetime('now', '-3 days')"
    : "NOW() - INTERVAL '3 days'";
  const result = await query(
    `SELECT u.id
     FROM users u
     JOIN subscription_plans p ON p.id = u.subscription_plan
     WHERE COALESCE(p.price_monthly, 0) > 0
       AND u.subscription_expires_at IS NOT NULL
       AND u.subscription_expires_at > ${graceThreshold}`,
    []
  );
  return result.rows.map((r: any) => r.id);
}

async function generateForUser(userId: string): Promise<{ llmCalls: number }> {
  // 1. Свежая проверка тарифа (конвенция getEntitlement)
  const ent = await getEntitlement(userId, 'weekly_report');
  if (!ent.allowed) {
    console.log(`[WeeklyReportGenerate] user=${userId} skip: ${ent.reason}`);
    return { llmCalls: 0 };
  }

  // 2. Контент (с stats из ТЗ-184) — как в фазе отправки раньше
  const content = await buildWeeklyReportContent(userId, ent.maxTags);
  if (!content || content.tagSummaries.length === 0) {
    console.log(`[WeeklyReportGenerate] user=${userId} no content, skipped`);
    return { llmCalls: 0 };
  }

  // 3. AI-саммари (бюджет ≤6 вызовов; пер-теговые — за фичей ai_summary)
  const perTagEnabled = await hasFeature(userId, 'ai_summary');
  const ai = await generateWeeklyAISummaries(content, { perTagEnabled });

  // 4. Снапшот (upsert по (user_id, week_start)) + magic-токен (один на отчёт)
  const saved = await saveWeeklyReportSnapshot(userId, content, ai.summaries);
  await issueReportAccessToken(saved.id);

  console.log(
    `[WeeklyReportGenerate] user=${userId} report=${saved.id} created=${saved.created} llm=${ai.llmCalls}`
  );
  return { llmCalls: ai.llmCalls };
}

/**
 * Точка входа cron '0 11 * * 0'. Счётчики уходят в cron_log
 * (weekly_report_generate) из workers.ts.
 */
export async function generateWeeklySnapshots(): Promise<WeeklyGenerateResult> {
  const candidates = await listCandidateUsers();
  console.log(`[WeeklyReportGenerate] ${candidates.length} candidate users, concurrency=${CONCURRENCY}`);

  const result: WeeklyGenerateResult = { generated: 0, errors: 0, llmCalls: 0 };
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < candidates.length) {
      const userId = candidates[cursor++];
      try {
        const r = await generateForUser(userId);
        result.generated++;
        result.llmCalls += r.llmCalls;
      } catch (err) {
        // Per-user изоляция: один юзер не должен лишить остальных отчёт
        result.errors++;
        console.error(`[WeeklyReportGenerate] user=${userId} error:`, err);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(
    `[WeeklyReportGenerate] done: ${result.generated} generated, ${result.errors} errors, ${result.llmCalls} llm calls`
  );
  return result;
}
