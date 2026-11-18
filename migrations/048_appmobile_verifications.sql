-- Migration: 048_appmobile_verifications.sql
-- Table to manage registration phone verifications for AppMobile

CREATE TABLE IF NOT EXISTS appmobile_phone_verifications (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(50) NOT NULL,
    code VARCHAR(10) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appmobile_phone_verif ON appmobile_phone_verifications(phone, code);
