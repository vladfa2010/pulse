ALTER TABLE notification_settings
  ADD COLUMN IF NOT EXISTS fact_check_email_enabled BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS fact_check_tg_enabled BOOLEAN DEFAULT TRUE;
