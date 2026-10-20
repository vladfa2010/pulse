/**
 * PULSE — Weekly Report: рендер инфографики в PNG (ТЗ-184).
 *
 * Чистый рендерер: WeeklyReportContent (с stats) → PNG Buffer.
 * Без БД и доставки. SVG вручную (без chart-библиотеки) → sharp(svg).png().
 *
 * - Канвас 1200×~1000 логических px, retina 2x: density=144 → 2400×~2000 px
 *   (Telegram/email отображают по метаданным нормально).
 * - Все текстовые вставки (названия тегов и т.п.) — XML-escape: тексты
 *   приходят извне и ломают вёрстку/открывают инъекцию разметки.
 * - Никаких внешних ресурсов в SVG (<image href>, @import) — sharp/librsvg
 *   не ходит в сеть.
 * - Любая ошибка → log → null (картинка опциональна, текст уходит всегда).
 *
 * Шрифты: системные sans-serif. В контейнере проде (node:20-alpine) они
 * появляются через `apk add fontconfig ttf-dejavu` в Dockerfile (ТЗ-184,
 * уточнение 2026-10-20) — без этого кириллица рендерится квадратиками.
 */

import sharp from 'sharp';
import { WeeklyReportContent } from './weeklyReportContent';
import { WeeklyStats, statsCurrentTotal, statsPrevTotal } from './weeklyStats';

// Фирменная палитра — из pulse-frontend DESIGN_SPEC.md (тёмная тема)
const COLORS = {
  bg: '#060606',
  surface: '#0E0E0E',
  text: '#FFFFFF',
  textSecondary: '#9CA3AF',
  textMuted: '#6B7280',
  accent: '#00D4FF',       // текущая неделя
  prev: '#164E63',         // прошлая неделя (приглушённый teal)
  prevLabel: '#5A7A87',
  positive: '#34D399',
  negative: '#EF4444',
  neutral: '#6B7280',
  border: '#222222',
};

const W = 1200;
const PAD = 48;

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function fmtPct(pct: number | null): string {
  if (pct === null || !isFinite(pct)) return '—';
  const rounded = Math.round(pct);
  return `${rounded > 0 ? '▲' : rounded < 0 ? '▼' : ''}${rounded}%`;
}

function pctColor(pct: number | null): string {
  if (pct === null) return COLORS.textMuted;
  return pct >= 0 ? COLORS.positive : COLORS.negative;
}

function fmtDay(date: string): string {
  // YYYY-MM-DD → DD.MM
  return `${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

interface SvgBuilder {
  parts: string[];
  text(x: number, y: number, str: string, opts?: {
    size?: number; fill?: string; weight?: number; anchor?: 'start' | 'middle' | 'end';
  }): void;
  rect(x: number, y: number, w: number, h: number, fill: string, opacity?: number, rx?: number): void;
  line(x1: number, y1: number, x2: number, y2: number, stroke: string, w?: number): void;
}

function createSvg(): SvgBuilder {
  const parts: string[] = [];
  return {
    parts,
    text(x, y, str, opts = {}) {
      const { size = 18, fill = COLORS.text, weight = 400, anchor = 'start' } = opts;
      parts.push(
        `<text x="${x}" y="${y}" font-family="DejaVu Sans, sans-serif" font-size="${size}" ` +
        `fill="${fill}" font-weight="${weight}" text-anchor="${anchor}">${esc(str)}</text>`
      );
    },
    rect(x, y, w, h, fill, opacity = 1, rx = 0) {
      const op = opacity < 1 ? ` opacity="${opacity}"` : '';
      const r = rx > 0 ? ` rx="${rx}"` : '';
      parts.push(`<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}" fill="${fill}"${op}${r}/>`);
    },
    line(x1, y1, x2, y2, stroke, wdt = 1) {
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${wdt}"/>`);
    },
  };
}

function chartTitle(content: WeeklyReportContent, stats: WeeklyStats): string {
  if (stats.perDay.length >= 7) {
    return `PULSE — неделя ${fmtDay(stats.perDay[0].date)} — ${fmtDay(stats.perDay[6].date)}`;
  }
  return `PULSE — неделя ${content.period}`;
}

/**
 * Рендер инфографики. Возвращает PNG Buffer или null при любой ошибке
 * (в т.ч. при отсутствии stats — картинка опциональна, деградация → текст).
 */
