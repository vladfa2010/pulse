/**
 * PULSE — Радио: генерация диалога из общей сводки рынка (ТЗ-57 v2).
 *
 * Берёт готовый `summary` (строка) из кэша globalSummary (Kimi, крон 6ч —
 * бесплатно), отправляет в Minimax chat с промптом «преврати в подкаст».
 * Кэш диалога 6ч в in-memory Map. In-flight lock: конкурентные запросы
 * = один вызов LLM.
 *
 * Fallback-контракт: функция НИКОГДА не бросает. Любая ошибка → null
 * (роут вернёт 204, фронт озвучит plain text).
 *
 * Модель — env MINIMAX_CHAT_MODEL (не хардкодится: список моделей Minimax
 * меняется; утверждение v1 про "M2-her" не подтверждено).
 */
import { getCachedGlobalSummary } from './globalSummary';
import type { RadioSegment } from '../types/radio';

const MINIMAX_CHAT_URL = 'https://api.minimax.io/v1/chat/completions';
// TTL диалога — с запасом над TTL сводки (6ч+10мин): диалог генерируется
// кроном в паре со сводкой, окно 6ч30м гасит крайний случай «TTL диалога
// истёк, а сводка ещё жива» → стохастическая перегенерация (temperature 0.4)
// меняла бы тексты и обнуляла бы mp3-кеш (аудит кеша, находка 1).
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 + 30 * 60 * 1000; // 6ч30м
const REQUEST_TIMEOUT_MS = 30_000;
const CACHE_MAX = 50;

const SYSTEM_PROMPT = `Ты — редактор финансового радиоподкаста PULSE. В студии постоянные ведущие: Михаил (ведущий, host) и Татьяна (аналитик, guest). Преврати сводку новостей ниже в их диалог для устной подачи в эфире.

Формат:
- 6-8 реплик (host, guest, host, guest, …)
- Реплика 1 (host, Михаил): короткое приветствие ("Здравствуйте" или "Привет"), представляет гостью по имени ("Сегодня у нас в студии Татьяна — наш аналитик"), затем коротко представляет темы из сводки.
- Реплика 2 (guest, Татьяна): приветствие в ответ ("Привет, Михаил" или "Здравствуйте") + переход к первой теме.
- Дальше: Михаил задаёт вопросы и комментирует, Татьяна отвечает по существу с конкретными выводами и цифрами. Между ними естественный разговорный ритм, не допрос.
- Последняя реплика (host, Михаил): подытоживает ключевые выводы, прощается фразой "Продолжаем следить для вас за рынком".

Тон: уверенный аналитический, без markdown, без эмодзи, без ссылок.
Имена "Михаил" и "Татьяна" — только когда обращаются друг к другу, не в каждой реплике.
Цифры до десяти — словами ("три процента", не "3%").
Символы валют и процентов — словами.
Спецсимволы (@, &, →, {}) — словами или убери.
Аббревиатуры расшифруй при первом упоминании (ЦБ, ЕС, ОПЕК).
Списки переведи в связные предложения.
Добавь короткие связки между абзацами.
Ничего не добавляй от себя — только то, что есть в сводке.

Верни ТОЛЬКО валидный JSON, без markdown-обёрток:
{"dialog":[{"role":"host","text":"…"},{"role":"guest","text":"…"}]}`;

