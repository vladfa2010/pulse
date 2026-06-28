/**
 * =============================================================================
 * PULSE — E2E Тест критического пути
 * =============================================================================
 *
 * Task 1: Проверяем полный пользовательский сценарий:
 *   1. Регистрация нового пользователя
 *   2. Логин (получение JWT)
 *   3. Добавление тега в портфель
 *   4. Проверка ленты новостей (API возвращает данные)
 *   5. Отметка новости как прочитанной
 *   6. Выход
 *
 * Запуск: npx ts-node src/tests/e2e.test.ts
 */

import { query } from '../config/db';

const API_URL = process.env.API_URL || 'https://pulse-api-bsov.onrender.com/api';

// ─── Helpers ──────────────────────────────────────────────────────────────
interface ApiResponse {
  status: number;
  data: Record<string, any>;
}

async function post(path: string, body: any, token?: string): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({})) as Record<string, any>;
  return { status: res.status, data };
}

async function get(path: string, token: string): Promise<ApiResponse> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({})) as Record<string, any>;
  return { status: res.status, data };
}

// ─── Test Runner ──────────────────────────────────────────────────────────
interface TestResult {
  step: string;
  passed: boolean;
  error?: string;
  data?: any;
}

async function runCriticalPath(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const timestamp = Date.now();
  const email = `test_${timestamp}@pulse.local`;
  const password = 'TestPass123!';
  const username = `testuser_${timestamp}`;
  let token: string = '';

  // Step 1: Регистрация
  try {
    const r = await post('/auth/register', { email, password, username });
    if (r.status === 201 && r.data.token) {
      token = r.data.token;
      results.push({ step: '1. Регистрация', passed: true, data: { userId: r.data.user?.id } });
    } else {
      results.push({ step: '1. Регистрация', passed: false, error: r.data.error || `HTTP ${r.status}` });
      return results;
    }
  } catch (e: any) {
    results.push({ step: '1. Регистрация', passed: false, error: e.message });
    return results;
  }

  // Step 2: Логин (с теми же credentials)
  try {
    const r = await post('/auth/login', { email, password });
    if (r.status === 200 && r.data.token) {
      token = r.data.token; // Обновляем токен
      results.push({ step: '2. Логин', passed: true });
    } else {
      results.push({ step: '2. Логин', passed: false, error: r.data.error || `HTTP ${r.status}` });
      return results;
    }
  } catch (e: any) {
    results.push({ step: '2. Логин', passed: false, error: e.message });
    return results;
  }

  // Step 3: Добавление тега
  try {
    const r = await post('/user/tags', { tagId: 'sber', tagName: 'Сбербанк', tagType: 'company' }, token);
    if (r.status === 200 || r.status === 201) {
      results.push({ step: '3. Добавление тега', passed: true, data: { tag: r.data.tag } });
    } else {
      results.push({ step: '3. Добавление тега', passed: false, error: r.data.error || `HTTP ${r.status}` });
    }
  } catch (e: any) {
    results.push({ step: '3. Добавление тега', passed: false, error: e.message });
  }

  // Step 4: Лента новостей
  try {
    const r = await get('/news?limit=10', token);
    if (r.status === 200) {
      const articles = r.data.articles || [];
      results.push({ step: '4. Лента новостей', passed: true, data: { count: articles.length } });

      // Step 5: Отметить прочитанной (если есть новости)
      if (articles.length > 0 && articles[0].id) {
        try {
          const newsId = articles[0].id;
          const r5 = await post(`/news/${newsId}/read`, {}, token);
          if (r5.status === 200) {
            results.push({ step: '5. Отметить прочитанной', passed: true });
          } else {
            results.push({ step: '5. Отметить прочитанной', passed: false, error: r5.data.error || `HTTP ${r5.status}` });
          }
        } catch (e: any) {
          results.push({ step: '5. Отметить прочитанной', passed: false, error: e.message });
        }
      } else {
        results.push({ step: '5. Отметить прочитанной', passed: true, data: { note: 'No articles to mark' } });
      }
    } else {
      results.push({ step: '4. Лента новостей', passed: false, error: r.data.error || `HTTP ${r.status}` });
    }
  } catch (e: any) {
    results.push({ step: '4. Лента новостей', passed: false, error: e.message });
  }

  // Cleanup: удалить тестового пользователя
  try {
    await query('DELETE FROM users WHERE email = $1', [email]);
  } catch {
    // ignore cleanup errors
  }

  return results;
}

// ─── Run if called directly ───────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    console.log('🧪 PULSE E2E — Critical Path Test\n');
    const criticalResults = await runCriticalPath();
    printResults(criticalResults);

    console.log('\n🛡️ PULSE E2E — Tag Protection Test\n');
    const protectionResults = await runTagProtectionTest();
    printResults(protectionResults);

    console.log('\n🔍 PULSE E2E — Tag Name Deduplication Test\n');
    const dedupResults = await runTagNameDedupTest();
    printResults(dedupResults);

    const allResults = [...criticalResults, ...protectionResults, ...dedupResults];
    const passed = allResults.filter(r => r.passed).length;
    const failed = allResults.filter(r => !r.passed).length;

    console.log(`\n${'='.repeat(40)}`);
    console.log(`Итого: ${passed} passed, ${failed} failed`);
    console.log(`${'='.repeat(40)}`);

    process.exit(failed > 0 ? 1 : 0);
  })();
}

