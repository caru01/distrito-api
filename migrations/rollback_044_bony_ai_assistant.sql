-- Rollback Migración 044: Bony AI Assistant (Distric House)

DROP TABLE IF EXISTS pedidos_app_ai_automation_runs CASCADE;
DROP TABLE IF EXISTS pedidos_app_ai_automations CASCADE;
DROP TABLE IF EXISTS pedidos_app_ai_actions CASCADE;
DROP TABLE IF EXISTS pedidos_app_ai_messages CASCADE;
DROP TABLE IF EXISTS pedidos_app_ai_conversations CASCADE;
