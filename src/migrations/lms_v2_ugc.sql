-- Migration: LMS «Образование» — UGC + модерация (ТЗ-102 v2, Задача 1)
-- Run manually or via POST /migrate-lms-ugc?secret=KEY.
-- Идемпотентна (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS) —
-- повторный вызов безопасен. Требует применённой lms_v1.sql.
-- Правило ТЗ: существующие таблицы (news, users, payments, subscription_plans,
-- news_course_links) НЕ изменяются — ALTER только course_materials по ТЗ.

-- Материалы: происхождение + модерация.
-- created_at добавлен сверх буквы ТЗ: индекс idx_materials_moderation и FIFO-
-- сортировка очереди модерации опираются на created_at, которого в
-- course_materials (lms_v1) не было. DEFAULT NOW() — обратная совместимость.
ALTER TABLE course_materials
  ADD COLUMN IF NOT EXISTS origin       VARCHAR(20) NOT NULL DEFAULT 'editorial', -- 'editorial' | 'user'
  ADD COLUMN IF NOT EXISTS status       VARCHAR(20) NOT NULL DEFAULT 'approved',  -- 'pending' | 'approved' | 'rejected'
  ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reject_reason TEXT,
  ADD COLUMN IF NOT EXISTS scan_status  VARCHAR(20) NOT NULL DEFAULT 'clean', -- (v2, S4) 'pending_scan' | 'clean' | 'infected'; 'clean' дефолтом — редакционные файлы не сканируем
  ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_materials_moderation ON course_materials(status, created_at);

-- Предложения новостей к курсам (отдельная очередь — news_course_links остаётся
-- чисто редакционной и аппрувнутой, чтобы не трогать публичные выборки ТЗ-100)
CREATE TABLE IF NOT EXISTS news_course_suggestions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  news_id     UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  course_id   UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  submitted_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  reject_reason TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (news_id, course_id, submitted_by)   -- один юзер не дублирует предложение
);