export async function renderWeeklyChart(content: WeeklyReportContent): Promise<Buffer | null> {
  const stats = content.stats;
  if (!stats) return null;

  try {
    const svg = buildSvg(content, stats);
    return await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
  } catch (err) {
    console.error('[WeeklyChart] Рендер PNG не удался, отчёт уйдёт текстом:', err);
    return null;
  }
}

function buildSvg(content: WeeklyReportContent, stats: WeeklyStats): string {
  const s = createSvg();
  const top10 = [...stats.perTag]
    .sort((a, b) => b.current - a.current || b.prevWeek - a.prevWeek || a.tagName.localeCompare(b.tagName))
    .slice(0, 10);

  const curTotal = statsCurrentTotal(stats);
  const prevTotal = statsPrevTotal(stats);

  // KPI-строка: «Всего: N (▲12% к пр. неделе · ▼3% к мес. среднему)»
  const deltaWeek = fmtPct(stats.kpis.totalDeltaWeekPct);
  const deltaMonth = fmtPct(stats.kpis.totalDeltaMonthPct);
  const topTag = top10.find(t => t.tagId === stats.kpis.topTagId) ?? top10[0];

  // ── Раскладка по вертикали ────────────────────────────────────────────────
  const headerY = 64;
  const block1TitleY = 128;
  const rowH = 44;
  const rowsY = 152;
  const block1H = 28 + top10.length * rowH + (stats.perTag.length > 10 ? 24 : 8);
  const block2TitleY = rowsY + block1H + 34;
  const daysY = block2TitleY + 24;          // верх колонок
  const daysH = 170;                        // высота зоны колонок
  const block3TitleY = daysY + daysH + 46;
  const block3Y = block3TitleY + 26;
  const kpiY = block3Y + 108;
  const H = kpiY + 56;

  // Фон
  s.rect(0, 0, W, H, COLORS.bg);

  // ── Заголовок ─────────────────────────────────────────────────────────────
  s.text(PAD, headerY, chartTitle(content, stats), { size: 32, weight: 700, fill: COLORS.text });
  s.text(PAD, headerY + 30, content.period, { size: 17, fill: COLORS.textSecondary });

  // ── Блок 1: гистограмма тегов (топ-10) ────────────────────────────────────
  s.text(PAD, block1TitleY, 'Новости по тегам: текущая vs прошлая неделя', { size: 20, weight: 600 });
  // Легенда
  s.rect(W - PAD - 262, block1TitleY - 13, 14, 14, COLORS.accent, 1, 3);
  s.text(W - PAD - 242, block1TitleY, 'текущая', { size: 15, fill: COLORS.textSecondary });
  s.rect(W - PAD - 140, block1TitleY - 13, 14, 14, COLORS.prev, 1, 3);
  s.text(W - PAD - 120, block1TitleY, 'прошлая', { size: 15, fill: COLORS.textSecondary });

  const barsX = 330;
  const barsW = W - PAD - barsX - 120; // резерв под значения справа
  const maxVal = Math.max(1, ...top10.flatMap(t => [t.current, t.prevWeek]));

  top10.forEach((t, i) => {
    const y = rowsY + i * rowH;
    s.text(PAD, y + 16, truncate(t.tagName, 26), { size: 17, fill: COLORS.text });
    // Текущая неделя
    const curW = (t.current / maxVal) * barsW;
    s.rect(barsX, y, curW, 16, COLORS.accent, 1, 3);
    if (t.current > 0) {
      s.text(barsX + curW + 8, y + 13, String(t.current), { size: 15, weight: 600, fill: COLORS.accent });
    }
    // Прошлая неделя
    const prevW = (t.prevWeek / maxVal) * barsW;
    s.rect(barsX, y + 22, prevW, 11, COLORS.prev, 1, 3);
    if (t.prevWeek > 0) {
      s.text(barsX + prevW + 8, y + 32, String(t.prevWeek), { size: 13, fill: COLORS.prevLabel });
    }
  });

  if (stats.perTag.length > 10) {
    const rest = stats.perTag.length - 10;
    s.text(PAD, rowsY + top10.length * rowH + 18, `…и ещё ${rest} ${declineTags(rest)}`, { size: 15, fill: COLORS.textMuted });
  }

  s.line(PAD, block2TitleY - 24, W - PAD, block2TitleY - 24, COLORS.border);

  // ── Блок 2: динамика по дням (пн–вс, 7 колонок) ───────────────────────────
  s.text(PAD, block2TitleY, 'Динамика по дням', { size: 20, weight: 600 });
  const dayAreaX = PAD;
  const dayAreaW = W - PAD * 2;
  const slot = dayAreaW / 7;
  const barW = Math.min(64, slot * 0.55);
  const maxDay = Math.max(1, ...stats.perDay.map(d => d.count));
  const baseY = daysY + daysH - 30;

  s.line(dayAreaX, baseY, dayAreaX + dayAreaW, baseY, COLORS.border);
  stats.perDay.forEach((d, i) => {
    const cx = dayAreaX + slot * i + slot / 2;
    const h = (d.count / maxDay) * (daysH - 70);
    s.rect(cx - barW / 2, baseY - h, barW, h, COLORS.accent, d.count === 0 ? 0.25 : 0.9, 4);
    s.text(cx, baseY - h - 8, String(d.count), { size: 15, fill: COLORS.textSecondary, anchor: 'middle' });
    s.text(cx, baseY + 22, fmtDay(d.date), { size: 14, fill: COLORS.textMuted, anchor: 'middle' });
  });

  // ── Блок 3: тональность текущей недели + дельта к прошлой ────────────────
  s.text(PAD, block3TitleY, 'Тональность недели', { size: 20, weight: 600 });
  const sentTotal = stats.sentiment.positive + stats.sentiment.negative + stats.sentiment.neutral;
  const sentBarW = 640;
  const sentBarH = 30;
  if (sentTotal > 0) {
    const posW = (stats.sentiment.positive / sentTotal) * sentBarW;
    const negW = (stats.sentiment.negative / sentTotal) * sentBarW;
    const neuW = sentBarW - posW - negW;
    let x = PAD;
    if (posW > 0) { s.rect(x, block3Y, posW, sentBarH, COLORS.positive, 1, 2); x += posW; }
    if (negW > 0) { s.rect(x, block3Y, negW, sentBarH, COLORS.negative, 1, 2); x += negW; }
    if (neuW > 0) { s.rect(x, block3Y, neuW, sentBarH, COLORS.neutral, 1, 2); }
    const labelY = block3Y + sentBarH + 24;
    // Квадраты рисуем rect'ами, а не эмодзи: в alpine-контейнере с одним
    // DejaVu эмодзи-глифов нет (квадратики), фигуры SVG — всегда ок.
    let lx = PAD;
    for (const [color, value, fill] of [
      [COLORS.positive, stats.sentiment.positive, COLORS.positive],
      [COLORS.negative, stats.sentiment.negative, COLORS.negative],
      [COLORS.textSecondary, stats.sentiment.neutral, COLORS.neutral],
    ] as Array<[string, number, string]>) {
      s.rect(lx, labelY - 12, 12, 12, color, 1, 2);
      s.text(lx + 18, labelY, String(value), { size: 15, fill });
      lx += 70;
    }
  } else {
    s.text(PAD, block3Y + 20, 'Нет новостей за текущую неделю', { size: 16, fill: COLORS.textMuted });
  }

  // Маркер дельты к прошлой неделе
  const sentDelta = prevTotal > 0 ? ((curTotal - prevTotal) / prevTotal) * 100 : null;
  s.text(
    PAD + sentBarW + 40, block3Y + 21,
    `${fmtPct(sentDelta)} к пр. неделе`,
    { size: 17, weight: 600, fill: pctColor(sentDelta) }
  );

  s.line(PAD, kpiY - 30, W - PAD, kpiY - 30, COLORS.border);

  // ── Блок 4: KPI-строка ────────────────────────────────────────────────────
  const kpiLine = `Всего: ${curTotal} (${deltaWeek} к пр. неделе · ${deltaMonth} к мес. среднему)`;
  s.text(PAD, kpiY, truncate(kpiLine, 90), { size: 20, weight: 600 });
  if (topTag) {
    s.text(PAD, kpiY + 30, `Самый обсуждаемый: ${truncate(topTag.tagName, 40)} (${topTag.current})`, { size: 17, fill: COLORS.textSecondary });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${s.parts.join('')}</svg>`;
}

function declineTags(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'тег';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'тега';
  return 'тегов';
}
