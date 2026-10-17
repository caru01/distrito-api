-- 043_add_payment_method_to_employees.sql
-- Agregar columna payment_method a pedidos_app_employees

ALTER TABLE pedidos_app_employees
    ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50) DEFAULT 'Efectivo';
