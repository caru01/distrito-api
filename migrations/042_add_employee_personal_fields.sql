-- 042_add_employee_personal_fields.sql
-- Agregar Estado Civil y Fecha de Nacimiento en pedidos_app_employees

ALTER TABLE pedidos_app_employees
    ADD COLUMN IF NOT EXISTS marital_status VARCHAR(30) DEFAULT 'Soltero/a',
    ADD COLUMN IF NOT EXISTS birth_date DATE;