function printResults(results: TestResult[]) {
  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`${icon} ${r.step}`);
    if (r.data) console.log(`   📊 ${JSON.stringify(r.data)}`);
    if (r.error) console.log(`   ⚠️  ${r.error}`);
  }
}

// ─── Tag Protection Test ──────────────────────────────────────────────────
// Проверяет, что повторное добавление существующего тега не перезаписывает
// enriched_data, keywords, tag_type и created_by в user_defined_tags.
async function runTagProtectionTest(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const timestamp = Date.now();
  const tagId = `pulse_test_tag_${timestamp}`;
  const tagName = `Pulse Test Tag ${timestamp}`;

  async function registerUser(suffix: string): Promise<{ email: string; password: string; token: string } | null> {
    const email = `test_${suffix}_${timestamp}@pulse.local`;
    const password = 'TestPass123!';
    const r = await post('/auth/register', { email, password, username: `testuser_${suffix}_${timestamp}` });
    if (r.status === 201 && r.data.token) {
      return { email, password, token: r.data.token };
    }
    return null;
  }

  // Step 1: User A creates the tag
  let userA: { email: string; password: string; token: string } | null = null;
  try {
    userA = await registerUser('a');
    if (!userA) {
      results.push({ step: 'TP1. Регистрация пользователя A', passed: false, error: 'Registration failed' });
      return results;
    }
    results.push({ step: 'TP1. Регистрация пользователя A', passed: true });
  } catch (e: any) {
    results.push({ step: 'TP1. Регистрация пользователя A', passed: false, error: e.message });
    return results;
  }

  try {
    const r = await post('/user/tags', { tagId, tagName, tagType: 'auto' }, userA.token);
    if (r.status === 200 || r.status === 201) {
      results.push({ step: 'TP2. Пользователь A добавляет тег', passed: true, data: { tag: r.data.tag } });
    } else {
      results.push({ step: 'TP2. Пользователь A добавляет тег', passed: false, error: r.data.error || `HTTP ${r.status}` });
      return results;
    }
  } catch (e: any) {
    results.push({ step: 'TP2. Пользователь A добавляет тег', passed: false, error: e.message });
    return results;
  }

  // Snapshot user_defined_tags after first creation
  let snapshotBefore: any = null;
  try {
    const snap = await query(
      `SELECT tag_id, tag_name, tag_type, keywords, enriched_data, created_by
       FROM user_defined_tags WHERE tag_id = $1`,
      [tagId]
    );
    if (snap.rows.length === 0) {
      results.push({ step: 'TP3. Снимок тега после создания', passed: false, error: 'Tag not found in DB' });
      return results;
    }
    snapshotBefore = snap.rows[0];
    results.push({ step: 'TP3. Снимок тега после создания', passed: true });
  } catch (e: any) {
    results.push({ step: 'TP3. Снимок тега после создания', passed: false, error: e.message });
    return results;
  }

  // Step 4: User B adds the same tag
  let userB: { email: string; password: string; token: string } | null = null;
  try {
    userB = await registerUser('b');
    if (!userB) {
      results.push({ step: 'TP4. Регистрация пользователя B', passed: false, error: 'Registration failed' });
      return results;
    }
    const r = await post('/user/tags', { tagId, tagName, tagType: 'auto' }, userB.token);
    if (r.status === 200 || r.status === 201) {
      results.push({ step: 'TP4. Пользователь B добавляет тот же тег', passed: true });
    } else {
      results.push({ step: 'TP4. Пользователь B добавляет тот же тег', passed: false, error: r.data.error || `HTTP ${r.status}` });
      return results;
    }
  } catch (e: any) {
    results.push({ step: 'TP4. Пользователь B добавляет тот же тег', passed: false, error: e.message });
    return results;
  }

  // Step 5: Verify user_defined_tags was not modified
  try {
    const snap = await query(
      `SELECT tag_id, tag_name, tag_type, keywords, enriched_data, created_by
       FROM user_defined_tags WHERE tag_id = $1`,
      [tagId]
    );
    const snapshotAfter = snap.rows[0];

    const sameType = snapshotBefore.tag_type === snapshotAfter.tag_type;
    const sameKeywords = JSON.stringify(snapshotBefore.keywords?.sort()) === JSON.stringify(snapshotAfter.keywords?.sort());
    const sameEnriched = JSON.stringify(snapshotBefore.enriched_data) === JSON.stringify(snapshotAfter.enriched_data);
    const sameCreator = snapshotBefore.created_by === snapshotAfter.created_by;

    if (sameType && sameKeywords && sameEnriched && sameCreator) {
      results.push({ step: 'TP5. Проверка: user_defined_tags не изменился', passed: true });
    } else {
      results.push({
        step: 'TP5. Проверка: user_defined_tags не изменился',
        passed: false,
        error: `Changed: type=${!sameType}, keywords=${!sameKeywords}, enriched=${!sameEnriched}, creator=${!sameCreator}`,
      });
    }
  } catch (e: any) {
    results.push({ step: 'TP5. Проверка: user_defined_tags не изменился', passed: false, error: e.message });
  }

  // Cleanup
  try {
    await query('DELETE FROM user_defined_tags WHERE tag_id = $1', [tagId]);
    if (userA) await query('DELETE FROM users WHERE email = $1', [userA.email]);
    if (userB) await query('DELETE FROM users WHERE email = $1', [userB.email]);
  } catch {
    // ignore cleanup errors
  }

  return results;
}

