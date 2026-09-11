/**
 * =============================================================================
 * PULSE — LLM-верификатор пар зоны сомнений (ТЗ-92, задача 3)
 * =============================================================================
 *
 * Конвенции вызова — строго как у smartTagMatcher (ТЗ-92): модель kimi-k2.6,
 * temperature 0.6 (thinking disabled), max_tokens с запасом, timeout 60000,
 * response_format: { type: 'json_object' }.
 *
 * Парсинг — ТОЛЬКО по явным ключам. ЗАПРЕЩЁН паттерн translate.ts:152-172
 * (Object.values без явных ключей — корневая причина утечки промпта в
 * title_ru, Методология §9.3): любое отсутствие ключа = пара ОТКЛОНЕНА
 * (fail-closed).
 *
 * Страховка стоимости: суточный потолок вызовов (VERIFIER_DAILY_LIMIT,
 * дефолт 2000). При превышении пары зоны сомнений отклоняются, счётчик в лог.
 *
 * Все вызовы логируются (пара id, sim, вердикт, latency) — данные для аудита.
 */

import axios from 'axios';
import { CLUSTER_VERIFIER_PROMPT_TEMPLATE } from './clusterVerifierPrompt';
import {
  VERIFIER_DAILY_LIMIT,
  VERIFIER_MODEL_TEMPERATURE,
  VERIFIER_TIMEOUT_MS,
  VERIFIER_MAX_TOKENS,
} from '../config/clustering';

const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.6';

export interface PairSide {
  id: string;
  title: string;
  summary: string;
  source?: string;
  publishedAt?: string;
}

export interface PairVerdict {
  sameEvent: boolean;
  confidence: number;
  reason: string;
}

// Суточный счётчик (in-memory, сброс по дате UTC)
let dailyCount = 0;
let dailyCountDate = '';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getVerifierDailyCount(): { date: string; count: number } {
  return { date: dailyCountDate, count: dailyCount };
}

function fillTemplate(prompt: string, vars: Record<string, string>): string {
  let out = prompt;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}

export async function verifyPair(a: PairSide, b: PairSide, sim: number): Promise<PairVerdict> {
  const date = todayUtc();
  if (dailyCountDate !== date) {
    dailyCountDate = date;
    dailyCount = 0;
  }
  if (dailyCount >= VERIFIER_DAILY_LIMIT) {
    console.warn(
      `[ClusterVerifier] суточный лимит ${VERIFIER_DAILY_LIMIT} исчерпан — пара ${a.id} ↔ ${b.id} (sim=${sim.toFixed(3)}) ОТКЛОНЕНА`
    );
    return { sameEvent: false, confidence: 0, reason: 'daily_limit' };
  }

  if (!KIMI_API_KEY) {
    console.warn('[ClusterVerifier] KIMI_API_KEY не задан — пара отклонена (fail-closed)');
    return { sameEvent: false, confidence: 0, reason: 'no_api_key' };
  }

  const prompt = fillTemplate(CLUSTER_VERIFIER_PROMPT_TEMPLATE, {
    TITLE_A: (a.title || '').slice(0, 300),
    SOURCE_A: a.source || '—',
    PUBLISHED_A: a.publishedAt ? a.publishedAt.slice(0, 16).replace('T', ' ') : '—',
    TITLE_B: (b.title || '').slice(0, 300),
    SOURCE_B: b.source || '—',
    PUBLISHED_B: b.publishedAt ? b.publishedAt.slice(0, 16).replace('T', ' ') : '—',
    SUMMARY_A_BLOCK: a.summary
      ? `Дополнительный контекст новости A: ${a.summary.slice(0, 400)}\n\n`
      : '',
  });

  const startedAt = Date.now();
  let content = '';
  try {
    const response = await axios.post(
      'https://api.moonshot.ai/v1/chat/completions',
      {
        model: KIMI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: KIMI_MODEL.startsWith('kimi-k') ? VERIFIER_MODEL_TEMPERATURE : 0.1,
        max_tokens: VERIFIER_MAX_TOKENS,
        response_format: { type: 'json_object' },
        thinking: KIMI_MODEL.startsWith('kimi-k') ? { type: 'disabled' } : undefined,
      },
      {
        headers: { Authorization: `Bearer ${KIMI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: VERIFIER_TIMEOUT_MS,
      }
    );
    content = response.data?.choices?.[0]?.message?.content || '';
  } catch (err: any) {
    console.warn(`[ClusterVerifier] LLM-ошибка (sim=${sim.toFixed(3)}): ${err.message?.slice(0, 120)}`);
    return { sameEvent: false, confidence: 0, reason: 'llm_error' };
  }

  dailyCount++;
  const latency = Date.now() - startedAt;

  // Парсинг ТОЛЬКО по явным ключам; любое отсутствие = отклонено (fail-closed)
  let parsed: any = null;
  try {
    const raw = content.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[ClusterVerifier] невалидный JSON (latency=${latency}мс) — пара отклонена`);
    return logAndReturn(a, b, sim, { sameEvent: false, confidence: 0, reason: 'bad_json' }, latency);
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.same_fact !== 'boolean' ||
    typeof parsed.confidence !== 'number' ||
    typeof parsed.reason !== 'string'
  ) {
    console.warn(`[ClusterVerifier] отсутствуют обязательные ключи — пара отклонена (fail-closed)`);
    return logAndReturn(a, b, sim, { sameEvent: false, confidence: 0, reason: 'missing_keys' }, latency);
  }

  const verdict: PairVerdict = {
    sameEvent: parsed.same_fact,
    confidence: Math.min(1, Math.max(0, parsed.confidence)),
    reason: parsed.reason.slice(0, 500),
  };
  return logAndReturn(a, b, sim, verdict, latency);
}

function logAndReturn(
  a: PairSide,
  b: PairSide,
  sim: number,
  verdict: PairVerdict,
  latency: number
): PairVerdict {
  // Аудит качества: пара id, sim, вердикт, latency
  console.log(
    `[ClusterVerifier] ${a.id} ↔ ${b.id} sim=${sim.toFixed(3)} ` +
      `same_event=${verdict.sameEvent} conf=${verdict.confidence.toFixed(2)} ` +
      `latency=${latency}мс reason="${verdict.reason}"`
  );
  return verdict;
}
