-- Migration: 047_appmobile_schema.sql
-- Prefix tables exclusive to the mobile application with appmobile_

CREATE TABLE IF NOT EXISTS appmobile_customer_accounts (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    default_address VARCHAR(255),
    default_barrio VARCHAR(100),
    reset_token VARCHAR(20),
    reset_token_expiry TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Backward compatibility view if older code references pedidos_app_customer_accounts
CREATE OR REPLACE VIEW pedidos_app_customer_accounts AS 
SELECT * FROM appmobile_customer_accounts;