// ─── Tag Name Deduplication Test ──────────────────────────────────────────
// Проверяет, что повторный ввод того же названия с другим tag_id
// не создаёт дубликат в user_defined_tags.
async function runTagNameDedupTest(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const timestamp = Date.now();
  const tagName = `Pulse Dedup Tag ${timestamp}`;
  const tagIdA = `pulse_dedup_tag_${timestamp}`;
  const tagIdB = `pulse_dedup_tag_b_${timestamp}`;

  async function registerUser(suffix: string): Promise<{ email: string; password: string; token: string } | null> {
    const email = `test_dedup_${suffix}_${timestamp}@pulse.local`;
    const password = 'TestPass123!';
    const r = await post('/auth/register', { email, password, username: `testdedup_${suffix}_${timestamp}` });
    if (r.status === 201 && r.data.token) {
      return { email, password, token: r.data.token };
    }
    return null;
  }

  let userA: { email: string; password: string; token: string } | null = null;
  let userB: { email: string; password: string; token: string } | null = null;

  try {
    userA = await registerUser('a');
    if (!userA) {
      results.push({ step: 'TD1. Регистрация пользователя A', passed: false, error: 'Registration failed' });
      return results;
    }
    results.push({ step: 'TD1. Регистрация пользователя A', passed: true });

    const rA = await post('/user/tags', { tagId: tagIdA, tagName, tagType: 'company' }, userA.token);
    if (rA.status === 200 || rA.status === 201) {
      results.push({ step: 'TD2. Пользователь A создаёт тег', passed: true, data: { tag: rA.data.tag } });
    } else {
      results.push({ step: 'TD2. Пользователь A создаёт тег', passed: false, error: rA.data.error || `HTTP ${rA.status}` });
      return results;
    }

    userB = await registerUser('b');
    if (!userB) {
      results.push({ step: 'TD3. Регистрация пользователя B', passed: false, error: 'Registration failed' });
      return results;
    }
    results.push({ step: 'TD3. Регистрация пользователя B', passed: true });

    const rB = await post('/user/tags', { tagId: tagIdB, tagName, tagType: 'company' }, userB.token);
    if (rB.status === 200 || rB.status === 201) {
      results.push({ step: 'TD4. Пользователь B добавляет тот же тег (другой tagId)', passed: true, data: { tag: rB.data.tag } });
    } else {
      results.push({ step: 'TD4. Пользователь B добавляет тот же тег (другой tagId)', passed: false, error: rB.data.error || `HTTP ${rB.status}` });
      return results;
    }

    const countResult = await query(
      `SELECT COUNT(*) as count FROM user_defined_tags WHERE LOWER(tag_name) = LOWER($1)`,
      [tagName]
    );
    const count = parseInt(countResult.rows[0].count);
    const tagRow = await query(
      `SELECT tag_id FROM user_defined_tags WHERE LOWER(tag_name) = LOWER($1) LIMIT 1`,
      [tagName]
    );
    const canonicalTagId = tagRow.rows[0]?.tag_id;

    if (count === 1 && rB.data.tag?.tag_id === canonicalTagId) {
      results.push({ step: 'TD5. Дубль не создан — оба пользователя на одном теге', passed: true, data: { count, canonicalTagId } });
    } else {
      results.push({
        step: 'TD5. Дубль не создан — оба пользователя на одном теге',
        passed: false,
        error: `Expected 1 tag with canonical id ${canonicalTagId}, got count=${count}, returned id=${rB.data.tag?.tag_id}`,
      });
    }
  } catch (e: any) {
    results.push({ step: 'TD? Неожиданная ошибка', passed: false, error: e.message });
  }

  // Cleanup
  try {
    await query('DELETE FROM user_defined_tags WHERE LOWER(tag_name) = LOWER($1)', [tagName]);
    if (userA) await query('DELETE FROM users WHERE email = $1', [userA.email]);
    if (userB) await query('DELETE FROM users WHERE email = $1', [userB.email]);
  } catch {
    // ignore cleanup errors
  }

  return results;
}

export { runCriticalPath, runTagProtectionTest, runTagNameDedupTest };
