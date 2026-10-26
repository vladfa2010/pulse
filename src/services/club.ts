/**
 * =============================================================================
 * PULSE — TZ-197-club: закрытый Telegram-канал «Клуб»
 * =============================================================================
 *
 * Контроль доступа в закрытый канал по тарифу (фича club_access, grace-aware)
 * ИЛИ по ручной выдаче админа (v2). Гибрид: персональные ссылки (member_limit=1)
 * + ежедневный крон-аудит + webhook chat_member (проверка доступа в момент
 * вступления, v3). Логи — префикс [Club], ошибки best-effort не бросаем наружу.
 */

import { query } from '../config/db';
import { nowSql } from '../utils/nowSql';
import { hasFeature, withUserLock, getUserSubscription, getPlanById, GRACE_PERIOD_MS } from './subscription';
import {
  kickClubMember,
  revokeClubInviteLink,
  getClubMemberStatus,
  sendTelegramMessage,
} from './telegram';
import {
  logClubJoined,
  logClubKicked,
} from './activityLog';

// Пока env не задан, контур деградирует мягко: статус/eligible работают,
// membership-операции и аудит — 503/пропуск (единый гейт через эту функцию).
export function isClubConfigured(): boolean {
  return !!process.env.TELEGRAM_CLUB_CHAT_ID;
}

export function getClubChatId(): string {
  return process.env.TELEGRAM_CLUB_CHAT_ID || '';
}

// ─── Доступ ───────────────────────────────────────────────────────────────

export type ClubAccessReason = 'tariff' | 'manual' | 'none';
export type ClubTariffLost = 'expired' | 'feature_disabled' | null;

export interface ClubAccessInfo {
  hasAccess: boolean;
  reason: ClubAccessReason;
  // Для аудита: тарифное плечо потеряно истечением (включая grace) или
  // выключенным флагом фичи в features_registry.
  tariffLost: ClubTariffLost;
}

/**
 * TZ-197-club v2 (Задача 2): доступ = hasFeature('club_access') (grace-aware,
 * registry-aware) ИЛИ активная ручная выдача. Свежий запрос в БД на каждый
 * вызов, без кэша.
 */
export async function getClubAccessInfo(userId: string): Promise<ClubAccessInfo> {
  const [tariffOk, manualRow, tariffLost] = await Promise.all([
    hasFeature(userId, 'club_access'),
    query(
      `SELECT 1 AS ok FROM telegram_club_members
       WHERE user_id = $1 AND is_manual = TRUE AND manual_revoked_at IS NULL`,
      [userId]
    ),
    getClubTariffLost(userId),
  ]);
  const manual = manualRow.rows.length > 0;
  if (tariffOk) return { hasAccess: true, reason: 'tariff', tariffLost: null };
  if (manual) return { hasAccess: true, reason: 'manual', tariffLost };
  return { hasAccess: false, reason: 'none', tariffLost };
}

export async function hasClubAccess(userId: string): Promise<boolean> {
  return (await getClubAccessInfo(userId)).hasAccess;
}

// Почему тарифное плечо не даёт доступ: план без флаги/подписка мимо grace
// → 'expired'; флаг в плане есть и подписка активна, но фича выключена в
// registry → 'feature_disabled'. План без club_access вообще — тоже
// 'feature_disabled' (фича недоступна на текущем тарифе/выключена).
async function getClubTariffLost(userId: string): Promise<ClubTariffLost> {
  try {
    const sub = await getUserSubscription(userId);
    if (sub.plan === 'free') return null;
    const plan = await getPlanById(sub.plan);
    const planHasFlag = !!plan?.features?.['club_access'];
    if (!planHasFlag) return null; // нет club-тарифа — не «потеря», просто нет флага
    const expires = sub.expiresAt ? sub.expiresAt.getTime() : 0;
    const graceEnd = expires + GRACE_PERIOD_MS;
    if (Date.now() >= graceEnd) return 'expired';
    return 'feature_disabled'; // подписка жива — значит флаг выключен в registry
  } catch {
    return null;
  }
}

