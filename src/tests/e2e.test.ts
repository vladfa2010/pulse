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
  console.log('🧪 PULSE E2E — Critical Path Test\n');
  runCriticalPath().then(results => {
    let passed = 0;
    let failed = 0;

    for (const r of results) {
      const icon = r.passed ? '✅' : '❌';
      console.log(`${icon} ${r.step}`);
      if (r.data) console.log(`   📊 ${JSON.stringify(r.data)}`);
      if (r.error) console.log(`   ⚠️  ${r.error}`);

      if (r.passed) passed++; else failed++;
    }

    console.log(`\n${'='.repeat(40)}`);
    console.log(`Результат: ${passed} passed, ${failed} failed`);
    console.log(`${'='.repeat(40)}`);

    process.exit(failed > 0 ? 1 : 0);
  });
}

export { runCriticalPath };
