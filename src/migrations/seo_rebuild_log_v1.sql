-- ============================================================
-- Migration: ТЗ-164 Задача 5 — лог SEO-пересборок образования
-- (записи пишутся сервисом services/education/seoRebuild.ts при
-- каждой пересборке; ретенция 20 последних записей — в коде сервиса)
-- SQLite-зеркало: initSQLiteSchema() в src/config/db-sqlite.ts
-- ============================================================

CREATE TABLE IF NOT EXISTS seo_rebuild_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- SQLite: TEXT, генерит бэкенд
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),           -- SQLite: TEXT ISO
  finished_at   TIMESTAMPTZ,                                  -- SQLite: TEXT ISO
  status        VARCHAR(10) NOT NULL DEFAULT 'running',       -- 'running' | 'ok' | 'error'
  courses_count INTEGER,
  error         TEXT,
  trigger       VARCHAR(10) NOT NULL                           -- 'mutation' | 'manual' | 'boot'
);
