-- =============================================================================
-- ТЗ-186 — Динамика эффективности источников: ночные срезы статистики
-- «Ресерч: кто первый» (окно 7 дней, конец окна — конец суток МСК)
--
-- Применять вручную (PG-only, как news_embeddings_v1.sql):
--   psql -U pulse_user -d pulse -f src/migrations/source_stats_daily_v1.sql
--
-- Одна строка = один источник в одном срезе. Исторический рост: десятки
-- источников × 1 срез/день — мелочь, ретеншн-очистка не нужна.
-- PK составной — pgcrypto/gen_random_uuid не нужен.
-- =============================================================================

CREATE TABLE IF NOT EXISTS source_stats_daily (
  stat_date                 DATE NOT NULL,          -- дата конца окна (МСК)
  source                    TEXT NOT NULL,
  window_days               INT  NOT NULL DEFAULT 7,
  first_count               INT  NOT NULL DEFAULT 0,
  participations            INT  NOT NULL DEFAULT 0,
  median_lag_not_first_min  INT  NULL,
  clusters_total            INT  NOT NULL DEFAULT 0,
  share                     DOUBLE PRECISION NOT NULL DEFAULT 0,  -- first_count / clusters_total
  computed_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stat_date, source, window_days)
);