// ─── Членство ─────────────────────────────────────────────────────────────

export interface ClubMembershipRow {
  user_id: string;
  tg_user_id: string | null;
  invite_link: string | null;
  status: 'invited' | 'member' | 'kicked' | 'left';
  invited_at: string | null;
  joined_at: string | null;
  kicked_at: string | null;
  kick_reason: string | null;
  is_manual: boolean;
  manual_revoked_at: string | null;
  updated_at: string | null;
}

export async function getClubMembership(userId: string): Promise<ClubMembershipRow | null> {
  const result = await query(
    `SELECT * FROM telegram_club_members WHERE user_id = $1`,
    [userId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { ...row, is_manual: row.is_manual === true || row.is_manual === 1 };
}

/**
 * Upsert выдачи ссылки: статус invited, новая ссылка, invited_at=NOW().
 * ON CONFLICT (user_id) работает и в PG, и в SQLite — ветвления не нужно.
 */
export async function upsertClubInvite(userId: string, inviteLink: string): Promise<void> {
  await query(
    `INSERT INTO telegram_club_members (user_id, invite_link, status, invited_at, updated_at)
     VALUES ($1, $2, 'invited', ${nowSql()}, ${nowSql()})
     ON CONFLICT (user_id) DO UPDATE SET
       invite_link = EXCLUDED.invite_link,
       status = 'invited',
       invited_at = EXCLUDED.invited_at,
       updated_at = EXCLUDED.updated_at`,
    [userId, inviteLink]
  );
}

export async function markClubJoined(userId: string, tgUserId: string): Promise<void> {
  await query(
    `INSERT INTO telegram_club_members (user_id, tg_user_id, status, joined_at, updated_at)
     VALUES ($1, $2, 'member', ${nowSql()}, ${nowSql()})
     ON CONFLICT (user_id) DO UPDATE SET
       tg_user_id = EXCLUDED.tg_user_id,
       status = 'member',
       joined_at = ${nowSql()},
       updated_at = ${nowSql()}`,
    [userId, tgUserId]
  );
}

export async function markClubLeft(userId: string, reason: 'manual_leave'): Promise<void> {
  await query(
    `UPDATE telegram_club_members
     SET status = 'left', kick_reason = $2, kicked_at = ${nowSql()}, updated_at = ${nowSql()}
     WHERE user_id = $1 AND status = 'member'`,
    [userId, reason]
  );
}

export async function markClubKicked(
  userId: string,
  reason: string,
  opts?: { tgUserId?: string | null; onlyIfStatus?: string }
): Promise<void> {
  const clauses = [`status = 'kicked'`, `kick_reason = $2`, `kicked_at = ${nowSql()}`, `updated_at = ${nowSql()}`];
  const params: any[] = [userId, reason];
  if (opts?.tgUserId) {
    clauses.push(`tg_user_id = $3`);
    params.push(opts.tgUserId);
  }
  const whereStatus = opts?.onlyIfStatus ? ` AND status = '${opts.onlyIfStatus}'` : '';
  await query(
    `UPDATE telegram_club_members SET ${clauses.join(', ')} WHERE user_id = $1${whereStatus}`,
    params
  );
}

// ─── Webhook chat_member (Задача 3 + v3) ──────────────────────────────────

/**
 * Обработка update'а chat_member от Telegram. Вызывается из webhook.ts ДО
 * ветки message. Фильтр по chat id обязателен (бот может быть добавлен
 * админом в другие чаты). Мягкая деградация: TELEGRAM_CLUB_CHAT_ID не задан →
 * no-op.
 */
export async function handleClubChatMemberUpdate(chatMember: any): Promise<void> {
  if (!isClubConfigured()) return; // TZ-197-club: no-op без env
  const chatId = String(chatMember?.chat?.id || '');
  if (chatId !== getClubChatId()) return;

  const fromId = String(chatMember?.from?.id || '');
  if (!fromId) return;
  const newStatus = chatMember?.new_chat_member?.status;

  try {
    const userResult = await query(
      `SELECT user_id FROM user_channels WHERE channel = 'telegram' AND target = $1 AND is_active = TRUE`,
      [fromId]
    );
    const userId: string | null = userResult.rows[0]?.user_id || null;

    if (!userId) {
      // «Левый» аккаунт без привязки к PULSE — автокик (решение §7 п.5).
      if (newStatus === 'member') {
        await kickClubMember(fromId);
        console.log(`[Club] Kicked unknown joiner tg=${fromId}`);
      } else {
        console.log(`[Club] chat_member from unlinked account tg=${fromId}, status=${newStatus} — ignored`);
      }
      return;
    }

    if (newStatus === 'member') {
      // v3: проверка доступа В МОМЕНТ вступления — ссылка могла быть выдана
      // при активном тарифе, а вступить пытаются после его конца.
      const access = await getClubAccessInfo(userId);
      if (!access.hasAccess) {
        await kickClubMember(fromId);
        await upsertKickedAtJoin(userId, fromId);
        const frontendUrl = process.env.FRONTEND_URL || 'https://pulse.inside-trade.ru';
        sendTelegramMessage(fromId,
          `⛔ Тариф Клуба завершён — доступ в канал закрыт.\n\nПродлить: ${frontendUrl}/pricing`
        ).catch(() => {});
        console.log(`[Club] Kicked joiner without access user=${userId} tg=${fromId}`);
        return;
      }
      await markClubJoined(userId, fromId);
      logClubJoined(userId, fromId).catch(() => {});
      console.log(`[Club] Member joined user=${userId} tg=${fromId}`);
      return;
    }

    if (newStatus === 'left') {
      await markClubLeft(userId, 'manual_leave');
      console.log(`[Club] Member left user=${userId} tg=${fromId}`);
      return;
    }

    if (newStatus === 'kicked') {
      // Сработает и на наш собственный кик (cron/admin) — upsert идемпотентен,
      // порядок cron→webhook не важен.
      await markClubKicked(userId, 'admin');
      console.log(`[Club] Member kicked (TG event) user=${userId} tg=${fromId}`);
      return;
    }
  } catch (err: any) {
    console.error(`[Club] chat_member handling failed tg=${fromId}:`, err.message);
  }
}

async function upsertKickedAtJoin(userId: string, tgUserId: string): Promise<void> {
  await query(
    `INSERT INTO telegram_club_members (user_id, tg_user_id, status, kicked_at, kick_reason, updated_at)
     VALUES ($1, $2, 'kicked', ${nowSql()}, 'no_access_at_join', ${nowSql()})
     ON CONFLICT (user_id) DO UPDATE SET
       tg_user_id = EXCLUDED.tg_user_id,
       status = 'kicked',
       kicked_at = ${nowSql()},
       kick_reason = 'no_access_at_join',
       updated_at = ${nowSql()}`,
    [userId, tgUserId]
  );
}

// ─── Ежедневный аудит доступа (Задача 4 + v2/v3) ──────────────────────────

export interface ClubAuditStats {
  checked: number;
  kicked: number;
  invitesRevoked: number;
  errors: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Проход 1: у status='member' без активной ручной выдачи доступ потерян →
 * kick (ban+unban), status='kicked', причина subscription_expired /
 * feature_disabled, TG-уведомление (best-effort). Под withUserLock — защита
 * от гонки с одновременной оплатой.
 * Проход 2 (v3): у status='invited' без доступа → revoke ссылки,
 * kick_reason='invite_expired'.
 * Троттлинг Bot API: пауза 50 мс между действиями.
 */
export async function auditClubAccess(): Promise<ClubAuditStats> {
  const stats: ClubAuditStats = { checked: 0, kicked: 0, invitesRevoked: 0, errors: [] };

  try {
    const members = await query(
      `SELECT user_id, tg_user_id FROM telegram_club_members
       WHERE status = 'member' AND tg_user_id IS NOT NULL
         AND NOT (is_manual = TRUE AND manual_revoked_at IS NULL)`
    );
    for (const row of members.rows) {
      stats.checked++;
      try {
        await withUserLock(row.user_id, async () => {
          // Повторная проверка статуса внутри лока: вебхук мог уже вывести.
          const fresh = await query(
            `SELECT status FROM telegram_club_members WHERE user_id = $1`,
            [row.user_id]
          );
          if (fresh.rows[0]?.status !== 'member') return;

          const access = await getClubAccessInfo(row.user_id);
          if (access.hasAccess) return;

          const reason = access.tariffLost === 'feature_disabled' ? 'feature_disabled' : 'subscription_expired';
          await kickClubMember(String(row.tg_user_id));
          await markClubKicked(row.user_id, reason);
          logClubKicked(row.user_id, reason).catch(() => {});
          const frontendUrl = process.env.FRONTEND_URL || 'https://pulse.inside-trade.ru';
          sendTelegramMessage(String(row.tg_user_id),
            `⛔ Доступ в закрытый канал Клуба завершён вместе с тарифом.\n\nПродлить: ${frontendUrl}/pricing`
          ).catch(() => {});
          console.log(`[Club] Audit kicked user=${row.user_id} reason=${reason}`);
          stats.kicked++;
        });
      } catch (err: any) {
        stats.errors.push(`${row.user_id}: ${String(err.message).slice(0, 120)}`);
      }
      await sleep(50); // троттлинг Bot API ≈ ≤20 вызовов/сек
    }

    const invited = await query(
      `SELECT user_id, invite_link FROM telegram_club_members
       WHERE status = 'invited'
         AND NOT (is_manual = TRUE AND manual_revoked_at IS NULL)`
    );
    for (const row of invited.rows) {
      try {
        await withUserLock(row.user_id, async () => {
          const fresh = await query(
            `SELECT status, invite_link FROM telegram_club_members WHERE user_id = $1`,
            [row.user_id]
          );
          if (fresh.rows[0]?.status !== 'invited') return;

          const access = await getClubAccessInfo(row.user_id);
          if (access.hasAccess) return;

          const link = fresh.rows[0]?.invite_link || row.invite_link;
          if (link) await revokeClubInviteLink(link);
          await markClubKicked(row.user_id, 'invite_expired', { onlyIfStatus: 'invited' });
          console.log(`[Club] Audit revoked invite user=${row.user_id}`);
          stats.invitesRevoked++;
        });
      } catch (err: any) {
        stats.errors.push(`${row.user_id}: ${String(err.message).slice(0, 120)}`);
      }
      await sleep(50);
    }
  } catch (err: any) {
    stats.errors.push(`fatal: ${String(err.message).slice(0, 120)}`);
  }

  return stats;
}

// ─── Ленивая сверка для GET /api/club/status (Задача 2) ───────────────────

/**
 * Если у нас status='member', а в канале участника нет — поправить строку на
 * 'left' и вернуть актуальное. Раз на запрос, без кэша, timeout 5 c внутри
 * getClubMemberStatus. Без env — no-op (статус из таблицы).
 */
export async function reconcileClubMembership(row: ClubMembershipRow): Promise<ClubMembershipRow> {
  if (row.status !== 'member' || !row.tg_user_id || !isClubConfigured()) return row;
  const tgStatus = await getClubMemberStatus(row.tg_user_id);
  if (tgStatus === 'left' || tgStatus === 'kicked') {
    await markClubLeft(row.user_id, 'manual_leave');
    return { ...row, status: 'left', kick_reason: 'manual_leave' };
  }
  return row;
}
