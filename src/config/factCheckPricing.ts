// ТЗ-207: тарифы Kimi (Moonshot) для учёта стоимости фактчека.
// Зафиксировано 2026-10-31 по https://platform.kimi.com/docs/pricing/chat
// (kimi-k2.6). Смена цен = правка констант + малая Правка к ТЗ-207.
export const INPUT_USD_PER_M = 0.95;
export const OUTPUT_USD_PER_M = 4.0;
export const WEB_SEARCH_USD_PER_CALL = 0.005;

// Дневной бюджет фактчека (USD, UTC-сутки). 0 = алерт выключен полностью —
// включение = правка этой константы владельцем.
export const DAILY_BUDGET_USD = 0;

// Единая формула стоимости для всех потребителей (сессия, stats, алерт).
export function computeCostUsd(
  tokensInput: number,
  tokensOutput: number,
  webSearchCalls: number
): number {
  return (
    (tokensInput / 1e6) * INPUT_USD_PER_M +
    (tokensOutput / 1e6) * OUTPUT_USD_PER_M +
    webSearchCalls * WEB_SEARCH_USD_PER_CALL
  );
}
