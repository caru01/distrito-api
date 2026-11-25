-- Migration: 052_appmobile_orders_discount_addresses_loyalty.sql
-- Optimización y funcionalidades avanzadas App Móvil:
-- 1. Cupones y Descuentos en pedidos
-- 2. Direcciones guardadas tipo Rappi sincronizadas en nube
-- 3. Beneficio 1er Domicilio Gratis con control anti-fraude
-- 4. Telemetría de instalaciones de dispositivos

-- 1. Campos de Descuento en Pedidos
ALTER TABLE pedidos_app_orders ADD COLUMN IF NOT EXISTS discount INTEGER DEFAULT 0;
ALTER TABLE pedidos_app_orders ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(100);

-- 2. Direcciones de Clientes sincronizadas en la Nube
CREATE TABLE IF NOT EXISTS appmobile_customer_addresses (
    id SERIAL PRIMARY KEY,
    customer_account_id INTEGER REFERENCES appmobile_customer_accounts(id) ON DELETE CASCADE,
    phone VARCHAR(50),
    label VARCHAR(50) DEFAULT 'Casa',
    address TEXT NOT NULL,
    detail TEXT,
    barrio VARCHAR(100) DEFAULT 'Valledupar',
    latitude NUMERIC(10, 7) DEFAULT 10.4631,
    longitude NUMERIC(10, 7) DEFAULT -73.2532,
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appmobile_addresses_account ON appmobile_customer_addresses(customer_account_id);
CREATE INDEX IF NOT EXISTS idx_appmobile_addresses_phone ON appmobile_customer_addresses(phone);

-- 3. Beneficios y Promociones de Fidelización (1er Domicilio Gratis)
CREATE TABLE IF NOT EXISTS appmobile_customer_benefits (
    id SERIAL PRIMARY KEY,
    customer_account_id INTEGER REFERENCES appmobile_customer_accounts(id) ON DELETE SET NULL,
    phone VARCHAR(50) NOT NULL UNIQUE,
    installation_id VARCHAR(120),
    benefit_type VARCHAR(50) NOT NULL DEFAULT 'FREE_FIRST_DELIVERY',
    status VARCHAR(50) NOT NULL DEFAULT 'AVAILABLE',
    order_id INTEGER REFERENCES pedidos_app_orders(id) ON DELETE SET NULL,
    redeemed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appmobile_benefits_phone ON appmobile_customer_benefits(phone);
CREATE INDEX IF NOT EXISTS idx_appmobile_benefits_inst ON appmobile_customer_benefits(installation_id);

-- 4. Telemetría de Dispositivos e Instalaciones
CREATE TABLE IF NOT EXISTS appmobile_device_telemetry (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(120) NOT NULL,
    platform VARCHAR(20) DEFAULT 'android',
    app_version VARCHAR(50),
    device_model VARCHAR(100),
    phone VARCHAR(50),
    first_open_at TIMESTAMPTZ DEFAULT NOW(),
    last_open_at TIMESTAMPTZ DEFAULT NOW(),
    open_count INTEGER DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_appmobile_device_telemetry_dev ON appmobile_device_telemetry(device_id);
