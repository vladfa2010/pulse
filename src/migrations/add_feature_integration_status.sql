-- TZ — Статус интеграции фичи (ручной)
-- Добавляет колонку integration_status в реестр фичей.
-- Активные фичи помечаются как 'integrated' для обратной совместимости.

ALTER TABLE features_registry
  ADD COLUMN IF NOT EXISTS integration_status VARCHAR(20) NOT NULL DEFAULT 'pending';

UPDATE features_registry
  SET integration_status = 'integrated'
  WHERE is_active = TRUE AND integration_status = 'pending';