interface CacheEntry {
  segments: RadioSegment[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
let inflight: Promise<RadioSegment[] | null> | null = null;

/** Ключ кэша — первые 200 символов сводки (сводка одна на всех юзеров). */
function cacheKey(summary: string): string {
  return summary.slice(0, 200).replace(/\s+/g, ' ').trim();
}

function cacheGet(summary: string): RadioSegment[] | null {
  const key = cacheKey(summary);
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.segments;
}

function cacheSet(summary: string, segments: RadioSegment[]): void {
  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(cacheKey(summary), {
    segments,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/** Парсит ответ Minimax. Допускает обёртку ```json ... ``` и reasoning-блок
 * <think>...</think> (M2.x — reasoning-модели, мысли идут перед ответом).
 * Также снимает <answer>...</answer>. Строгий whitelist ролей. */
export function parseDialogResponse(raw: string): RadioSegment[] {
  let text = raw.trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  text = text.replace(/^<answer>\s*/i, '').replace(/\s*<\/answer>$/i, '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const json = JSON.parse(text);
  if (!json || !Array.isArray(json.dialog)) {
    throw new Error('Minimax returned invalid JSON: missing dialog[]');
  }
  return json.dialog.map((seg: any, i: number): RadioSegment => {
    if (typeof seg.text !== 'string' || !seg.text.trim()) {
      throw new Error(`Invalid segment ${i}: empty text`);
    }
    const role = seg.role === 'guest' ? 'guest' : 'host';
    return { role, text: seg.text.trim() };
  });
}

/** Boot-лог — вызывается один раз из index.ts при старте. */
export function logRadioPodcastConfig(): void {
  const hasKey = Boolean(process.env.MINIMAX_API_KEY);
  const model = process.env.MINIMAX_CHAT_MODEL;
  if (hasKey && model) {
    console.log(`[RadioPodcast] Minimax chat ready (model=${model})`);
  } else {
    console.log(
      `[RadioPodcast] chat disabled: MINIMAX_API_KEY=${hasKey ? 'set' : 'MISSING'}, ` +
        `MINIMAX_CHAT_MODEL=${model ?? 'MISSING'} — /api/market/market-dialog returns 204`
    );
  }
}

async function generateDialog(summary: string): Promise<RadioSegment[] | null> {
  const apiKey = process.env.MINIMAX_API_KEY;
  const model = process.env.MINIMAX_CHAT_MODEL;
  if (!apiKey || !model) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetch(MINIMAX_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: summary },
          ],
          max_tokens: 4000, // ТЗ-58: 6-8 реплик; M2.x — reasoning-модель, <think> тоже тратит лимит
          temperature: 0.4,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!upstream.ok) {
      console.error(`[RadioPodcast] Minimax chat HTTP ${upstream.status}`);
      return null;
    }
    const data: any = await upstream.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== 'string' || !raw.trim()) {
      console.warn('[RadioPodcast] Minimax returned empty content');
      return null;
    }
    const segments = parseDialogResponse(raw);
    if (segments.length === 0) {
      console.warn('[RadioPodcast] Minimax returned empty dialog[]');
      return null;
    }
    console.log(`[RadioPodcast] dialog generated: ${segments.length} segments`);
    cacheSet(summary, segments);
    return segments;
  } catch (err: any) {
    console.error('[RadioPodcast] Minimax chat error:', err?.message ?? err);
    return null;
  }
}

/**
 * Единая точка получения диалога по сводке с single-flight: параллельные
 * вызовы (крон-прогрев, юзерские запросы) делят один upstream-вызов.
 * Не бросает — null при ошибке.
 */
async function ensureDialog(summary: string): Promise<RadioSegment[] | null> {
  const hit = cacheGet(summary);
  if (hit) return hit;
  if (inflight) return inflight;
  inflight = generateDialog(summary).finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Главная функция. Возвращает диалог или null (нет сводки / нет конфигурации /
 * ошибка Minimax). Не бросает.
 */
export async function getMarketDialog(): Promise<RadioSegment[] | null> {
  const cached = getCachedGlobalSummary();
  if (!cached || !cached.summary) return null;
  const dialog = await ensureDialog(cached.summary);
  if (dialog) {
    console.log(`[RadioPodcast] dialog served (${dialog.length} segments)`);
  }
  return dialog;
}

/**
 * Аудит кеша, находка 1: крон сводки прогревает диалог СРАЗУ после генерации
 * сводки. Тексты диалога стабильны весь 6-часовой период → ключи mp3-кеша
 * не меняются → один cold-прогон T2A на период, а не на каждую перегенерацию.
 * Общий single-flight с getMarketDialog — дубль chat-вызова невозможен.
 * Не бросает; возвращает число сегментов (0 при ошибке).
 */
export async function primeMarketDialog(summary: string): Promise<number> {
  try {
    const dialog = await ensureDialog(summary);
    return dialog?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Для verify-скрипта: очистить кэш. */
export function invalidatePodcastCache(): void {
  cache.clear();
}
