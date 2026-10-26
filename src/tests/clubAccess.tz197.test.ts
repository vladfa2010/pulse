/**
 * =============================================================================
 * PULSE — TZ-197-club: доступ в закрытый TG-канал «Клуб» (юнит-тесты)
 * =============================================================================
 *
 * Покрытие (критерии приёмки ТЗ-197 v2/v3, backend-логика без HTTP):
 *   1. hasClubAccess() / getClubAccessInfo() на сидированном SQLite:
 *      - тариф с club_access, подписка активна → доступ (reason='tariff');
 *      - истёкшая подписка внутри grace (3 дня) → доступ есть;
 *      - истёкшая подписка мимо grace → доступа нет;
 *      - фича выключена в features_registry → доступа нет (feature_disabled),
 *        даже при активной подписке;
 *      - ручная выдача (is_manual, без отзыва) → доступ (reason='manual');
 *      - ручная выдача отозвана → доступа нет (без тарифа);
 *      - у пользователя без строки и без тарифа → нет.
 *   2. auditClubAccess() (крон-логика, Bot API не сконфигурирован →
 *      kick/revoke деградируют в no-op, статусы в БД обновляются):
 *      - member без доступа → status='kicked', kick_reason='subscription_expired';
 *      - member с активной ручной выдачей и без тарифа → НЕ тронут (v2);
 *      - invited без доступа → status='kicked', kick_reason='invite_expired' (v3);
 *      - invited с доступом → ссылка/статус сохраняются.
 *
 * Webhook-хендлер (chat_member) намеренно не покрываем — там thin-ветка в
 * routes/webhook.ts, логика матчинга/доступа проверена здесь напрямую.
 *
 * Запуск:  TS_NODE_TRANSPILE_ONLY=true npx ts-node src/tests/clubAccess.tz197.test.ts
 */

process.env.USE_SQLITE = 'true';

import fs from 'fs';
import os from 'os';
import path from 'path';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: any) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

async function seedUser(id: string, email: string, plan: string, expiresAtMs: number | null) {
  const sqlite = await import('../config/db-sqlite');
  await sqlite.query(
    `INSERT INTO users (id, email, username, password_hash, subscription_plan, subscription_expires_at, subscription_active)
     VALUES (?, ?, ?, 'hash', ?, ?, 1)`,
    [id, email, id, plan, expiresAtMs ? iso(expiresAtMs) : null]
  );
}

async function setFeatureActive(active: boolean) {
  const sqlite = await import('../config/db-sqlite');
  await sqlite.query(`UPDATE features_registry SET is_active = ? WHERE id = 'club_access'`, [active ? 1 : 0]);
  const { invalidateFeaturesRegistryCache } = await import('../services/subscription');
  invalidateFeaturesRegistryCache();
}

async function resetCaches() {
  const { invalidatePlansCache, invalidateFeaturesRegistryCache } = await import('../services/subscription');
  invalidatePlansCache();
  invalidateFeaturesRegistryCache();
}

