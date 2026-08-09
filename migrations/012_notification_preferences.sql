ALTER TABLE pedidos_app_settings
  ADD COLUMN IF NOT EXISTS notification_voice VARCHAR(40) NOT NULL DEFAULT 'female-clear',
  ADD COLUMN IF NOT EXISTS notification_language VARCHAR(10) NOT NULL DEFAULT 'es-CO';

ALTER TABLE pedidos_app_settings
  DROP CONSTRAINT IF EXISTS settings_notification_voice_check,
  DROP CONSTRAINT IF EXISTS settings_notification_language_check;

ALTER TABLE pedidos_app_settings
  ADD CONSTRAINT settings_notification_voice_check
    CHECK (notification_voice IN ('female-clear', 'female-energetic', 'female-calm', 'male', 'system')),
  ADD CONSTRAINT settings_notification_language_check
    CHECK (notification_language IN ('es-CO', 'es-MX', 'es-ES', 'en-US', 'pt-BR'));

ANALYZE pedidos_app_settings;
