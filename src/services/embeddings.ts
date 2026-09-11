/**
 * =============================================================================
 * PULSE — Клиент эмбеддинг-сервиса (ТЗ-91, этап 1)
 * =============================================================================
 *
 * Единая точка обращения к TEI (text-embeddings-inference) с моделью
 * Qwen3-Embedding-0.6B (dim 1024). Бекенд ходит по внутренней сети compose:
 *
 *   EMBEDDINGS_URL=http://embeddings:80  (дефолт, внутри docker-compose)
 *   EMBEDDINGS_URL=http://localhost:8080 (локальная отладка, loopback-порт)
 *
 * Поведение:
 *   - POST {EMBEDDINGS_URL}/embed, body {"inputs": [...]}, батч ≤ 32
 *     (лимит TEI --max-client-batch-size);
 *   - таймаут 30 с на запрос; при ошибке/таймауте — один retry через 5 с, затем throw;
 *   - валидация ответа: массив той же длины, каждый вектор длины 1024.
 *
 * Текст для эмбеддинга (единый формат по всему проекту):
 *   title_ru + ' ' + COALESCE(summary_ru, ''), обрезка до 1000 символов.
 *   Без instruction-префикса: задача симметричная (новость ↔ новость).
 *
 * Этап 1 сознательно НЕ меняет продовую логику — реалтайм-вызывающих
 * сторон у этой функции пока нет (ТЗ-92).
 */

const EMBEDDINGS_URL = (process.env.EMBEDDINGS_URL || 'http://embeddings:80').replace(/\/$/, '');

/** Максимальный размер батча — зеркалит --max-client-batch-size TEI (ТЗ-91) */
export const EMBEDDING_MAX_BATCH = 32;
/** Размерность вектора Qwen3-Embedding-0.6B */
export const EMBEDDING_DIM = 1024;
/** Обрезка текста перед эмбеддингом (ТЗ-91) */
export const EMBEDDING_MAX_TEXT = 1000;

// ТЗ-91 задавало 30 с, но на VDS с лимитом CPUs батч 16 текстов инференсится
// дольше; при параллельных воркерах TEI сериализует батчи в очередь
// (max-batch-tokens) и латентность запроса доходит до минут. 600 с с запасом:
// при 300 с ночной бэкфилл временами уходил в таймауты, батчи падали дважды
// и улетали в skipped (инцидент 2026-09-11).
const REQUEST_TIMEOUT_MS = 600_000;
const RETRY_DELAY_MS = 5_000;

/** Единый формат текста для эмбеддинга: заголовок + пробел + summary (обрезка 1000) */
export function embeddingText(titleRu: string | null, summaryRu: string | null): string {
  const text = `${titleRu || ''} ${summaryRu || ''}`.trim();
  return text.slice(0, EMBEDDING_MAX_TEXT);
}

// TEI (serde_json) отклоняет JSON с одиночными суррогатами: часть новостей в БД
// содержит битый Unicode из старых импортов → батч целиком получал HTTP 400
// («unexpected end of hex escape») и улетал в skipped (инцидент 2026-09-11).
// Убираем только НЕПАРНЫЕ суррогаты, легальные пары (эмодзи и т.п.) сохраняем.
function stripLoneSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postEmbed(texts: string[]): Promise<number[][]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${EMBEDDINGS_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: texts }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`TEI HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return data as number[][];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Эмбеддит батч текстов (≤ 32 шт.) через TEI.
 * Один retry через 5 с при ошибке/таймауте, затем throw.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error('embedBatch: пустой батч');
  }
  if (texts.length > EMBEDDING_MAX_BATCH) {
    throw new Error(`embedBatch: батч ${texts.length} > лимита ${EMBEDDING_MAX_BATCH}`);
  }

  // Санитизация Unicode: непарные суррогаты убивают весь батч (HTTP 400 от TEI)
  const cleanTexts = texts.map((t) => stripLoneSurrogates(t));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const vectors = await postEmbed(cleanTexts);
      // Валидация: массив той же длины, каждый вектор длины 1024
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        throw new Error(`TEI вернул ${Array.isArray(vectors) ? vectors.length : 'не массив'} векторов вместо ${texts.length}`);
      }
      for (const v of vectors) {
        if (!Array.isArray(v) || v.length !== EMBEDDING_DIM) {
          throw new Error(`TEI вернул вектор длины ${Array.isArray(v) ? v.length : 'не массив'} вместо ${EMBEDDING_DIM}`);
        }
      }
      return vectors;
    } catch (err) {
      lastErr = err;
      if (attempt === 1) {
        console.warn(`[Embeddings] Попытка 1 не удалась (${(err as Error).message}), retry через ${RETRY_DELAY_MS / 1000} с...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