async function main(): Promise<void> {
  process.env.SQLITE_FILE = path.join(os.tmpdir(), `tz197-club-${Date.now()}.db`);
  const sqlite = await import('../config/db-sqlite');
  await sqlite.initSQLite();
  await sqlite.initSQLiteSchema(); // сеет subscription_plans (club с club_access) + features_registry
  await resetCaches();

  const club = await import('../services/club');

  const now = Date.now();

  // ─── Пользователи ──────────────────────────────────────────────────────
  await seedUser('u-active', 'active@test.ru', 'club', now + 30 * DAY);      // тариф живой
  await seedUser('u-grace', 'grace@test.ru', 'club', now - 2 * DAY);         // grace (день 2 из 3)
  await seedUser('u-expired', 'expired@test.ru', 'club', now - 4 * DAY);     // мимо grace
  await seedUser('u-base', 'base@test.ru', 'base', now + 30 * DAY);          // тариф без club_access
  await seedUser('u-none', 'none@test.ru', 'free', null);                    // без тарифа

  // ─── 1. hasClubAccess / getClubAccessInfo ──────────────────────────────
  console.log('\nTZ-197-club.1 hasClubAccess() (SQLite, тариф ИЛИ manual):');

  let info = await club.getClubAccessInfo('u-active');
  check('активный club-тариф → доступ, reason=tariff',
    info.hasAccess && info.reason === 'tariff', info);

  info = await club.getClubAccessInfo('u-grace');
  check('grace (2 день из 3) → доступ сохраняется',
    info.hasAccess && info.reason === 'tariff', info);

  info = await club.getClubAccessInfo('u-expired');
  check('истёк мимо grace → доступа нет, tariffLost=expired',
    !info.hasAccess && info.reason === 'none' && info.tariffLost === 'expired', info);

  info = await club.getClubAccessInfo('u-base');
  check('тариф без флага club_access → доступа нет',
    !info.hasAccess, info);

  info = await club.getClubAccessInfo('u-none');
  check('free без строки в клубе → доступа нет',
    !info.hasAccess && info.reason === 'none', info);

  // feature_disabled: подписка активна, но фича выключена в registry
  await setFeatureActive(false);
  info = await club.getClubAccessInfo('u-active');
  check('фича выключена в registry (подписка активна) → доступа нет, tariffLost=feature_disabled',
    !info.hasAccess && info.tariffLost === 'feature_disabled', info);
  await setFeatureActive(true);
  info = await club.getClubAccessInfo('u-active');
  check('фича включена обратно → доступ вернулся', info.hasAccess, info);

  // manual grant (v2)
  await sqlite.query(
    `INSERT INTO telegram_club_members (user_id, status, is_manual)
     VALUES ('u-none', 'invited', 1)`, []);
  await resetCaches();
  info = await club.getClubAccessInfo('u-none');
  check('ручная выдача без тарифа → доступ, reason=manual',
    info.hasAccess && info.reason === 'manual', info);

  await sqlite.query(
    `UPDATE telegram_club_members SET manual_revoked_at = datetime('now') WHERE user_id = 'u-none'`, []);
  info = await club.getClubAccessInfo('u-none');
  check('ручная выдача отозвана → доступа нет (тарифа нет)',
    !info.hasAccess && info.reason === 'none', info);

  // ─── 2. auditClubAccess ────────────────────────────────────────────────
  console.log('\nTZ-197-club.2 auditClubAccess() (чистая логика аудита):');

  // member с тарифом, потерянным мимо grace → kicked/subscription_expired
  await sqlite.query(
    `INSERT INTO telegram_club_members (user_id, tg_user_id, status, joined_at, is_manual)
     VALUES ('u-expired', '111', 'member', datetime('now'), 0)`, []);
  // member без тарифа и без активной ручной выдачи → kicked (строка u-none уже есть — UPDATE)
  await sqlite.query(
    `UPDATE telegram_club_members
     SET tg_user_id = '222', status = 'member', joined_at = datetime('now'), is_manual = 0, manual_revoked_at = datetime('now')
     WHERE user_id = 'u-none'`, []);
  await sqlite.query(
    `INSERT INTO telegram_club_members (user_id, tg_user_id, status, joined_at, is_manual, manual_revoked_at)
     VALUES ('u-base', '333', 'member', datetime('now'), 1, NULL)`, []); // u-base: manual активен → не тронут
  // invited без доступа → invite_expired (v3); invited с доступом → не тронут
  await sqlite.query(
    `INSERT INTO telegram_club_members (user_id, status, invite_link, is_manual)
     VALUES ('u-grace', 'invited', 'https://t.me/+deadbeef', 0)`, []); // grace = доступ есть → остаётся
  await seedUser('u-invited-expired', 'inv-exp@test.ru', 'club', now - 5 * DAY);
  await sqlite.query(
    `INSERT INTO telegram_club_members (user_id, status, invite_link, is_manual)
     VALUES ('u-invited-expired', 'invited', 'https://t.me/+cafebabe', 0)`, []);
  await resetCaches();

  const stats = await club.auditClubAccess();
  const rowOf = async (uid: string) =>
    (await sqlite.query(`SELECT * FROM telegram_club_members WHERE user_id = ?`, [uid])).rows[0];

  const rExpired = await rowOf('u-expired');
  check('аудит: member без доступа → kicked / subscription_expired',
    rExpired.status === 'kicked' && rExpired.kick_reason === 'subscription_expired', rExpired);
  check('аудит: kicked ≥ 1 (u-expired + u-none)', stats.kicked >= 1, stats);

  const rNone = await rowOf('u-none');
  check('аудит: member без тарифа и без активной ручной выдачи → kicked',
    rNone.status === 'kicked' && rNone.kick_reason === 'subscription_expired', rNone);

  const rManual = await rowOf('u-base');
  check('аудит: активная ручная выдача без тарифа НЕ сносится (v2)',
    rManual.status === 'member' && rManual.is_manual === 1 && !rManual.manual_revoked_at, rManual);

  const rInvExpired = await rowOf('u-invited-expired');
  check('аудит: висячее приглашение без доступа → kicked / invite_expired (v3)',
    rInvExpired.status === 'kicked' && rInvExpired.kick_reason === 'invite_expired', rInvExpired);
  check('аудит: invitesRevoked ≥ 1', stats.invitesRevoked >= 1, stats);

  const rGrace = await rowOf('u-grace');
  check('аудит: invited с доступом (grace) → не тронут',
    rGrace.status === 'invited' && rGrace.invite_link === 'https://t.me/+deadbeef', rGrace);

  const rActive = await rowOf('u-active');
  check('аудит: без строки в таблице → строка не появлялась (не касаемся)',
    !rActive, rActive);

  check('аудит: статистика согласована (checked ≥ kicked, errors пусто)',
    stats.checked >= stats.kicked && stats.errors.length === 0, stats);

  fs.rmSync(process.env.SQLITE_FILE, { force: true });

  console.log(`\nИтого: ${passed} ok, ${failed} fail`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  if (process.env.SQLITE_FILE) fs.rmSync(process.env.SQLITE_FILE, { force: true });
  process.exit(1);
});
