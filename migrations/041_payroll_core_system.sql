-- Migration 041: Payroll Core System (Módulo de Nómina)
-- Distrito BG - Sistema de Gestión de Personal, Asistencia, Comidas e Inventario, y Pagos
--
-- NOTA IMPORTANTE: Este archivo es una propuesta técnica para revisión.
-- NO se ejecuta automáticamente en la base de datos hasta contar con aprobación expresa.
-- Versión de Seguridad Auditada:
-- 1. Idempotencia total: INSERTS con ON CONFLICT DO NOTHING (no sobrescribe datos preexistentes).
-- 2. Integridad financiera: ON DELETE RESTRICT en items de nómina (prohíbe borrado en cascada de periodos o empleados con liquidaciones).
-- 3. Control de vigencias: Prevención de solapamientos en pedidos_app_payroll_config.
-- 4. Trazabilidad de inventario: Vínculo seguro con pedidos_app_product_stock_movements y anulación compensatoria.

-- ============================================================================
-- 1. PARÁMETROS LEGALES Y VIGENCIAS HISTÓRICAS (COLOMBIA)
-- ============================================================================
CREATE TABLE IF NOT EXISTS pedidos_app_payroll_config (
    id SERIAL PRIMARY KEY,
    year INTEGER NOT NULL UNIQUE,
    valid_from DATE NOT NULL,
    valid_to DATE,
    smmlv_amount NUMERIC(14,2) NOT NULL,
    transport_allowance_monthly NUMERIC(14,2) NOT NULL,
    transport_allowance_daily NUMERIC(14,2) NOT NULL,
    standard_daily_hours NUMERIC(4,2) NOT NULL DEFAULT 8.00,
    health_employee_pct NUMERIC(5,2) NOT NULL DEFAULT 4.00,
    pension_employee_pct NUMERIC(5,2) NOT NULL DEFAULT 4.00,
    night_shift_surcharge_pct NUMERIC(5,2) NOT NULL DEFAULT 35.00,
    holiday_surcharge_pct NUMERIC(5,2) NOT NULL DEFAULT 75.00,
    overtime_day_surcharge_pct NUMERIC(5,2) NOT NULL DEFAULT 25.00,
    overtime_night_surcharge_pct NUMERIC(5,2) NOT NULL DEFAULT 75.00,
    default_period_type VARCHAR(20) NOT NULL DEFAULT 'quincenal',
    allow_negative_stock BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    legal_reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_config_dates_valid CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

-- Trigger para prevención de solapamientos en vigencias de configuración.
-- El bloqueo consultivo se toma ANTES de consultar las vigencias existentes: dos transacciones concurrentes
-- se serializan y la segunda ve lo confirmado por la primera (READ COMMITTED, snapshot nuevo por sentencia).
-- Namespace 41 = nómina (evita colisiones con otros usos de advisory locks).
CREATE OR REPLACE FUNCTION check_payroll_config_overlap()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(41, hashtext('pedidos_app_payroll_config'));

  IF EXISTS (
    SELECT 1 FROM pedidos_app_payroll_config
    WHERE id <> COALESCE(NEW.id, -1)
      AND NEW.valid_from <= COALESCE(valid_to, '9999-12-31'::date)
      AND COALESCE(NEW.valid_to, '9999-12-31'::date) >= valid_from
  ) THEN
    RAISE EXCEPTION 'El rango de vigencia [% a %] se solapa con una configuración salarial existente.', NEW.valid_from, COALESCE(NEW.valid_to::text, 'indefinido');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_payroll_config_overlap ON pedidos_app_payroll_config;
CREATE TRIGGER trg_check_payroll_config_overlap
BEFORE INSERT OR UPDATE OF valid_from, valid_to ON pedidos_app_payroll_config
FOR EACH ROW EXECUTE FUNCTION check_payroll_config_overlap();

-- Semillas oficiales con ON CONFLICT DO NOTHING (100% IDEMPOTENTE: jamás sobrescribe cambios administrativos previos)
-- 1. Vigencia 2026 (Activa): Decreto 1469 de 2025 ($1.750.905) y Decreto 1470 de 2025 ($249.095)
INSERT INTO pedidos_app_payroll_config (
    year, valid_from, valid_to, smmlv_amount, transport_allowance_monthly, transport_allowance_daily,
    standard_daily_hours, health_employee_pct, pension_employee_pct,
    night_shift_surcharge_pct, holiday_surcharge_pct, overtime_day_surcharge_pct, overtime_night_surcharge_pct,
    default_period_type, allow_negative_stock, is_active, legal_reference
) VALUES (
    2026, '2026-01-01', NULL, 1750905.00, 249095.00, 8303.17,
    8.00, 4.00, 4.00,
    35.00, 75.00, 25.00, 75.00,
    'quincenal', false, true, 'Decretos 1469 y 1470 de 2025 (Salario mínimo y Auxilio de transporte 2026)'
) ON CONFLICT (year) DO NOTHING;

-- 2. Vigencia 2025 (Histórica de referencia): Decreto 1572 de 2024 ($1.423.500) y Decreto 1573 de 2024 ($200.000)
INSERT INTO pedidos_app_payroll_config (
    year, valid_from, valid_to, smmlv_amount, transport_allowance_monthly, transport_allowance_daily,
    standard_daily_hours, health_employee_pct, pension_employee_pct,
    night_shift_surcharge_pct, holiday_surcharge_pct, overtime_day_surcharge_pct, overtime_night_surcharge_pct,
    default_period_type, allow_negative_stock, is_active, legal_reference
) VALUES (
    2025, '2025-01-01', '2025-12-31', 1423500.00, 200000.00, 6666.67,
    8.00, 4.00, 4.00,
    35.00, 75.00, 25.00, 75.00,
    'quincenal', false, false, 'Decretos 1572 y 1573 de 2024 (Salario mínimo y Auxilio de transporte 2025)'
) ON CONFLICT (year) DO NOTHING;

-- ============================================================================
-- 2. CATÁLOGO DE EMPLEADOS (RÉGIMEN MIXTO Y DEDUCCIONES PARAMETRIZABLES)
-- ============================================================================
CREATE TABLE IF NOT EXISTS pedidos_app_employees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    document_type VARCHAR(20) NOT NULL DEFAULT 'CC',
    document_number VARCHAR(50) NOT NULL UNIQUE,
    phone VARCHAR(50),
    email VARCHAR(150),
    address TEXT,
    position VARCHAR(80) NOT NULL,
    -- 'Laboral - Término Indefinido', 'Laboral - Término Fijo', 'Laboral por Días (Decreto 2616)', 'Jornal / Turno', 'Prestación de Servicios'
    contract_type VARCHAR(60) NOT NULL DEFAULT 'Laboral - Término Indefinido',
    salary_base NUMERIC(14,2) NOT NULL DEFAULT 0,
    daily_rate NUMERIC(14,2) NOT NULL DEFAULT 0,
    hourly_rate NUMERIC(14,2) NOT NULL DEFAULT 0,
    payment_frequency VARCHAR(20) NOT NULL DEFAULT 'quincenal',
    has_transport_allowance BOOLEAN NOT NULL DEFAULT TRUE,
    transport_allowance_daily NUMERIC(14,2) NOT NULL DEFAULT 8303.17,
    deduce_health BOOLEAN NOT NULL DEFAULT TRUE,
    deduce_pension BOOLEAN NOT NULL DEFAULT TRUE,
    health_percentage NUMERIC(5,2) DEFAULT 4.00,
    pension_percentage NUMERIC(5,2) DEFAULT 4.00,
    additional_benefits JSONB DEFAULT '[]'::jsonb,
    hire_date DATE NOT NULL DEFAULT CURRENT_DATE,
    discharge_date DATE,
    discharge_reason TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'Activo', -- 'Activo', 'Inactivo', 'Retirado'
    bank_name VARCHAR(80),
    bank_account_type VARCHAR(30) DEFAULT 'Ahorros',
    bank_account_number VARCHAR(60),
    emergency_contact_name VARCHAR(120),
    emergency_contact_phone VARCHAR(50),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pedidos_app_employees_status ON pedidos_app_employees(status);
CREATE INDEX IF NOT EXISTS idx_pedidos_app_employees_hire_date ON pedidos_app_employees(hire_date);
CREATE INDEX IF NOT EXISTS idx_pedidos_app_employees_doc ON pedidos_app_employees(document_number);
CREATE INDEX IF NOT EXISTS idx_pedidos_app_employees_contract ON pedidos_app_employees(contract_type);

-- ============================================================================
-- 3. REGISTRO DIARIO DE ASISTENCIA, RECARGOS Y TURNOS MÚLTIPLES
-- ============================================================================
CREATE TABLE IF NOT EXISTS pedidos_app_employee_attendance (
    id BIGSERIAL PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES pedidos_app_employees(id) ON DELETE RESTRICT,
    attendance_date DATE NOT NULL,
    shift_number INTEGER NOT NULL DEFAULT 1,
    shift_type VARCHAR(30) NOT NULL DEFAULT 'Completo',
    status VARCHAR(40) NOT NULL DEFAULT 'Trabajó',
    check_in_time TIME,
    check_out_time TIME,
    hours_worked NUMERIC(5,2) DEFAULT 8.00,
    -- Recargos y horas extras discriminadas
    overtime_day_hours NUMERIC(5,2) DEFAULT 0,
    overtime_night_hours NUMERIC(5,2) DEFAULT 0,
    night_hours NUMERIC(5,2) DEFAULT 0,
    holiday_hours NUMERIC(5,2) DEFAULT 0,
    daily_value_applied NUMERIC(14,2) NOT NULL DEFAULT 0,
    transport_allowance_applied NUMERIC(14,2) NOT NULL DEFAULT 0,
    overtime_value_applied NUMERIC(14,2) NOT NULL DEFAULT 0,
    had_meal BOOLEAN NOT NULL DEFAULT FALSE,
    meal_notes TEXT,
    supplies_notes TEXT,
    notes TEXT,
    registered_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_employee_attendance_shift UNIQUE (employee_id, attendance_date, shift_number)
);

CREATE INDEX IF NOT EXISTS idx_employee_attendance_date ON pedidos_app_employee_attendance(attendance_date);
CREATE INDEX IF NOT EXISTS idx_employee_attendance_employee ON pedidos_app_employee_attendance(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_attendance_status ON pedidos_app_employee_attendance(status);

-- ============================================================================
-- 4. COMIDAS Y SUMINISTROS ENTREGADOS A EMPLEADOS (CONSUMO INTERNO / COGS)
-- ============================================================================
CREATE TABLE IF NOT EXISTS pedidos_app_employee_meals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES pedidos_app_employees(id) ON DELETE RESTRICT,
    delivery_date DATE NOT NULL DEFAULT CURRENT_DATE,
    item_type VARCHAR(20) NOT NULL DEFAULT 'Menu', -- 'Menu' o 'Insumo'
    product_id UUID REFERENCES pedidos_app_products(id) ON DELETE SET NULL,
    inventory_id UUID REFERENCES pedidos_app_inventory(id) ON DELETE SET NULL,
    item_title VARCHAR(150) NOT NULL,
    quantity NUMERIC(12,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
    total_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
    -- Vínculo estricto con Kardex (impide dejar movimientos huérfanos)
    stock_movement_id BIGINT REFERENCES pedidos_app_product_stock_movements(id) ON DELETE RESTRICT,
    is_untracked BOOLEAN NOT NULL DEFAULT FALSE, -- True si se entregó producto sin receta técnica
    idempotency_key VARCHAR(120) UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'Entregado', -- 'Entregado', 'Anulado'
    cancel_reason TEXT,
    annulled_at TIMESTAMPTZ,
    annulled_by VARCHAR(100),
    registered_by VARCHAR(100),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_meals_employee_date ON pedidos_app_employee_meals(employee_id, delivery_date);
CREATE INDEX IF NOT EXISTS idx_employee_meals_date ON pedidos_app_employee_meals(delivery_date);
CREATE INDEX IF NOT EXISTS idx_employee_meals_status ON pedidos_app_employee_meals(status);

-- ============================================================================
-- 5. PERIODOS DE NÓMINA Y PREVENCIÓN DE SOLAPAMIENTO
-- ============================================================================
CREATE TABLE IF NOT EXISTS pedidos_app_payroll_periods (
    id SERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    period_type VARCHAR(20) NOT NULL DEFAULT 'quincenal',
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'Borrador', -- 'Borrador', 'Calculado', 'Aprobado', 'Cerrado', 'Anulado'
    -- Snapshot de parámetros legales vigentes aplicados a este periodo
    config_year INTEGER DEFAULT 2026,
    applied_smmlv NUMERIC(14,2) DEFAULT 1750905.00,
    applied_transport_monthly NUMERIC(14,2) DEFAULT 249095.00,
    applied_transport_daily NUMERIC(14,2) DEFAULT 8303.17,
    applied_health_pct NUMERIC(5,2) DEFAULT 4.00,
    applied_pension_pct NUMERIC(5,2) DEFAULT 4.00,
    -- Consolidación de totales
    employees_count INTEGER DEFAULT 0,
    total_days_worked NUMERIC(8,2) DEFAULT 0,
    total_base_salary NUMERIC(14,2) DEFAULT 0,
    total_transport_allowance NUMERIC(14,2) DEFAULT 0,
    total_overtime NUMERIC(14,2) DEFAULT 0,
    total_bonuses NUMERIC(14,2) DEFAULT 0,
    total_accrued NUMERIC(14,2) DEFAULT 0,
    total_legal_deductions NUMERIC(14,2) DEFAULT 0,
    total_advances_deductions NUMERIC(14,2) DEFAULT 0,
    total_other_deductions NUMERIC(14,2) DEFAULT 0,
    total_deductions NUMERIC(14,2) DEFAULT 0,
    total_net_payable NUMERIC(14,2) DEFAULT 0,
    total_internal_consumption NUMERIC(14,2) DEFAULT 0,
    total_meals_count INTEGER DEFAULT 0,
    calculated_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    approved_by VARCHAR(100),
    closed_at TIMESTAMPTZ,
    closed_by VARCHAR(100),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_period_dates_valid CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_payroll_periods_dates ON pedidos_app_payroll_periods(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_payroll_periods_status ON pedidos_app_payroll_periods(status);

-- Trigger para prevención estricta de solapamientos de periodos activos DEL MISMO TIPO
-- (los empleados tienen payment_frequency propia, por lo que tipos distintos pueden coexistir).
-- El bloqueo se toma ANTES de consultar; la clave es el tipo de periodo de la fila NUEVA, de modo que un
-- INSERT y un UPDATE que cambie period_type hacia ese mismo tipo se serializan entre sí.
-- Un periodo 'Anulado' no ocupa calendario, por lo que no se valida ni bloquea.
CREATE OR REPLACE FUNCTION check_payroll_period_overlap()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'Anulado' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(41, hashtext('pedidos_app_payroll_periods:' || NEW.period_type));

  IF EXISTS (
    SELECT 1 FROM pedidos_app_payroll_periods
    WHERE period_type = NEW.period_type
      AND id <> COALESCE(NEW.id, -1)
      AND status <> 'Anulado'
      AND NEW.start_date <= end_date
      AND NEW.end_date >= start_date
  ) THEN
    RAISE EXCEPTION 'El periodo de nómina [% a %] se solapa con un periodo existente activo del mismo tipo.', NEW.start_date, NEW.end_date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_payroll_period_overlap ON pedidos_app_payroll_periods;
CREATE TRIGGER trg_check_payroll_period_overlap
BEFORE INSERT OR UPDATE OF period_type, start_date, end_date, status ON pedidos_app_payroll_periods
FOR EACH ROW EXECUTE FUNCTION check_payroll_period_overlap();

-- ============================================================================
-- 6. DETALLE DE LIQUIDACIÓN POR EMPLEADO Y PERIODO (PROTECCIÓN FINANCIERA)
-- ============================================================================
CREATE TABLE IF NOT EXISTS pedidos_app_payroll_items (
    id SERIAL PRIMARY KEY,
    -- PROTECCIÓN CRÍTICA: Prohibido borrar en cascada (ON DELETE RESTRICT) para salvaguardar historial contable
    payroll_period_id INTEGER NOT NULL REFERENCES pedidos_app_payroll_periods(id) ON DELETE RESTRICT,
    employee_id UUID NOT NULL REFERENCES pedidos_app_employees(id) ON DELETE RESTRICT,
    days_worked NUMERIC(6,2) DEFAULT 0,
    days_rest NUMERIC(6,2) DEFAULT 0,
    days_leave_paid NUMERIC(6,2) DEFAULT 0,
    days_leave_unpaid NUMERIC(6,2) DEFAULT 0,
    days_sick NUMERIC(6,2) DEFAULT 0,
    days_vacation NUMERIC(6,2) DEFAULT 0,
    days_holiday NUMERIC(6,2) DEFAULT 0,
    hours_worked NUMERIC(7,2) DEFAULT 0,
    daily_rate NUMERIC(14,2) NOT NULL DEFAULT 0,
    base_salary_earned NUMERIC(14,2) NOT NULL DEFAULT 0,
    transport_allowance_earned NUMERIC(14,2) NOT NULL DEFAULT 0,
    overtime_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    bonuses_earned NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_accrued NUMERIC(14,2) NOT NULL DEFAULT 0,
    health_deduction NUMERIC(14,2) NOT NULL DEFAULT 0,
    pension_deduction NUMERIC(14,2) NOT NULL DEFAULT 0,
    advances_deduction NUMERIC(14,2) NOT NULL DEFAULT 0,
    other_deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
    net_payable NUMERIC(14,2) NOT NULL DEFAULT 0,
    internal_consumption_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
    meals_count INTEGER DEFAULT 0,
    payment_status VARCHAR(20) NOT NULL DEFAULT 'Pendiente', -- 'Pendiente', 'Parcial', 'Pagado'
    total_paid NUMERIC(14,2) NOT NULL DEFAULT 0,
    pending_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_payroll_period_employee UNIQUE (payroll_period_id, employee_id),
    CONSTRAINT chk_payroll_item_pending_balance CHECK (pending_balance >= 0),
    CONSTRAINT chk_payroll_item_total_paid CHECK (total_paid >= 0)
);

CREATE INDEX IF NOT EXISTS idx_payroll_items_period ON pedidos_app_payroll_items(payroll_period_id);
CREATE INDEX IF NOT EXISTS idx_payroll_items_employee ON pedidos_app_payroll_items(employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_items_status ON pedidos_app_payroll_items(payment_status);

-- ============================================================================
-- 7. REGISTRO DE PAGOS Y COMPROBANTES DE NÓMINA
-- ============================================================================
CREATE TABLE IF NOT EXISTS pedidos_app_payroll_payments (
    id SERIAL PRIMARY KEY,
    payroll_item_id INTEGER NOT NULL REFERENCES pedidos_app_payroll_items(id) ON DELETE RESTRICT,
    employee_id UUID NOT NULL REFERENCES pedidos_app_employees(id) ON DELETE RESTRICT,
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    amount_paid NUMERIC(14,2) NOT NULL CHECK (amount_paid > 0),
    payment_method VARCHAR(50) NOT NULL DEFAULT 'Transferencia',
    voucher_reference VARCHAR(120),
    receipt_url TEXT,
    idempotency_key VARCHAR(120) UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'Pagado', -- 'Pagado', 'Anulado'
    paid_by VARCHAR(100),
    annulled_at TIMESTAMPTZ,
    annulled_by VARCHAR(100),
    annul_reason TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_payments_item ON pedidos_app_payroll_payments(payroll_item_id);
CREATE INDEX IF NOT EXISTS idx_payroll_payments_employee ON pedidos_app_payroll_payments(employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_payments_date ON pedidos_app_payroll_payments(payment_date);
-- La unicidad de idempotency_key la garantiza la restricción UNIQUE de la columna (necesaria para ON CONFLICT).

-- ============================================================================
-- 8. ANTICIPOS, PRÉSTAMOS Y DESCUENTOS AUTORIZADOS
-- ============================================================================
CREATE TABLE IF NOT EXISTS pedidos_app_employee_deductions (
    id SERIAL PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES pedidos_app_employees(id) ON DELETE RESTRICT,
    type VARCHAR(40) NOT NULL, -- 'Anticipo', 'Préstamo', 'Deducción legal', 'Descuento autorizado'
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    balance_remaining NUMERIC(14,2) NOT NULL CHECK (balance_remaining >= 0),
    request_date DATE NOT NULL DEFAULT CURRENT_DATE,
    reason TEXT NOT NULL,
    installments_total INTEGER NOT NULL DEFAULT 1,
    installments_paid INTEGER NOT NULL DEFAULT 0,
    installment_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    voucher_url TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'Pendiente', -- 'Pendiente', 'Parcial', 'Aplicado', 'Cancelado'
    registered_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_deductions_employee ON pedidos_app_employee_deductions(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_deductions_status ON pedidos_app_employee_deductions(status);

-- ============================================================================
-- 9. LIQUIDACIONES DEFINITIVAS DE RETIRO
-- ============================================================================
CREATE TABLE IF NOT EXISTS pedidos_app_employee_settlements (
    id SERIAL PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES pedidos_app_employees(id) ON DELETE RESTRICT,
    hire_date DATE NOT NULL,
    discharge_date DATE NOT NULL,
    days_worked_total INTEGER NOT NULL DEFAULT 0,
    base_salary NUMERIC(14,2) NOT NULL DEFAULT 0,
    transport_allowance_included BOOLEAN NOT NULL DEFAULT TRUE,
    severance_pay NUMERIC(14,2) NOT NULL DEFAULT 0,
    severance_interest NUMERIC(14,2) NOT NULL DEFAULT 0,
    service_bonus NUMERIC(14,2) NOT NULL DEFAULT 0,
    vacation_pay NUMERIC(14,2) NOT NULL DEFAULT 0,
    pending_wages NUMERIC(14,2) NOT NULL DEFAULT 0,
    compensation_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
    net_settlement NUMERIC(14,2) NOT NULL DEFAULT 0,
    is_provisional BOOLEAN NOT NULL DEFAULT TRUE,
    status VARCHAR(20) NOT NULL DEFAULT 'Borrador', -- 'Borrador', 'Aprobado', 'Pagado'
    settlement_date DATE NOT NULL DEFAULT CURRENT_DATE,
    approved_by VARCHAR(100),
    approved_at TIMESTAMPTZ,
    voucher_reference VARCHAR(120),
    receipt_url TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_settlements_employee ON pedidos_app_employee_settlements(employee_id);

-- ============================================================================
-- 9.1 SOPORTES DE PRESTACIONES (base del estimador de liquidación)
-- Cada fila es evidencia de una consignación, pago, saldo pendiente o vacaciones.
-- No se borra: se anula (voided_*), conservando trazabilidad. Sin registro, el estimador
-- NO presume que un periodo anterior esté pagado ni adeudado: lo reporta como información faltante.
-- ============================================================================
CREATE TABLE IF NOT EXISTS pedidos_app_employee_benefit_records (
    id SERIAL PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES pedidos_app_employees(id) ON DELETE RESTRICT,
    benefit_type VARCHAR(30) NOT NULL
        CHECK (benefit_type IN ('CESANTIAS', 'INTERESES_CESANTIAS', 'PRIMA', 'VACACIONES')),
    period_year INTEGER NOT NULL CHECK (period_year BETWEEN 1990 AND 2100),
    period_semester SMALLINT CHECK (period_semester IN (1, 2)),
    status VARCHAR(20) NOT NULL,
    amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
    days NUMERIC(6,2) CHECK (days IS NULL OR days >= 0),
    evidence_reference TEXT NOT NULL CHECK (length(btrim(evidence_reference)) > 0),
    notes TEXT,
    registered_by VARCHAR(100),
    voided_at TIMESTAMPTZ,
    voided_by VARCHAR(100),
    void_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_benefit_status_by_type CHECK (
        (benefit_type = 'CESANTIAS' AND status IN ('Consignado', 'Pagado', 'Pendiente'))
        OR (benefit_type IN ('INTERESES_CESANTIAS', 'PRIMA') AND status IN ('Pagado', 'Pendiente'))
        OR (benefit_type = 'VACACIONES' AND status IN ('Disfrutado', 'Compensado'))
    ),
    CONSTRAINT chk_benefit_prima_semester CHECK (
        (benefit_type = 'PRIMA' AND period_semester IS NOT NULL)
        OR (benefit_type <> 'PRIMA' AND period_semester IS NULL)
    ),
    CONSTRAINT chk_benefit_vacation_days CHECK (benefit_type <> 'VACACIONES' OR days IS NOT NULL),
    CONSTRAINT chk_benefit_money_positive CHECK (
        benefit_type = 'VACACIONES' OR amount > 0
    )
);

CREATE INDEX IF NOT EXISTS idx_benefit_records_employee ON pedidos_app_employee_benefit_records(employee_id, benefit_type, period_year);

-- ============================================================================
-- 10. REGISTRO DE PERMISOS EN LA MATRIZ DE SEGURIDAD
-- ============================================================================
INSERT INTO pedidos_app_permissions (module, action, name, description)
VALUES
  ('Nomina', 'ver', 'Nomina - ver', 'Consultar panel de nómina, empleados, asistencia y reportes'),
  ('Nomina', 'crear', 'Nomina - crear', 'Registrar nuevos empleados, asistencia y novedades diarias'),
  ('Nomina', 'editar', 'Nomina - editar', 'Modificar fichas de empleados, turnos de asistencia y descuentos'),
  ('Nomina', 'eliminar', 'Nomina - eliminar', 'Inactivar empleados o anular entregas/pagos autorizados'),
  ('Nomina', 'calcular', 'Nomina - calcular', 'Generar y procesar cálculos de periodos de nómina'),
  ('Nomina', 'pagar', 'Nomina - pagar', 'Registrar comprobantes de pago de nómina, anticipos y liquidaciones'),
  ('Nomina', 'exportar', 'Nomina - exportar', 'Descargar informes consolidados de nómina y comprobantes')
ON CONFLICT (module, action) WHERE module IS NOT NULL AND action IS NOT NULL
DO NOTHING;

-- Asignar permisos por defecto a Super Administrador y Administrador
INSERT INTO pedidos_app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM pedidos_app_roles r
CROSS JOIN pedidos_app_permissions p
WHERE r.name IN ('Super Administrador', 'Administrador')
  AND p.module = 'Nomina'
ON CONFLICT DO NOTHING;

-- Asignar permisos de consulta y cálculo a Contabilidad y Gerente
INSERT INTO pedidos_app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM pedidos_app_roles r
JOIN pedidos_app_permissions p ON p.module = 'Nomina' AND p.action IN ('ver', 'calcular', 'exportar')
WHERE r.name IN ('Gerente', 'Contabilidad')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- ESTRATEGIA DE REVERSIÓN Y RECUPERACIÓN (ROLLBACK VS RECOVERY)
-- ============================================================================
-- ESCENARIO A: Reversión inmediata sobre base de datos VACÍA (sin transacciones operativas):
-- Si la migración se ejecutó y se decide cancelar antes de que se creen registros operativos:
--
-- DROP TABLE IF EXISTS pedidos_app_payroll_payments CASCADE;
-- DROP TABLE IF EXISTS pedidos_app_payroll_items CASCADE;
-- DROP TABLE IF EXISTS pedidos_app_payroll_periods CASCADE;
-- DROP TRIGGER IF EXISTS trg_check_payroll_period_overlap ON pedidos_app_payroll_periods;
-- DROP FUNCTION IF EXISTS check_payroll_period_overlap();
-- DROP TABLE IF EXISTS pedidos_app_employee_deductions CASCADE;
-- DROP TABLE IF EXISTS pedidos_app_employee_settlements CASCADE;
-- DROP TABLE IF EXISTS pedidos_app_employee_meals CASCADE;
-- DROP TABLE IF EXISTS pedidos_app_employee_attendance CASCADE;
-- DROP TABLE IF EXISTS pedidos_app_employees CASCADE;
-- DROP TRIGGER IF EXISTS trg_check_payroll_config_overlap ON pedidos_app_payroll_config;
-- DROP FUNCTION IF EXISTS check_payroll_config_overlap();
-- DROP TABLE IF EXISTS pedidos_app_payroll_config CASCADE;
-- DELETE FROM pedidos_app_role_permissions WHERE permission_id IN (SELECT id FROM pedidos_app_permissions WHERE module = 'Nomina');
-- DELETE FROM pedidos_app_permissions WHERE module = 'Nomina';
--
-- ESCENARIO B: Recuperación / Desactivación sobre base de datos CON DATOS OPERATIVOS:
-- Si ya existen pagos de nómina, empleados y salidas de inventario por comidas:
--
-- 1. PROHIBICIÓN ABSOLUTA: NO ejecutar DROP TABLE. Destruiría los comprobantes de pago
--    y dejaría inconsistencias físicas y contables en pedidos_app_product_stock_movements.
-- 2. Desactivación limpia: Comentar la línea de montaje en server.js:
--    // require('./nomina_api')(app, ...);
-- 3. Retirar visibilidad en frontend desactivando la ruta en AdminLayout.jsx.
-- 4. Reconciliación física: Si se desea revertir los consumos de inventario de comidas,
--    ejecutar consultas de anulación mediante el endpoint oficial POST /meals/:id/cancel
--    para generar los movimientos compensatorios correspondientes.
-- 5. Exportar y resguardar en archivo CSV/Excel la totalidad de las tablas pedidos_app_payroll_*.
