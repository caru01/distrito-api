-- Migration: 053_appmobile_coupons_management.sql
-- Gestión completa de Cupones de Descuento para la App Móvil y Panel de Administración

CREATE TABLE IF NOT EXISTS appmobile_coupons (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    title VARCHAR(150) NOT NULL,
    description TEXT,
    discount_type VARCHAR(30) NOT NULL DEFAULT 'free_delivery', -- 'free_delivery' | 'percentage' | 'fixed'
    discount_value NUMERIC(10, 2) NOT NULL DEFAULT 0,
    min_order_total INTEGER DEFAULT 0,
    max_uses_per_customer INTEGER DEFAULT 1,
    is_active BOOLEAN DEFAULT TRUE,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appmobile_coupons_code ON appmobile_coupons(code);

CREATE TABLE IF NOT EXISTS appmobile_coupon_redemptions (
    id SERIAL PRIMARY KEY,
    coupon_id INTEGER REFERENCES appmobile_coupons(id) ON DELETE CASCADE,
    coupon_code VARCHAR(50) NOT NULL,
    customer_account_id INTEGER,
    customer_phone VARCHAR(50) NOT NULL,
    order_id INTEGER REFERENCES pedidos_app_orders(id) ON DELETE SET NULL,
    discount_applied INTEGER NOT NULL DEFAULT 0,
    redeemed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appmobile_redemptions_user ON appmobile_coupon_redemptions(coupon_code, customer_phone);

-- Seed de cupones predeterminados oficiales
INSERT INTO appmobile_coupons (code, title, description, discount_type, discount_value, min_order_total, max_uses_per_customer, is_active)
VALUES 
  ('DOMIAPP', '🎁 Domicilio Gratis por instalar la App', 'Válido para tu primera compra desde la App Oficial Distric House.', 'free_delivery', 0, 0, 1, TRUE),
  ('PRIMERPEDIDO', '10% de descuento en tu primer pedido', 'Aplica 10% de descuento sobre el total de tu pedido.', 'percentage', 10, 0, 1, TRUE),
  ('DISTRICVIP', 'Envío gratis en compras mayores a $40.000', 'Domicilio gratuito para pedidos superiores a $40.000.', 'free_delivery', 0, 40000, 999, TRUE),
  ('BURGER4K', '$4.000 de descuento en combos', '$4.000 COP de descuento directo en tus combos favoritos.', 'fixed', 4000, 20000, 1, TRUE)
ON CONFLICT (code) DO NOTHING;
