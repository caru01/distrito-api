/**
 * nomina_api.js
 * Distrito BG - Módulo Modular de Nómina Integral
 * 
 * Versión de Seguridad y Auditoría Laboral:
 * 1. Configuración de Parámetros Laborales con vigencias históricas (SMMLV 2026, Auxilio de Transporte 2026).
 * 2. Gestión de Empleados con régimen mixto (Laboral, Por Días Dec. 2616, Jornal/Turno, Prestación de Servicios).
 * 3. Asistencia Diaria & Matriz Mensual con soporte para turnos múltiples, recargos y protección de periodos cerrados.
 * 4. Comidas y Suministros a Empleados integrados con pedidos_app_product_recipes y pedidos_app_inventory:
 *    - Bloqueo de productos sin receta (exige confirmación expresa allow_untracked_meal si no hay receta).
 *    - Descuentos atómicos con FOR UPDATE e idempotencia.
 *    - Anulación con restitución física exacta sin movimientos huérfanos ni alteraciones fantasmas.
 * 5. Periodos de Nómina con prevención de solapamiento, tope de 2 SMMLV en auxilio de transporte,
 *    cálculo riguroso de recargos y congelamiento de parámetros en el cálculo.
 * 6. Pagos y Comprobantes de Nómina con anulación y reversión de saldos pendientes.
 * 7. Anticipos, Préstamos y Descuentos con topes y cuotas.
 * 8. Liquidaciones de Retiro (cesantías, intereses, prima, vacaciones) diferenciadas por régimen.
 * 9. Resumen Ejecutivo (KPIs).
 */

const express = require('express');

const {
  calculateSettlementEstimator,
  summarizeAttendance,
  calculateMonthlyPeriodPay,
  evaluatePaymentIdempotency,
  round2
} = require('./nomina_calc');

module.exports = function(app, { pool, authenticateToken, requirePermission, logActivity }) {
  const router = express.Router();

  const BOGOTA_TZ = 'America/Bogota';

  // Helper para normalizar o extraer fecha en zona horaria America/Bogota ('YYYY-MM-DD')
  const toBogotaDateOnly = (dateValue = null) => {
    if (dateValue) {
      const trimmed = String(dateValue).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return trimmed;
      }
      const d = new Date(trimmed);
      if (Number.isFinite(d.getTime())) {
        return new Intl.DateTimeFormat('en-CA', { timeZone: BOGOTA_TZ }).format(d);
      }
    }
    return new Intl.DateTimeFormat('en-CA', { timeZone: BOGOTA_TZ }).format(new Date());
  };

  // Helper de verificación de permisos
  const checkPerm = (action) => {
    if (typeof requirePermission === 'function') {
      return requirePermission('Nomina', action);
    }
    return (req, res, next) => next();
  };

  // Helper de auditoría
  const audit = async (req, action, details, requestData = null) => {
    if (typeof logActivity === 'function' && req.user) {
      try {
        const ip = req.ip || req.connection?.remoteAddress || '-';
        const ua = req.headers['user-agent'] || '-';
        await logActivity(req.user.id, 'Nomina', action, details, ip, 'Linux/Windows', ua.substring(0, 50), requestData);
      } catch (e) {
        console.error('Error registrando auditoría de Nómina:', e.message);
      }
    }
  };

  // Asegurar tabla de amortizaciones de deducciones en nómina
  pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos_app_payroll_deduction_amortizations (
      id SERIAL PRIMARY KEY,
      payroll_period_id INTEGER NOT NULL REFERENCES pedidos_app_payroll_periods(id) ON DELETE CASCADE,
      payroll_item_id INTEGER NOT NULL REFERENCES pedidos_app_payroll_items(id) ON DELETE CASCADE,
      deduction_id INTEGER NOT NULL REFERENCES pedidos_app_employee_deductions(id) ON DELETE CASCADE,
      amount_deducted NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pad_period ON pedidos_app_payroll_deduction_amortizations(payroll_period_id);
    CREATE INDEX IF NOT EXISTS idx_pad_deduction ON pedidos_app_payroll_deduction_amortizations(deduction_id);
  `).catch(err => console.error('[Nomina] Error asegurando tabla amortizaciones:', err.message));

  // Helper para sanitizar respuestas de error de servidor (SEC-02)
  const handleServerError = (res, err, publicMessage = 'No fue posible completar la operación debido a un error interno.') => {
    console.error('[Nomina Server Error]', err);
    if (err && err.statusCode && err.statusCode !== 500) {
      return res.status(err.statusCode).json({ status: 'error', error: err.message, code: err.code });
    }
    return res.status(500).json({
      status: 'error',
      code: 'INTERNAL_SERVER_ERROR',
      error: publicMessage
    });
  };

  // Helper para consultar configuración laboral vigente según fecha
  const getActivePayrollConfig = async (dateStr = null) => {
    const targetDate = toBogotaDateOnly(dateStr);
    const { rows } = await pool.query(`
      SELECT * FROM pedidos_app_payroll_config
      WHERE valid_from <= $1::date AND (valid_to IS NULL OR valid_to >= $1::date)
      ORDER BY valid_from DESC
      LIMIT 1
    `, [targetDate]);

    if (rows.length > 0) return rows[0];

    // Fallback con valores oficiales 2026 si la tabla estuviese vacía
    return {
      year: 2026,
      valid_from: '2026-01-01',
      valid_to: null,
      smmlv_amount: 1750905,
      transport_allowance_monthly: 249095,
      transport_allowance_daily: 8303.17,
      standard_daily_hours: 8,
      health_employee_pct: 4,
      pension_employee_pct: 4,
      night_shift_surcharge_pct: 35,
      holiday_surcharge_pct: 75,
      overtime_day_surcharge_pct: 25,
      overtime_night_surcharge_pct: 75,
      default_period_type: 'quincenal',
      allow_negative_stock: false
    };
  };

  // ==========================================================================
  // 1. CONFIGURACIÓN LABORAL Y OPERATIVA (CON VIGENCIAS)
  // ==========================================================================

  // Obtener parámetros de configuración (por año o vigencia activa)
  router.get('/config', authenticateToken, checkPerm('ver'), async (req, res) => {
    try {
      const year = req.query.year ? Number(req.query.year) : null;
      let config;

      if (year) {
        const { rows } = await pool.query('SELECT * FROM pedidos_app_payroll_config WHERE year = $1', [year]);
        config = rows[0] || await getActivePayrollConfig();
      } else {
        config = await getActivePayrollConfig(req.query.date || null);
      }

      // Obtener listado de todas las vigencias registradas para histórico
      const { rows: history } = await pool.query('SELECT * FROM pedidos_app_payroll_config ORDER BY year DESC');

      res.json({ status: 'ok', config, history });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al consultar la configuración de nómina.');
    }
  });

  // Actualizar o crear parámetros de configuración con vigencia
  router.put('/config', authenticateToken, checkPerm('editar'), async (req, res) => {
    try {
      const {
        year = new Date().getFullYear(),
        valid_from = `${new Date().getFullYear()}-01-01`,
        valid_to = null,
        smmlv_amount,
        transport_allowance_monthly,
        transport_allowance_daily,
        standard_daily_hours,
        health_employee_pct,
        pension_employee_pct,
        night_shift_surcharge_pct,
        holiday_surcharge_pct,
        overtime_day_surcharge_pct,
        overtime_night_surcharge_pct,
        default_period_type,
        allow_negative_stock,
        legal_reference
      } = req.body;

      const monthlyTrans = Number(transport_allowance_monthly) || 249095;
      const dailyTrans = transport_allowance_daily ? Number(transport_allowance_daily) : Math.round((monthlyTrans / 30) * 100) / 100;

      // UPDATE por año y, si no existe, INSERT. (Un INSERT ... ON CONFLICT dispararía el trigger de solapamiento
      // BEFORE INSERT contra la propia fila del mismo año y rechazaría toda actualización legítima.)
      const cfgValues = [
        Number(year),
        valid_from,
        valid_to || null,
        Number(smmlv_amount) || 1750905,
        monthlyTrans,
        dailyTrans,
        Number(standard_daily_hours) || 8,
        Number(health_employee_pct) || 4,
        Number(pension_employee_pct) || 4,
        Number(night_shift_surcharge_pct) || 35,
        Number(holiday_surcharge_pct) || 75,
        Number(overtime_day_surcharge_pct) || 25,
        Number(overtime_night_surcharge_pct) || 75,
        default_period_type || 'quincenal',
        Boolean(allow_negative_stock),
        legal_reference?.trim() || null
      ];

      let { rows } = await pool.query(`
        UPDATE pedidos_app_payroll_config SET
          valid_from = $2::date,
          valid_to = $3::date,
          smmlv_amount = $4,
          transport_allowance_monthly = $5,
          transport_allowance_daily = $6,
          standard_daily_hours = $7,
          health_employee_pct = $8,
          pension_employee_pct = $9,
          night_shift_surcharge_pct = $10,
          holiday_surcharge_pct = $11,
          overtime_day_surcharge_pct = $12,
          overtime_night_surcharge_pct = $13,
          default_period_type = $14,
          allow_negative_stock = $15,
          legal_reference = $16,
          updated_at = NOW()
        WHERE year = $1
        RETURNING *
      `, cfgValues);

      if (rows.length === 0) {
        ({ rows } = await pool.query(`
          INSERT INTO pedidos_app_payroll_config (
            year, valid_from, valid_to, smmlv_amount, transport_allowance_monthly, transport_allowance_daily,
            standard_daily_hours, health_employee_pct, pension_employee_pct,
            night_shift_surcharge_pct, holiday_surcharge_pct, overtime_day_surcharge_pct, overtime_night_surcharge_pct,
            default_period_type, allow_negative_stock, is_active, legal_reference, updated_at
          ) VALUES (
            $1, $2::date, $3::date, $4, $5, $6,
            $7, $8, $9,
            $10, $11, $12, $13,
            $14, $15, true, $16, NOW()
          )
          RETURNING *
        `, cfgValues));
      }

      await audit(req, 'Configuración actualizada', `Parámetros de nómina para año ${year} guardados`);
      res.json({ status: 'ok', config: rows[0], message: `Configuración para el año ${year} guardada exitosamente.` });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al guardar la configuración de nómina.');
    }
  });

  // ==========================================================================
  // 2. GESTIÓN DE EMPLEADOS (RÉGIMEN MIXTO)
  // ==========================================================================

  // Listar empleados con filtros
  router.get('/employees', authenticateToken, checkPerm('ver'), async (req, res) => {
    try {
      const { status, position, contract_type, search } = req.query;
      let query = `
        SELECT 
          e.*,
          COALESCE(att.days_worked_month, 0) AS current_month_days_worked,
          COALESCE(meals.meals_count_month, 0) AS current_month_meals_count,
          COALESCE(ded.pending_deductions_balance, 0) AS pending_deductions_balance
        FROM pedidos_app_employees e
        LEFT JOIN (
          SELECT employee_id, COUNT(*) AS days_worked_month
          FROM pedidos_app_employee_attendance
          WHERE status = 'Trabajó' AND attendance_date >= date_trunc('month', CURRENT_DATE)
          GROUP BY employee_id
        ) att ON att.employee_id = e.id
        LEFT JOIN (
          SELECT employee_id, COUNT(*) AS meals_count_month
          FROM pedidos_app_employee_meals
          WHERE status = 'Entregado' AND delivery_date >= date_trunc('month', CURRENT_DATE)
          GROUP BY employee_id
        ) meals ON meals.employee_id = e.id
        LEFT JOIN (
          SELECT employee_id, SUM(balance_remaining) AS pending_deductions_balance
          FROM pedidos_app_employee_deductions
          WHERE status IN ('Pendiente', 'Parcial')
          GROUP BY employee_id
        ) ded ON ded.employee_id = e.id
        WHERE 1=1
      `;
      const params = [];

      if (status && status !== 'todos') {
        params.push(status);
        query += ` AND e.status = $${params.length}`;
      }

      if (position && position !== 'todos') {
        params.push(position);
        query += ` AND e.position = $${params.length}`;
      }

      if (contract_type && contract_type !== 'todos') {
        params.push(contract_type);
        query += ` AND e.contract_type = $${params.length}`;
      }

      if (search && search.trim()) {
        params.push(`%${search.trim().toLowerCase()}%`);
        query += ` AND (
          LOWER(e.first_name || ' ' || e.last_name) LIKE $${params.length}
          OR LOWER(e.document_number) LIKE $${params.length}
          OR LOWER(COALESCE(e.position, '')) LIKE $${params.length}
          OR LOWER(COALESCE(e.phone, '')) LIKE $${params.length}
        )`;
      }

      query += ` ORDER BY e.status ASC, e.first_name ASC, e.last_name ASC`;

      const { rows } = await pool.query(query, params);
      res.json({ status: 'ok', employees: rows });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al consultar la lista de empleados.');
    }
  });

  // Detalle de un empleado con historial
  router.get('/employees/:id', authenticateToken, checkPerm('ver'), async (req, res) => {
    try {
      const { id } = req.params;
      const { rows } = await pool.query('SELECT * FROM pedidos_app_employees WHERE id = $1', [id]);
      if (rows.length === 0) {
        return res.status(404).json({ status: 'error', error: 'Empleado no encontrado' });
      }

      const employee = rows[0];

      // Historial de asistencia reciente (últimos 30 turnos)
      const { rows: attendance } = await pool.query(`
        SELECT * FROM pedidos_app_employee_attendance 
        WHERE employee_id = $1 
        ORDER BY attendance_date DESC, shift_number DESC 
        LIMIT 30
      `, [id]);

      // Historial de comidas recientes
      const { rows: meals } = await pool.query(`
        SELECT 
          id, employee_id, TO_CHAR(delivery_date, 'YYYY-MM-DD') AS delivery_date,
          item_type, product_id, inventory_id, item_title, quantity,
          unit_cost, total_cost, stock_movement_id, is_untracked,
          idempotency_key, status, cancel_reason, annulled_at, annulled_by,
          registered_by, notes, created_at
        FROM pedidos_app_employee_meals 
        WHERE employee_id = $1 
        ORDER BY delivery_date DESC 
        LIMIT 30
      `, [id]);

      // Préstamos y deducciones activas
      const { rows: deductions } = await pool.query(`
        SELECT * FROM pedidos_app_employee_deductions 
        WHERE employee_id = $1 
        ORDER BY request_date DESC
      `, [id]);

      res.json({
        status: 'ok',
        employee,
        recentAttendance: attendance,
        recentMeals: meals,
        deductions
      });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al consultar el detalle del empleado.');
    }
  });

  // Crear empleado
  router.post('/employees', authenticateToken, checkPerm('crear'), async (req, res) => {
    try {
      const {
        first_name,
        last_name,
        document_type = 'CC',
        document_number,
        phone,
        email,
        address,
        position,
        contract_type = 'Laboral - Término Indefinido',
        salary_base = 0,
        daily_rate = 0,
        hourly_rate = 0,
        payment_frequency = 'quincenal',
        has_transport_allowance = true,
        transport_allowance_daily,
        deduce_health,
        deduce_pension,
        health_percentage = 4,
        pension_percentage = 4,
        additional_benefits = [],
        hire_date,
        bank_name,
        bank_account_type = 'Ahorros',
        bank_account_number,
        emergency_contact_name,
        emergency_contact_phone,
        notes,
        marital_status = 'Soltero/a',
        birth_date,
        payment_method = 'Efectivo'
      } = req.body;

      if (!first_name?.trim() || !last_name?.trim() || !document_number?.trim() || !position?.trim()) {
        return res.status(400).json({
          status: 'error',
          error: 'Nombres, apellidos, número de identificación y cargo son campos obligatorios.'
        });
      }

      // Validar cédula única
      const { rows: existingDoc } = await pool.query(
        'SELECT id FROM pedidos_app_employees WHERE document_number = $1',
        [document_number.trim()]
      );
      if (existingDoc.length > 0) {
        return res.status(400).json({
          status: 'error',
          error: `Ya existe un empleado registrado con el documento de identidad ${document_number.trim()}.`
        });
      }

      const activeConfig = await getActivePayrollConfig(hire_date || null);
      const defaultDailyTransport = activeConfig.transport_allowance_daily || 8303.17;

      const isLabor = contract_type.startsWith('Laboral');
      const isServices = contract_type === 'Prestación de Servicios';
      const actualDeduceHealth = deduce_health !== undefined ? Boolean(deduce_health) : isLabor;
      const actualDeducePension = deduce_pension !== undefined ? Boolean(deduce_pension) : isLabor;
      const actualHasTransport = isServices ? false : (has_transport_allowance !== undefined ? Boolean(has_transport_allowance) : true);

      let calculatedDaily = Number(daily_rate) || 0;
      if (calculatedDaily === 0 && Number(salary_base) > 0) {
        calculatedDaily = Math.round((Number(salary_base) / 30) * 100) / 100;
      }

      let calculatedHourly = Number(hourly_rate) || 0;
      if (calculatedHourly === 0 && calculatedDaily > 0) {
        calculatedHourly = Math.round((calculatedDaily / (activeConfig.standard_daily_hours || 8)) * 100) / 100;
      }

      const { rows } = await pool.query(`
        INSERT INTO pedidos_app_employees (
          first_name, last_name, document_type, document_number, phone, email, address,
          position, contract_type, salary_base, daily_rate, hourly_rate, payment_frequency,
          has_transport_allowance, transport_allowance_daily,
          deduce_health, deduce_pension, health_percentage, pension_percentage,
          additional_benefits, hire_date, bank_name, bank_account_type, bank_account_number,
          emergency_contact_name, emergency_contact_phone, notes, status,
          marital_status, birth_date, payment_method
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13,
          $14, $15,
          $16, $17, $18, $19,
          $20, COALESCE($21::date, CURRENT_DATE), $22, $23, $24,
          $25, $26, $27, 'Activo',
          $28, $29::date, $30
        )
        RETURNING *
      `, [
        first_name.trim(),
        last_name.trim(),
        document_type.trim(),
        document_number.trim(),
        phone?.trim() || null,
        email?.trim() || null,
        address?.trim() || null,
        position.trim(),
        contract_type.trim(),
        Number(salary_base) || 0,
        calculatedDaily,
        calculatedHourly,
        payment_frequency,
        actualHasTransport,
        transport_allowance_daily ? Number(transport_allowance_daily) : defaultDailyTransport,
        actualDeduceHealth,
        actualDeducePension,
        Number(health_percentage) || 4,
        Number(pension_percentage) || 4,
        JSON.stringify(Array.isArray(additional_benefits) ? additional_benefits : []),
        hire_date || null,
        bank_name?.trim() || null,
        bank_account_type?.trim() || 'Ahorros',
        bank_account_number?.trim() || null,
        emergency_contact_name?.trim() || null,
        emergency_contact_phone?.trim() || null,
        notes?.trim() || null,
        marital_status?.trim() || 'Soltero/a',
        birth_date || null,
        payment_method?.trim() || 'Efectivo'
      ]);

      await audit(req, 'Empleado creado', `Empleado ${first_name} ${last_name} (${position}) registrado exitosamente`);
      res.status(201).json({ status: 'ok', employee: rows[0], message: 'Empleado registrado exitosamente.' });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al registrar el empleado.');
    }
  });

  // Actualizar empleado
  router.put('/employees/:id', authenticateToken, checkPerm('editar'), async (req, res) => {
    try {
      const { id } = req.params;
      const {
        first_name,
        last_name,
        document_type,
        document_number,
        phone,
        email,
        address,
        position,
        contract_type,
        salary_base,
        daily_rate,
        hourly_rate,
        payment_frequency,
        has_transport_allowance,
        transport_allowance_daily,
        deduce_health,
        deduce_pension,
        health_percentage,
        pension_percentage,
        additional_benefits,
        hire_date,
        discharge_date,
        discharge_reason,
        status,
        bank_name,
        bank_account_type,
        bank_account_number,
        emergency_contact_name,
        emergency_contact_phone,
        notes,
        marital_status,
        birth_date,
        payment_method
      } = req.body;

      const { rows: currentRows } = await pool.query('SELECT * FROM pedidos_app_employees WHERE id = $1', [id]);
      if (currentRows.length === 0) {
        return res.status(404).json({ status: 'error', error: 'Empleado no encontrado' });
      }

      if (document_number && document_number.trim() !== currentRows[0].document_number) {
        const { rows: conflict } = await pool.query(
          'SELECT id FROM pedidos_app_employees WHERE document_number = $1 AND id <> $2',
          [document_number.trim(), id]
        );
        if (conflict.length > 0) {
          return res.status(400).json({
            status: 'error',
            error: `Ya existe otro empleado registrado con el documento ${document_number.trim()}.`
          });
        }
      }

      const { rows } = await pool.query(`
        UPDATE pedidos_app_employees SET
          first_name = COALESCE($1, first_name),
          last_name = COALESCE($2, last_name),
          document_type = COALESCE($3, document_type),
          document_number = COALESCE($4, document_number),
          phone = $5,
          email = $6,
          address = $7,
          position = COALESCE($8, position),
          contract_type = COALESCE($9, contract_type),
          salary_base = COALESCE($10, salary_base),
          daily_rate = COALESCE($11, daily_rate),
          hourly_rate = COALESCE($12, hourly_rate),
          payment_frequency = COALESCE($13, payment_frequency),
          has_transport_allowance = COALESCE($14, has_transport_allowance),
          transport_allowance_daily = COALESCE($15, transport_allowance_daily),
          deduce_health = COALESCE($16, deduce_health),
          deduce_pension = COALESCE($17, deduce_pension),
          health_percentage = COALESCE($18, health_percentage),
          pension_percentage = COALESCE($19, pension_percentage),
          additional_benefits = COALESCE($20, additional_benefits),
          hire_date = COALESCE($21::date, hire_date),
          discharge_date = $22::date,
          discharge_reason = $23,
          status = COALESCE($24, status),
          bank_name = $25,
          bank_account_type = $26,
          bank_account_number = $27,
          emergency_contact_name = $28,
          emergency_contact_phone = $29,
          notes = $30,
          marital_status = COALESCE($31, marital_status),
          birth_date = COALESCE($32::date, birth_date),
          payment_method = COALESCE($33, payment_method),
          updated_at = NOW()
        WHERE id = $34
        RETURNING *
      `, [
        first_name?.trim(),
        last_name?.trim(),
        document_type?.trim(),
        document_number?.trim(),
        phone?.trim() || null,
        email?.trim() || null,
        address?.trim() || null,
        position?.trim(),
        contract_type?.trim(),
        salary_base !== undefined ? Number(salary_base) : null,
        daily_rate !== undefined ? Number(daily_rate) : null,
        hourly_rate !== undefined ? Number(hourly_rate) : null,
        payment_frequency?.trim(),
        has_transport_allowance !== undefined ? Boolean(has_transport_allowance) : null,
        transport_allowance_daily !== undefined ? Number(transport_allowance_daily) : null,
        deduce_health !== undefined ? Boolean(deduce_health) : null,
        deduce_pension !== undefined ? Boolean(deduce_pension) : null,
        health_percentage !== undefined ? Number(health_percentage) : null,
        pension_percentage !== undefined ? Number(pension_percentage) : null,
        additional_benefits ? JSON.stringify(additional_benefits) : null,
        hire_date || null,
        discharge_date || null,
        discharge_reason?.trim() || null,
        status?.trim(),
        bank_name?.trim() || null,
        bank_account_type?.trim() || null,
        bank_account_number?.trim() || null,
        emergency_contact_name?.trim() || null,
        emergency_contact_phone?.trim() || null,
        notes?.trim() || null,
        marital_status?.trim() || null,
        birth_date || null,
        payment_method?.trim() || null,
        id
      ]);

      await audit(req, 'Empleado modificado', `Empleado #${rows[0].document_number} actualizado`);
      res.json({ status: 'ok', employee: rows[0], message: 'Datos del empleado actualizados.' });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al actualizar datos del empleado.');
    }
  });

  // Cambiar estado de empleado (Activar / Inactivar / Retirar)
  router.patch('/employees/:id/status', authenticateToken, checkPerm('editar'), async (req, res) => {
    try {
      const { id } = req.params;
      const { status, discharge_date, discharge_reason } = req.body;

      if (!['Activo', 'Inactivo', 'Retirado'].includes(status)) {
        return res.status(400).json({ status: 'error', error: 'Estado inválido. Debe ser Activo, Inactivo o Retirado.' });
      }

      const { rows } = await pool.query(`
        UPDATE pedidos_app_employees SET
          status = $1,
          discharge_date = CASE WHEN $1 = 'Retirado' THEN COALESCE($2::date, CURRENT_DATE) ELSE discharge_date END,
          discharge_reason = CASE WHEN $1 = 'Retirado' THEN COALESCE($3, discharge_reason) ELSE discharge_reason END,
          updated_at = NOW()
        WHERE id = $4
        RETURNING id, first_name, last_name, status, discharge_date
      `, [status, discharge_date || null, discharge_reason || null, id]);

      if (rows.length === 0) {
        return res.status(404).json({ status: 'error', error: 'Empleado no encontrado' });
      }

      await audit(req, 'Cambio estado empleado', `Empleado ${rows[0].first_name} ${rows[0].last_name} cambió estado a ${status}`);
      res.json({ status: 'ok', employee: rows[0], message: `Estado actualizado a ${status}.` });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al actualizar el estado del empleado.');
    }
  });

  // ==========================================================================
  // 3. ASISTENCIA DIARIA & RECARGOS (PROTECCIÓN DE PERIODOS CERRADOS)
  // ==========================================================================

  // Consultar asistencia por rango de fechas
  router.get('/attendance', authenticateToken, checkPerm('ver'), async (req, res) => {
    try {
      const { date_from, date_to, employee_id, status } = req.query;

      let query = `
        SELECT 
          att.*,
          e.first_name,
          e.last_name,
          e.document_number,
          e.position,
          e.contract_type,
          e.daily_rate AS employee_daily_rate,
          e.has_transport_allowance,
          e.transport_allowance_daily
        FROM pedidos_app_employee_attendance att
        JOIN pedidos_app_employees e ON e.id = att.employee_id
        WHERE 1=1
      `;
      const params = [];

      if (date_from) {
        params.push(date_from);
        query += ` AND att.attendance_date >= $${params.length}::date`;
      }
      if (date_to) {
        params.push(date_to);
        query += ` AND att.attendance_date <= $${params.length}::date`;
      }
      if (employee_id) {
        params.push(employee_id);
        query += ` AND att.employee_id = $${params.length}`;
      }
      if (status && status !== 'todos') {
        params.push(status);
        query += ` AND att.status = $${params.length}`;
      }

      query += ` ORDER BY att.attendance_date DESC, att.shift_number ASC, e.first_name ASC`;

      const { rows } = await pool.query(query, params);
      res.json({ status: 'ok', attendance: rows });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al consultar registros de asistencia.');
    }
  });

  // Matriz mensual del calendario (días 1 a 31)
  router.get('/attendance/monthly-matrix', authenticateToken, checkPerm('ver'), async (req, res) => {
    try {
      const year = Number(req.query.year) || new Date().getFullYear();
      const month = Number(req.query.month) || (new Date().getMonth() + 1);

      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDayDate = new Date(year, month, 0).getDate();
      const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDayDate).padStart(2, '0')}`;

      const { rows: employees } = await pool.query(`
        SELECT id, first_name, last_name, document_number, position, contract_type, daily_rate, has_transport_allowance
        FROM pedidos_app_employees
        WHERE status = 'Activo' OR (discharge_date IS NOT NULL AND discharge_date >= $1::date)
        ORDER BY first_name ASC, last_name ASC
      `, [startDate]);

      const { rows: records } = await pool.query(`
        SELECT employee_id, attendance_date, shift_number, shift_type, status, hours_worked,
               overtime_day_hours, overtime_night_hours, night_hours, holiday_hours,
               daily_value_applied, transport_allowance_applied, overtime_value_applied, had_meal
        FROM pedidos_app_employee_attendance
        WHERE attendance_date BETWEEN $1::date AND $2::date
        ORDER BY attendance_date ASC, shift_number ASC
      `, [startDate, endDate]);

      const { rows: meals } = await pool.query(`
        SELECT employee_id, TO_CHAR(delivery_date, 'YYYY-MM-DD') AS delivery_date, COUNT(*) AS count
        FROM pedidos_app_employee_meals
        WHERE status = 'Entregado' AND delivery_date BETWEEN $1::date AND $2::date
        GROUP BY employee_id, delivery_date
      `, [startDate, endDate]);

      res.json({
        status: 'ok',
        year,
        month,
        daysInMonth: lastDayDate,
        startDate,
        endDate,
        employees,
        attendanceRecords: records,
        mealsRecords: meals
      });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al generar la matriz mensual de asistencia.');
    }
  });

  // Registrar asistencia diaria con recargos y protección de periodos cerrados
  router.post('/attendance', authenticateToken, checkPerm('crear'), async (req, res) => {
    try {
      const {
        employee_id,
        attendance_date,
        shift_number = 1,
        shift_type = 'Completo',
        status = 'Trabajó',
        check_in_time,
        check_out_time,
        hours_worked = 8,
        overtime_day_hours = 0,
        overtime_night_hours = 0,
        night_hours = 0,
        holiday_hours = 0,
        custom_daily_value,
        custom_transport_value,
        had_meal = false,
        meal_notes,
        supplies_notes,
        notes
      } = req.body;

      if (!employee_id || !attendance_date) {
        return res.status(400).json({ status: 'error', error: 'Empleado y fecha son obligatorios.' });
      }

      // VALIDACIÓN CRÍTICA: Proteger periodos cerrados
      const { rows: closedPeriods } = await pool.query(`
        SELECT id, name FROM pedidos_app_payroll_periods
        WHERE status = 'Cerrado' AND $1::date BETWEEN start_date AND end_date
      `, [attendance_date]);

      if (closedPeriods.length > 0) {
        return res.status(400).json({
          status: 'error',
          error: `No es posible registrar ni modificar asistencia para el ${attendance_date} porque pertenece al periodo cerrado "${closedPeriods[0].name}".`
        });
      }

      const { rows: empRows } = await pool.query(
        'SELECT daily_rate, hourly_rate, has_transport_allowance, transport_allowance_daily, salary_base, contract_type FROM pedidos_app_employees WHERE id = $1',
        [employee_id]
      );
      if (empRows.length === 0) {
        return res.status(404).json({ status: 'error', error: 'Empleado no encontrado.' });
      }

      const emp = empRows[0];
      const activeCfg = await getActivePayrollConfig(attendance_date);
      let dailyValue = 0;
      let transportValue = 0;

      if (custom_daily_value !== undefined && custom_daily_value !== null) {
        dailyValue = Number(custom_daily_value);
      } else {
        const isLaborMonthly = emp.contract_type?.startsWith('Laboral') && Number(emp.salary_base || 0) > 0;
        if (status === 'Trabajó') {
          dailyValue = Number(emp.daily_rate) || Math.round((Number(emp.salary_base || 0) / 30) * 100) / 100;
        } else if (status === 'Media jornada') {
          dailyValue = Math.round(((Number(emp.daily_rate) || (Number(emp.salary_base || 0) / 30)) / 2) * 100) / 100;
        } else if (isLaborMonthly && ['Descanso', 'Permiso remunerado', 'Vacaciones', 'Festivo'].includes(status)) {
          dailyValue = Math.round((Number(emp.salary_base || 0) / 30) * 100) / 100;
        } else if (!isLaborMonthly && status === 'Permiso remunerado') {
          dailyValue = Number(emp.daily_rate) || 0;
        } else {
          dailyValue = 0;
        }
      }

      // Auxilio de transporte: Jurisprudencia Colombia (Corte Suprema):
      // En media jornada se causa el auxilio COMPLETO del día porque el empleado gasta el mismo pasaje de ida y vuelta.
      if (custom_transport_value !== undefined && custom_transport_value !== null) {
        transportValue = Number(custom_transport_value);
      } else if (emp.has_transport_allowance && emp.contract_type !== 'Prestación de Servicios' && ['Trabajó', 'Media jornada'].includes(status)) {
        transportValue = Number(emp.transport_allowance_daily) || activeCfg.transport_allowance_daily;
      }

      // Cálculo de horas extras y recargos
      const hourly = Number(emp.hourly_rate) > 0 ? Number(emp.hourly_rate) : ((Number(emp.daily_rate) || (Number(emp.salary_base || 0)/30)) / (activeCfg.standard_daily_hours || 8));
      const overtimeVal = Math.round(
        hourly * (
          (Number(overtime_day_hours) || 0) * (1 + (Number(activeCfg.overtime_day_surcharge_pct || 25)/100)) +
          (Number(overtime_night_hours) || 0) * (1 + (Number(activeCfg.overtime_night_surcharge_pct || 75)/100)) +
          (Number(night_hours) || 0) * (Number(activeCfg.night_shift_surcharge_pct || 35)/100) +
          (Number(holiday_hours) || 0) * (Number(activeCfg.holiday_surcharge_pct || 75)/100)
        ) * 100
      ) / 100;

      const registeredBy = req.user?.username || req.user?.name || 'Administrador';

      const { rows } = await pool.query(`
        INSERT INTO pedidos_app_employee_attendance (
          employee_id, attendance_date, shift_number, shift_type, status,
          check_in_time, check_out_time, hours_worked,
          overtime_day_hours, overtime_night_hours, night_hours, holiday_hours,
          daily_value_applied, transport_allowance_applied, overtime_value_applied,
          had_meal, meal_notes, supplies_notes, notes, registered_by, updated_at
        ) VALUES (
          $1, $2::date, $3, $4, $5,
          $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14, $15,
          $16, $17, $18, $19, $20, NOW()
        )
        ON CONFLICT (employee_id, attendance_date, shift_number) DO UPDATE SET
          shift_type = EXCLUDED.shift_type,
          status = EXCLUDED.status,
          check_in_time = EXCLUDED.check_in_time,
          check_out_time = EXCLUDED.check_out_time,
          hours_worked = EXCLUDED.hours_worked,
          overtime_day_hours = EXCLUDED.overtime_day_hours,
          overtime_night_hours = EXCLUDED.overtime_night_hours,
          night_hours = EXCLUDED.night_hours,
          holiday_hours = EXCLUDED.holiday_hours,
          daily_value_applied = EXCLUDED.daily_value_applied,
          transport_allowance_applied = EXCLUDED.transport_allowance_applied,
          overtime_value_applied = EXCLUDED.overtime_value_applied,
          had_meal = EXCLUDED.had_meal,
          meal_notes = EXCLUDED.meal_notes,
          supplies_notes = EXCLUDED.supplies_notes,
          notes = EXCLUDED.notes,
          registered_by = EXCLUDED.registered_by,
          updated_at = NOW()
        RETURNING *
      `, [
        employee_id,
        attendance_date,
        Number(shift_number) || 1,
        shift_type,
        status,
        check_in_time || null,
        check_out_time || null,
        Number(hours_worked) || 8,
        Number(overtime_day_hours) || 0,
        Number(overtime_night_hours) || 0,
        Number(night_hours) || 0,
        Number(holiday_hours) || 0,
        dailyValue,
        transportValue,
        overtimeVal,
        Boolean(had_meal),
        meal_notes?.trim() || null,
        supplies_notes?.trim() || null,
        notes?.trim() || null,
        registeredBy
      ]);

      res.status(201).json({ status: 'ok', attendance: rows[0], message: 'Asistencia registrada correctamente.' });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al registrar la asistencia.');
    }
  });

  // ==========================================================================
  // 4. COMIDAS Y SUMINISTROS (CONTROL ESTRICTO DE INVENTARIO Y RECETAS)
  // ==========================================================================

  // Catálogo disponible para selección en entrega de comidas / suministros
  router.get('/catalog-items', authenticateToken, checkPerm('ver'), async (req, res) => {
    try {
      const { rows: products } = await pool.query(`
        SELECT p.id, p.title, p.price, p.category, p.image,
               COUNT(pr.id) AS recipe_items_count
        FROM pedidos_app_products p
        LEFT JOIN pedidos_app_product_recipes pr ON pr.product_id = p.id AND pr.is_controlled = true
        WHERE p.status = 'Activo'
        GROUP BY p.id
        ORDER BY p.title ASC
      `);

      const { rows: inventory } = await pool.query(`
        SELECT id, name, unit, stock, min_stock, unit_cost, average_cost, category, type
        FROM pedidos_app_inventory
        WHERE status = 'Activo'
        ORDER BY name ASC
      `);

      res.json({ status: 'ok', products, inventory });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al obtener el catálogo para comidas.');
    }
  });

  // Listar entregas realizadas
  router.get('/meals', authenticateToken, checkPerm('ver'), async (req, res) => {
    try {
      const { date_from, date_to, employee_id, status } = req.query;
      let query = `
        SELECT 
          m.id,
          m.employee_id,
          TO_CHAR(m.delivery_date, 'YYYY-MM-DD') AS delivery_date,
          m.item_type,
          m.product_id,
          m.inventory_id,
          m.item_title,
          m.quantity,
          m.unit_cost,
          m.total_cost,
          m.stock_movement_id,
          m.is_untracked,
          m.idempotency_key,
          m.status,
          m.cancel_reason,
          m.annulled_at,
          m.annulled_by,
          m.registered_by,
          m.notes,
          m.created_at,
          e.first_name,
          e.last_name,
          e.document_number,
          e.position
        FROM pedidos_app_employee_meals m
        JOIN pedidos_app_employees e ON e.id = m.employee_id
        WHERE 1=1
      `;
      const params = [];

      if (date_from) {
        params.push(date_from);
        query += ` AND m.delivery_date >= $${params.length}::date`;
      }
      if (date_to) {
        params.push(date_to);
        query += ` AND m.delivery_date <= $${params.length}::date`;
      }
      if (employee_id) {
        params.push(employee_id);
        query += ` AND m.employee_id = $${params.length}`;
      }
      if (status) {
        params.push(status);
        query += ` AND m.status = $${params.length}`;
      }

      query += ` ORDER BY m.delivery_date DESC, m.created_at DESC`;

      const { rows } = await pool.query(query, params);
      res.json({ status: 'ok', meals: rows });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al listar las entregas de comida.');
    }
  });

  // Registrar entrega de comida / suministro con control estricto de recetas
  router.post('/meals', authenticateToken, checkPerm('crear'), async (req, res) => {
    const client = await pool.connect();
    try {
      const {
        employee_id,
        delivery_date,
        item_type = 'Menu',
        product_id,
        inventory_id,
        quantity = 1,
        allow_untracked_meal = false, // Autorización expresa requerida si no hay receta
        notes,
        idempotency_key
      } = req.body;

      if (!employee_id || (!product_id && !inventory_id)) {
        return res.status(400).json({
          status: 'error',
          error: 'Empleado y producto o insumo a entregar son obligatorios.'
        });
      }

      const numQty = Number(quantity);
      if (isNaN(numQty) || numQty <= 0) {
        return res.status(400).json({ status: 'error', error: 'La cantidad debe ser un número positivo mayor a 0.' });
      }

      // Verificación de idempotencia
      if (idempotency_key) {
        const { rows: existing } = await client.query(
          'SELECT * FROM pedidos_app_employee_meals WHERE idempotency_key = $1',
          [idempotency_key]
        );
        if (existing.length > 0) {
          return res.json({
            status: 'ok',
            meal: existing[0],
            message: 'Esta entrega ya había sido procesada previamente (idempotente).'
          });
        }
      }

      await client.query('BEGIN');

      const { rows: empRows } = await client.query(
        'SELECT id, first_name, last_name, document_number FROM pedidos_app_employees WHERE id = $1',
        [employee_id]
      );
      if (empRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ status: 'error', error: 'Empleado no encontrado.' });
      }
      const emp = empRows[0];
      const deliveryDateActual = toBogotaDateOnly(delivery_date);
      const registeredBy = req.user?.username || 'Administrador';

      let itemTitle = '';
      let calculatedUnitCost = 0;
      let calculatedTotalCost = 0;
      let primaryStockMovementId = null;
      let isUntracked = false;

      // ==========================================================
      // CASO A: INSUMO DIRECTO (Bebida, insumo)
      // ==========================================================
      if (item_type === 'Insumo' || inventory_id) {
        const { rows: invRows } = await client.query(
          'SELECT id, name, unit, stock, unit_cost, average_cost, track_stock FROM pedidos_app_inventory WHERE id = $1 FOR UPDATE',
          [inventory_id]
        );
        if (invRows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'error', error: 'Insumo de inventario no encontrado.' });
        }

        const inv = invRows[0];
        itemTitle = inv.name;
        calculatedUnitCost = Number(inv.average_cost || inv.unit_cost || 0);
        calculatedTotalCost = Math.round(calculatedUnitCost * numQty * 100) / 100;

        if (inv.track_stock && Number(inv.stock || 0) < numQty) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            status: 'error',
            error: `Stock insuficiente para ${inv.name}. Stock actual: ${inv.stock} ${inv.unit || ''}, Cantidad solicitada: ${numQty}.`
          });
        }

        const { rows: updatedInv } = await client.query(`
          UPDATE pedidos_app_inventory
          SET stock = COALESCE(stock, 0) - $1, updated_at = NOW()
          WHERE id = $2
          RETURNING stock
        `, [numQty, inv.id]);

        const newStock = updatedInv[0].stock;

        const { rows: movRows } = await client.query(`
          INSERT INTO pedidos_app_product_stock_movements (
            inventory_id, movement_type, quantity, balance_after,
            unit_cost, total_cost, reason, created_by, created_at
          ) VALUES (
            $1, 'CONSUMO_EMPLEADO', $2, $3,
            $4, $5, $6, $7, NOW()
          )
          RETURNING id
        `, [
          inv.id,
          -numQty,
          newStock,
          calculatedUnitCost,
          calculatedTotalCost,
          `Comida/suministro a empleado ${emp.first_name} ${emp.last_name} (#${emp.document_number})`,
          registeredBy
        ]);

        primaryStockMovementId = movRows[0].id;

      } else {
        // ==========================================================
        // CASO B: PLATO DE LA CARTA (RECETAS EN pedidos_app_product_recipes)
        // ==========================================================
        const { rows: prodRows } = await client.query(
          'SELECT id, title, price FROM pedidos_app_products WHERE id = $1',
          [product_id]
        );
        if (prodRows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ status: 'error', error: 'Producto del menú no encontrado.' });
        }

        const prod = prodRows[0];
        itemTitle = prod.title;

        const { rows: recipeItems } = await client.query(`
          SELECT 
            pr.quantity AS recipe_quantity,
            inv.id AS inventory_id,
            inv.name AS inventory_name,
            inv.stock,
            inv.unit,
            inv.average_cost,
            inv.unit_cost,
            inv.track_stock
          FROM pedidos_app_product_recipes pr
          JOIN pedidos_app_inventory inv ON inv.id = pr.inventory_id
          WHERE pr.product_id = $1 AND pr.is_controlled = true
        `, [prod.id]);

        if (recipeItems.length > 0) {
          let totalRecipeCost = 0;

          // Bloquear con FOR UPDATE y verificar existencias
          for (const item of recipeItems) {
            const { rows: lockedInv } = await client.query(
              'SELECT id, stock, track_stock, name, unit, average_cost, unit_cost FROM pedidos_app_inventory WHERE id = $1 FOR UPDATE',
              [item.inventory_id]
            );

            if (lockedInv.length === 0) continue;
            const currentItem = lockedInv[0];
            const requiredQty = Number(item.recipe_quantity || 0) * numQty;

            if (currentItem.track_stock && Number(currentItem.stock || 0) < requiredQty) {
              await client.query('ROLLBACK');
              return res.status(400).json({
                status: 'error',
                error: `Stock insuficiente del ingrediente "${currentItem.name}". Requiere ${requiredQty} ${currentItem.unit || ''}, stock disponible: ${currentItem.stock}.`
              });
            }

            const costUnit = Number(currentItem.average_cost || currentItem.unit_cost || 0);
            const costItemTotal = costUnit * requiredQty;
            totalRecipeCost += costItemTotal;

            const { rows: upd } = await client.query(`
              UPDATE pedidos_app_inventory
              SET stock = COALESCE(stock, 0) - $1, updated_at = NOW()
              WHERE id = $2
              RETURNING stock
            `, [requiredQty, currentItem.id]);

            const { rows: mov } = await client.query(`
              INSERT INTO pedidos_app_product_stock_movements (
                inventory_id, product_id, movement_type, quantity, balance_after,
                unit_cost, total_cost, reason, created_by, created_at
              ) VALUES (
                $1, $2, 'CONSUMO_EMPLEADO', $3, $4,
                $5, $6, $7, $8, NOW()
              )
              RETURNING id
            `, [
              currentItem.id,
              prod.id,
              -requiredQty,
              upd[0].stock,
              costUnit,
              costItemTotal,
              `Receta comida empleado ${emp.first_name} ${emp.last_name}: ${prod.title} (${currentItem.name} x${requiredQty})`,
              registeredBy
            ]);

            if (!primaryStockMovementId) primaryStockMovementId = mov[0].id;
          }

          calculatedTotalCost = Math.round(totalRecipeCost * 100) / 100;
          calculatedUnitCost = Math.round((calculatedTotalCost / numQty) * 100) / 100;
        } else {
          // CONTROL ESTRICTO: Si no tiene receta técnica, prohibir salida automática a menos que haya autorización expresa
          if (!allow_untracked_meal) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              status: 'error',
              code: 'RECIPE_REQUIRED',
              error: `El producto "${prod.title}" no cuenta con ingredientes configurados en Recetas (pedidos_app_product_recipes). Debe configurar su ficha técnica o registrar insumos directos. Para registrar únicamente el consumo financiero sin descuento físico de inventario, un directivo debe autorizar 'allow_untracked_meal: true'.`
            });
          }

          // VALIDACIÓN DE AUTORIZACIÓN DIRECTIVA EN BACKEND:
          // Solo roles con autorización directiva ('Super Administrador', 'Administrador', 'Gerente')
          // pueden autorizar el consumo de productos sin receta técnica.
          const isDirective = ['Super Administrador', 'Administrador', 'Gerente'].includes(req.user?.role);
          if (!isDirective) {
            await client.query('ROLLBACK');
            return res.status(403).json({
              status: 'error',
              code: 'FORBIDDEN_UNTRACKED_MEAL',
              error: 'Acceso denegado: Solo el personal con rol directivo o administrativo puede autorizar entregas sin receta técnica vinculada.'
            });
          }

          isUntracked = true;
          calculatedUnitCost = Math.round(Number(prod.price || 0) * 0.45);
          calculatedTotalCost = calculatedUnitCost * numQty;
        }
      }

      // Guardar registro de la entrega
      const { rows: mealRows } = await client.query(`
        INSERT INTO pedidos_app_employee_meals (
          employee_id, delivery_date, item_type, product_id, inventory_id,
          item_title, quantity, unit_cost, total_cost, stock_movement_id,
          is_untracked, idempotency_key, status, registered_by, notes
        ) VALUES (
          $1, $2::date, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, 'Entregado', $13, $14
        )
        RETURNING 
          id, employee_id, TO_CHAR(delivery_date, 'YYYY-MM-DD') AS delivery_date,
          item_type, product_id, inventory_id, item_title, quantity,
          unit_cost, total_cost, stock_movement_id, is_untracked,
          idempotency_key, status, registered_by, notes, created_at
      `, [
        emp.id,
        deliveryDateActual,
        item_type,
        product_id || null,
        inventory_id || null,
        itemTitle,
        numQty,
        calculatedUnitCost,
        calculatedTotalCost,
        primaryStockMovementId,
        isUntracked,
        idempotency_key || null,
        registeredBy,
        notes?.trim() || (isUntracked ? 'Entrega sin salida física (producto sin receta configurada)' : null)
      ]);

      // Marcar asistencia del día con had_meal = true
      await client.query(`
        INSERT INTO pedidos_app_employee_attendance (
          employee_id, attendance_date, shift_number, status, had_meal, registered_by, updated_at
        ) VALUES (
          $1, $2::date, 1, 'Trabajó', true, $3, NOW()
        )
        ON CONFLICT (employee_id, attendance_date, shift_number) DO UPDATE SET
          had_meal = true,
          updated_at = NOW()
      `, [emp.id, deliveryDateActual, registeredBy]);

      await client.query('COMMIT');
      await audit(req, 'Comida entregada', `Entregado ${itemTitle} x${numQty} a ${emp.first_name} ${emp.last_name}`);

      res.status(201).json({
        status: 'ok',
        meal: mealRows[0],
        message: isUntracked 
          ? `Entrega de "${itemTitle}" registrada (consumo financiero registrado, sin descuento físico de inventario).`
          : `Entrega de "${itemTitle}" registrada y stock descontado correctamente.`
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return handleServerError(res, err, 'Error interno al registrar el suministro/comida.');
    } finally {
      client.release();
    }
  });

  // Anular entrega de comida (restitución física selectiva)
  router.post('/meals/:id/cancel', authenticateToken, checkPerm('eliminar'), async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const { reason } = req.body;

      if (!reason?.trim()) {
        return res.status(400).json({ status: 'error', error: 'El motivo de anulación es obligatorio.' });
      }

      await client.query('BEGIN');

      const { rows: mealRows } = await client.query(
        'SELECT * FROM pedidos_app_employee_meals WHERE id = $1 FOR UPDATE',
        [id]
      );

      if (mealRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ status: 'error', error: 'Registro de entrega no encontrado.' });
      }

      const meal = mealRows[0];
      if (meal.status === 'Anulado') {
        await client.query('ROLLBACK');
        return res.status(400).json({ status: 'error', error: 'Esta entrega ya se encuentra anulada.' });
      }

      // INV-01: Prohibir anular comida si la fecha pertenece a un periodo de nómina Aprobado o Cerrado
      const { rows: coveredPeriods } = await client.query(`
        SELECT id, name, status, start_date, end_date
        FROM pedidos_app_payroll_periods
        WHERE $1::date BETWEEN start_date AND end_date
          AND status IN ('Aprobado', 'Cerrado')
        LIMIT 1
      `, [meal.delivery_date]);

      if (coveredPeriods.length > 0) {
        const cp = coveredPeriods[0];
        await client.query('ROLLBACK');
        return res.status(400).json({
          status: 'error',
          code: 'PERIOD_CLOSED_OR_APPROVED',
          error: `No es posible anular la entrega de comida porque pertenece al periodo "${cp.name}" que se encuentra en estado "${cp.status}".`
        });
      }

      const userCanceller = req.user?.username || 'Administrador';

      // Restituir inventario físico únicamente si hubo salidas efectivas de stock
      if (!meal.is_untracked) {
        if (meal.inventory_id) {
          const qtyToRestore = Number(meal.quantity || 1);
          const { rows: updInv } = await client.query(`
            UPDATE pedidos_app_inventory
            SET stock = COALESCE(stock, 0) + $1, updated_at = NOW()
            WHERE id = $2
            RETURNING stock
          `, [qtyToRestore, meal.inventory_id]);

          await client.query(`
            INSERT INTO pedidos_app_product_stock_movements (
              inventory_id, movement_type, quantity, balance_after,
              unit_cost, total_cost, reason, created_by, created_at
            ) VALUES (
              $1, 'CANCELACION', $2, $3,
              $4, $5, $6, $7, NOW()
            )
          `, [
            meal.inventory_id,
            qtyToRestore,
            updInv[0]?.stock || 0,
            meal.unit_cost,
            meal.total_cost,
            `Anulación de comida #${meal.id}: ${reason.trim()}`,
            userCanceller
          ]);
        } else if (meal.product_id) {
          const { rows: recipeItems } = await client.query(`
            SELECT pr.quantity AS recipe_quantity, inv.id AS inventory_id
            FROM pedidos_app_product_recipes pr
            JOIN pedidos_app_inventory inv ON inv.id = pr.inventory_id
            WHERE pr.product_id = $1 AND pr.is_controlled = true
          `, [meal.product_id]);

          for (const item of recipeItems) {
            const qtyToRestore = Number(item.recipe_quantity || 0) * Number(meal.quantity || 1);
            const { rows: updInv } = await client.query(`
              UPDATE pedidos_app_inventory
              SET stock = COALESCE(stock, 0) + $1, updated_at = NOW()
              WHERE id = $2
              RETURNING stock
            `, [qtyToRestore, item.inventory_id]);

            await client.query(`
              INSERT INTO pedidos_app_product_stock_movements (
                inventory_id, product_id, movement_type, quantity, balance_after,
                reason, created_by, created_at
              ) VALUES (
                $1, $2, 'CANCELACION', $3, $4,
                $5, $6, NOW()
              )
            `, [
              item.inventory_id,
              meal.product_id,
              qtyToRestore,
              updInv[0]?.stock || 0,
              `Anulación de receta comida #${meal.id}: ${reason.trim()}`,
              userCanceller
            ]);
          }
        }
      }

      // Marcar entrega como Anulada
      const { rows: updatedMeal } = await client.query(`
        UPDATE pedidos_app_employee_meals SET
          status = 'Anulado',
          cancel_reason = $1,
          annulled_at = NOW(),
          annulled_by = $2
        WHERE id = $3
        RETURNING *
      `, [reason.trim(), userCanceller, id]);

      await client.query('COMMIT');
      await audit(req, 'Comida anulada', `Entrega #${id} anulada. Motivo: ${reason}`);

      res.json({
        status: 'ok',
        meal: updatedMeal[0],
        message: 'Entrega anulada y movimientos compensados exitosamente.'
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return handleServerError(res, err, 'Error interno al anular la entrega de comida.');
    } finally {
      client.release();
    }
  });

  // ==========================================================================
  // 5. PERIODOS DE NÓMINA Y CÁLCULO (TOPES LEGALES Y CONSISTENCIA)
  // ==========================================================================

  // Listar periodos de nómina
  router.get('/periods', authenticateToken, checkPerm('ver'), async (req, res) => {
    try {
      const { status, limit = 24 } = req.query;
      let query = 'SELECT * FROM pedidos_app_payroll_periods WHERE 1=1';
      const params = [];

      if (status && status !== 'todos') {
        params.push(status);
        query += ` AND status = $${params.length}`;
      }

      query += ` ORDER BY start_date DESC LIMIT $${params.length + 1}`;
      params.push(Math.min(Number(limit) || 24, 100));

      const { rows } = await pool.query(query, params);
      res.json({ status: 'ok', periods: rows });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al consultar periodos de nómina.');
    }
  });

  // Crear nuevo periodo de nómina
  router.post('/periods', authenticateToken, checkPerm('crear'), async (req, res) => {
    try {
      const { name, period_type = 'quincenal', start_date, end_date, notes } = req.body;

      if (!start_date || !end_date) {
        return res.status(400).json({ status: 'error', error: 'Fecha de inicio y fin son obligatorias.' });
      }

      if (new Date(end_date) < new Date(start_date)) {
        return res.status(400).json({ status: 'error', error: 'La fecha de fin no puede ser anterior a la fecha de inicio.' });
      }

      // Prevención de solapamiento en backend
      const { rows: overlaps } = await pool.query(`
        SELECT id, name, start_date, end_date FROM pedidos_app_payroll_periods
        WHERE period_type = $1 AND status <> 'Anulado'
          AND start_date <= $2::date AND end_date >= $3::date
      `, [period_type, end_date, start_date]);

      if (overlaps.length > 0) {
        return res.status(400).json({
          status: 'error',
          error: `El periodo especificado (${start_date} al ${end_date}) se solapa con el periodo existente "${overlaps[0].name}" (${overlaps[0].start_date} al ${overlaps[0].end_date}).`
        });
      }

      let periodName = name;
      if (!periodName || !periodName.trim()) {
        const start = new Date(start_date + 'T12:00:00Z');
        const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
        const monthStr = monthNames[start.getMonth()];
        const yearStr = start.getFullYear();
        const startDay = start.getDate();

        if (period_type === 'quincenal') {
          periodName = `${startDay <= 15 ? '1ra' : '2da'} Quincena ${monthStr} ${yearStr}`;
        } else {
          periodName = `Mes de ${monthStr} ${yearStr}`;
        }
      }

      const activeCfg = await getActivePayrollConfig(start_date);

      const { rows } = await pool.query(`
        INSERT INTO pedidos_app_payroll_periods (
          name, period_type, start_date, end_date, status,
          config_year, applied_smmlv, applied_transport_monthly, applied_transport_daily,
          applied_health_pct, applied_pension_pct, notes
        ) VALUES (
          $1, $2, $3::date, $4::date, 'Borrador',
          $5, $6, $7, $8,
          $9, $10, $11
        )
        RETURNING *
      `, [
        periodName.trim(),
        period_type,
        start_date,
        end_date,
        activeCfg.year || 2026,
        activeCfg.smmlv_amount,
        activeCfg.transport_allowance_monthly,
        activeCfg.transport_allowance_daily,
        activeCfg.health_employee_pct,
        activeCfg.pension_employee_pct,
        notes?.trim() || null
      ]);

      await audit(req, 'Periodo de nómina creado', `Periodo ${periodName} creado`);
      res.status(201).json({ status: 'ok', period: rows[0], message: 'Periodo creado exitosamente en estado Borrador.' });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al crear periodo de nómina.');
    }
  });

  // Consultar detalle de un periodo con sus ítems por empleado
  router.get('/periods/:id', authenticateToken, checkPerm('ver'), async (req, res) => {
    try {
      const { id } = req.params;
      const { rows: periodRows } = await pool.query('SELECT * FROM pedidos_app_payroll_periods WHERE id = $1', [id]);
      if (periodRows.length === 0) {
        return res.status(404).json({ status: 'error', error: 'Periodo no encontrado.' });
      }

      const period = periodRows[0];

      const { rows: items } = await pool.query(`
        SELECT 
          i.*,
          e.first_name,
          e.last_name,
          e.document_type,
          e.document_number,
          e.position,
          e.contract_type,
          e.phone,
          e.email,
          e.payment_method,
          e.bank_name,
          e.bank_account_type,
          e.bank_account_number
        FROM pedidos_app_payroll_items i
        JOIN pedidos_app_employees e ON e.id = i.employee_id
        WHERE i.payroll_period_id = $1
        ORDER BY e.first_name ASC, e.last_name ASC
      `, [id]);

      res.json({ status: 'ok', period, items });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al consultar periodo.');
    }
  });

  // Calcular nómina con topes legales y congelamiento de parámetros
  router.post('/periods/:id/calculate', authenticateToken, checkPerm('calcular'), async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;

      const { rows: periodRows } = await client.query('SELECT * FROM pedidos_app_payroll_periods WHERE id = $1', [id]);
      if (periodRows.length === 0) {
        return res.status(404).json({ status: 'error', error: 'Periodo no encontrado.' });
      }

      const period = periodRows[0];
      if (period.status === 'Cerrado' || period.status === 'Aprobado') {
        return res.status(400).json({
          status: 'error',
          error: `No es posible recalcular un periodo de nómina en estado ${period.status}. Debe estar en Borrador o Calculado.`
        });
      }

      await client.query('BEGIN');

      const activeCfg = await getActivePayrollConfig(period.start_date);
      const appliedSmmlv = Number(period.applied_smmlv || activeCfg.smmlv_amount || 1750905);
      const healthPct = Number(period.applied_health_pct || activeCfg.health_employee_pct || 4);
      const pensionPct = Number(period.applied_pension_pct || activeCfg.pension_employee_pct || 4);
      const dailyTransport = Number(period.applied_transport_daily || activeCfg.transport_allowance_daily || 8303.17);

      const { rows: employees } = await client.query(`
        SELECT * FROM pedidos_app_employees
        WHERE (status = 'Activo' OR (discharge_date IS NOT NULL AND discharge_date >= $1::date))
          AND hire_date <= $2::date
        ORDER BY first_name ASC
      `, [period.start_date, period.end_date]);

      // Limpiar ítems obsoletos sin pagos de colaboradores que ya no aplican al periodo
      const eligibleEmpIds = employees.map(e => e.id);
      if (eligibleEmpIds.length > 0) {
        await client.query(`
          DELETE FROM pedidos_app_payroll_items
          WHERE payroll_period_id = $1 
            AND total_paid = 0 
            AND employee_id != ALL($2::uuid[])
        `, [period.id, eligibleEmpIds]);
      }

      let periodDaysWorked = 0;
      let periodBaseSalary = 0;
      let periodTransport = 0;
      let periodOvertime = 0;
      let periodBonuses = 0;
      let periodAccrued = 0;
      let periodLegalDeductions = 0;
      let periodAdvancesDeductions = 0;
      let periodOtherDeductions = 0;
      let periodTotalDeductions = 0;
      let periodNetPayable = 0;
      let periodInternalConsumption = 0;
      let periodMealsCount = 0;

      for (const emp of employees) {
        const { rows: attRows } = await client.query(`
          SELECT attendance_date, shift_number, status, hours_worked,
                 daily_value_applied, transport_allowance_applied, overtime_value_applied
          FROM pedidos_app_employee_attendance
          WHERE employee_id = $1 AND attendance_date BETWEEN $2::date AND $3::date
        `, [emp.id, period.start_date, period.end_date]);

        // Resumen por FECHA: turnos múltiples no duplican días, auxilio ni horas (ver nomina_calc.js)
        const att = summarizeAttendance(attRows);
        let daysWorked = att.daysWorked;
        const daysRest = att.daysRest;
        const daysLeavePaid = att.daysLeavePaid;
        const daysLeaveUnpaid = att.daysLeaveUnpaid;
        const daysSick = att.daysSick;
        const daysVacation = att.daysVacation;
        const daysHoliday = att.daysHoliday;
        const hoursWorked = att.hoursWorked;
        let baseSalaryEarned = att.baseSalaryEarned;
        let transportAllowanceEarned = att.transportAllowanceEarned;
        const overtimeAmount = att.overtimeAmount; // recargos y extras: concepto aparte del salario base

        const isLaborContract = emp.contract_type?.startsWith('Laboral');
        const isServices = emp.contract_type === 'Prestación de Servicios';
        const isLaborMonthly = isLaborContract && Number(emp.salary_base || 0) > 0;

        // Tope legal del Auxilio de Transporte en Colombia: Hasta dos (2) SMMLV mensuales.
        const fullSalaryBase = Number(emp.salary_base || 0) || (Number(emp.daily_rate || 0) * 30);
        const isEligibleForTransport = fullSalaryBase <= (2 * appliedSmmlv);

        if (isLaborMonthly) {
          // SALARIO MENSUAL FIJO: días comerciales (quincena = 15, mes = 30; Art. 134 CST), proporcional al
          // ingreso/retiro dentro del periodo; el permiso no remunerado se descuenta una sola vez.
          const monthly = calculateMonthlyPeriodPay({
            salaryBase: Number(emp.salary_base),
            periodStart: period.start_date,
            periodEnd: period.end_date,
            hireDate: emp.hire_date,
            dischargeDate: emp.discharge_date,
            unpaidLeaveDays: daysLeaveUnpaid,
            sickDays: daysSick,
            vacationDays: daysVacation,
            hasTransportAllowance: Boolean(emp.has_transport_allowance) && !isServices,
            eligibleForTransport: isEligibleForTransport,
            transportMonthly: Number(period.applied_transport_monthly || activeCfg.transport_allowance_monthly || 249095)
          });
          daysWorked = monthly.paidDays;
          baseSalaryEarned = monthly.baseSalaryEarned;
          transportAllowanceEarned = monthly.transportAllowanceEarned;
        } else {
          // JORNAL / TURNO / PRESTACIÓN DE SERVICIOS:
          // Solo se pagan los turnos trabajados o permisos remunerados (los descansos no se remuneran para pago por día)
          let earnedFromShifts = 0;
          for (const r of attRows) {
            if (['Trabajó', 'Media jornada', 'Permiso remunerado'].includes(r.status)) {
              earnedFromShifts += Number(r.daily_value_applied) || 0;
            }
          }
          baseSalaryEarned = round2(earnedFromShifts);
          if (!isEligibleForTransport || isServices) {
            transportAllowanceEarned = 0;
          }
        }

        let bonusesEarned = 0;
        if (Array.isArray(emp.additional_benefits)) {
          emp.additional_benefits.forEach(b => {
            if (b.amount && b.active !== false) {
              bonusesEarned += Number(b.amount);
            }
          });
        }

        const totalAccrued = baseSalaryEarned + transportAllowanceEarned + overtimeAmount + bonusesEarned;

        // Deducciones de ley (Base de cotización IBC excluye auxilio de transporte)
        let healthDeduction = 0;
        let pensionDeduction = 0;

        if (emp.deduce_health && baseSalaryEarned > 0 && !isServices) {
          const empHealthPct = emp.health_percentage !== null ? Number(emp.health_percentage) : healthPct;
          healthDeduction = Math.round((baseSalaryEarned + overtimeAmount) * (empHealthPct / 100));
        }

        if (emp.deduce_pension && baseSalaryEarned > 0 && !isServices) {
          const empPensionPct = emp.pension_percentage !== null ? Number(emp.pension_percentage) : pensionPct;
          pensionDeduction = Math.round((baseSalaryEarned + overtimeAmount) * (empPensionPct / 100));
        }

        let advancesDeduction = 0;
        const { rows: pendDeductions } = await client.query(`
          SELECT id, balance_remaining, installment_amount, type
          FROM pedidos_app_employee_deductions
          WHERE employee_id = $1 AND status IN ('Pendiente', 'Parcial') AND balance_remaining > 0
          ORDER BY request_date ASC
        `, [emp.id]);

        pendDeductions.forEach(d => {
          const installment = Number(d.installment_amount) > 0 ? Number(d.installment_amount) : Number(d.balance_remaining);
          const toDeduct = Math.min(installment, Number(d.balance_remaining));
          advancesDeduction += toDeduct;
        });

        const otherDeductions = 0;
        const totalDeductions = healthDeduction + pensionDeduction + advancesDeduction + otherDeductions;
        const netPayable = Math.max(0, totalAccrued - totalDeductions);

        const { rows: mealStats } = await client.query(`
          SELECT COUNT(*) AS count, COALESCE(SUM(total_cost), 0) AS total_cost
          FROM pedidos_app_employee_meals
          WHERE employee_id = $1 AND status = 'Entregado' AND delivery_date BETWEEN $2::date AND $3::date
        `, [emp.id, period.start_date, period.end_date]);

        const mealsCount = Number(mealStats[0].count || 0);
        const internalConsumptionCost = Number(mealStats[0].total_cost || 0);

        await client.query(`
          INSERT INTO pedidos_app_payroll_items (
            payroll_period_id, employee_id, days_worked, days_rest,
            days_leave_paid, days_leave_unpaid, days_sick, days_vacation, days_holiday,
            hours_worked, daily_rate, base_salary_earned, transport_allowance_earned,
            overtime_amount, bonuses_earned, total_accrued,
            health_deduction, pension_deduction, advances_deduction, other_deductions,
            total_deductions, net_payable, internal_consumption_cost, meals_count,
            payment_status, total_paid, pending_balance, updated_at
          ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8, $9,
            $10, $11, $12, $13,
            $14, $15, $16,
            $17, $18, $19, $20,
            $21, $22, $23, $24,
            'Pendiente', 0, $22, NOW()
          )
          ON CONFLICT (payroll_period_id, employee_id) DO UPDATE SET
            days_worked = EXCLUDED.days_worked,
            days_rest = EXCLUDED.days_rest,
            days_leave_paid = EXCLUDED.days_leave_paid,
            days_leave_unpaid = EXCLUDED.days_leave_unpaid,
            days_sick = EXCLUDED.days_sick,
            days_vacation = EXCLUDED.days_vacation,
            days_holiday = EXCLUDED.days_holiday,
            hours_worked = EXCLUDED.hours_worked,
            daily_rate = EXCLUDED.daily_rate,
            base_salary_earned = EXCLUDED.base_salary_earned,
            transport_allowance_earned = EXCLUDED.transport_allowance_earned,
            overtime_amount = EXCLUDED.overtime_amount,
            bonuses_earned = EXCLUDED.bonuses_earned,
            total_accrued = EXCLUDED.total_accrued,
            health_deduction = EXCLUDED.health_deduction,
            pension_deduction = EXCLUDED.pension_deduction,
            advances_deduction = EXCLUDED.advances_deduction,
            other_deductions = EXCLUDED.other_deductions,
            total_deductions = EXCLUDED.total_deductions,
            net_payable = EXCLUDED.net_payable,
            internal_consumption_cost = EXCLUDED.internal_consumption_cost,
            meals_count = EXCLUDED.meals_count,
            pending_balance = EXCLUDED.net_payable - pedidos_app_payroll_items.total_paid,
            updated_at = NOW()
        `, [
          period.id, emp.id, daysWorked, daysRest,
          daysLeavePaid, daysLeaveUnpaid, daysSick, daysVacation, daysHoliday,
          hoursWorked, Number(emp.daily_rate) || 0, baseSalaryEarned, transportAllowanceEarned,
          overtimeAmount, bonusesEarned, totalAccrued,
          healthDeduction, pensionDeduction, advancesDeduction, otherDeductions,
          totalDeductions, netPayable, internalConsumptionCost, mealsCount
        ]);

        periodDaysWorked += daysWorked;
        periodBaseSalary += baseSalaryEarned;
        periodTransport += transportAllowanceEarned;
        periodOvertime += overtimeAmount;
        periodBonuses += bonusesEarned;
        periodAccrued += totalAccrued;
        periodLegalDeductions += (healthDeduction + pensionDeduction);
        periodAdvancesDeductions += advancesDeduction;
        periodOtherDeductions += otherDeductions;
        periodTotalDeductions += totalDeductions;
        periodNetPayable += netPayable;
        periodInternalConsumption += internalConsumptionCost;
        periodMealsCount += mealsCount;
      }

      const { rows: updatedPeriod } = await client.query(`
        UPDATE pedidos_app_payroll_periods SET
          status = 'Calculado',
          config_year = $1,
          applied_smmlv = $2,
          applied_transport_monthly = $3,
          applied_transport_daily = $4,
          applied_health_pct = $5,
          applied_pension_pct = $6,
          employees_count = $7,
          total_days_worked = $8,
          total_base_salary = $9,
          total_transport_allowance = $10,
          total_overtime = $11,
          total_bonuses = $12,
          total_accrued = $13,
          total_legal_deductions = $14,
          total_advances_deductions = $15,
          total_other_deductions = $16,
          total_deductions = $17,
          total_net_payable = $18,
          total_internal_consumption = $19,
          total_meals_count = $20,
          calculated_at = NOW(),
          updated_at = NOW()
        WHERE id = $21
        RETURNING *
      `, [
        activeCfg.year || 2026,
        appliedSmmlv,
        activeCfg.transport_allowance_monthly,
        dailyTransport,
        healthPct,
        pensionPct,
        employees.length,
        Math.round(periodDaysWorked * 100) / 100,
        periodBaseSalary,
        periodTransport,
        periodOvertime,
        periodBonuses,
        periodAccrued,
        periodLegalDeductions,
        periodAdvancesDeductions,
        periodOtherDeductions,
        periodTotalDeductions,
        periodNetPayable,
        periodInternalConsumption,
        periodMealsCount,
        period.id
      ]);

      await client.query('COMMIT');
      await audit(req, 'Nómina calculada', `Periodo #${period.id} calculado (${employees.length} empleados, neto: $${periodNetPayable})`);

      res.json({
        status: 'ok',
        period: updatedPeriod[0],
        message: `Nómina calculada exitosamente para ${employees.length} empleados.`
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return handleServerError(res, err, 'Error interno al calcular nómina.');
    } finally {
      client.release();
    }
  });

  // Cambiar estado del periodo (Aprobar / Cerrar / Anular) con validación de transiciones, bloqueos y saldos (SEC-01)
  router.patch('/periods/:id/status', authenticateToken, checkPerm('editar'), async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (!['Borrador', 'Calculado', 'Aprobado', 'Cerrado', 'Anulado'].includes(status)) {
        return res.status(400).json({ status: 'error', error: 'Estado de periodo inválido.' });
      }

      await client.query('BEGIN');

      // 1. Bloquear el periodo con FOR UPDATE para serializar contra pagos, cálculos o cambios de estado concurrentes
      const { rows: currentPeriodRows } = await client.query(
        'SELECT * FROM pedidos_app_payroll_periods WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (currentPeriodRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ status: 'error', error: 'Periodo no encontrado' });
      }

      const currentPeriod = currentPeriodRows[0];

      // Validar transición a Aprobado: requiere haber sido calculado
      if (status === 'Aprobado') {
        const { rows: itemCheck } = await client.query(
          'SELECT COUNT(*) AS count FROM pedidos_app_payroll_items WHERE payroll_period_id = $1',
          [id]
        );
        if (Number(itemCheck[0]?.count || 0) === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            status: 'error',
            error: 'No se puede aprobar un periodo que no ha sido calculado o que no tiene colaboradores liquidados.'
          });
        }
      }

      // Validar transición a Cerrado: no debe tener saldos pendientes
      if (status === 'Cerrado') {
        if (currentPeriod.status !== 'Aprobado') {
          await client.query('ROLLBACK');
          return res.status(400).json({
            status: 'error',
            error: `Solo es posible cerrar un periodo que se encuentre en estado "Aprobado" (estado actual: "${currentPeriod.status}").`
          });
        }

        // Bloquear los ítems con FOR UPDATE para serializar contra pagos o anulaciones en curso
        const { rows: pendCheck } = await client.query(`
          WITH locked_items AS (
            SELECT pending_balance
            FROM pedidos_app_payroll_items
            WHERE payroll_period_id = $1
            FOR UPDATE
          )
          SELECT 
            COUNT(*) FILTER (WHERE pending_balance > 0.005) AS pend_count,
            COALESCE(SUM(pending_balance) FILTER (WHERE pending_balance > 0.005), 0) AS pend_total
          FROM locked_items
        `, [id]);

        const pendCount = Number(pendCheck[0]?.pend_count || 0);
        const pendTotal = Number(pendCheck[0]?.pend_total || 0);

        if (pendCount > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            status: 'error',
            error: `No es posible cerrar el periodo porque aún existen saldos pendientes de pago por $${pendTotal.toLocaleString('es-CO')} (${pendCount} colaboradores pendientes).`
          });
        }
      }

      // Validar transición a Anulado: no debe tener pagos registrados activos
      if (status === 'Anulado') {
        const { rows: payCheck } = await client.query(`
          SELECT COUNT(*) AS count FROM pedidos_app_payroll_payments p
          JOIN pedidos_app_payroll_items it ON it.id = p.payroll_item_id
          WHERE it.payroll_period_id = $1 AND p.status = 'Pagado'
        `, [id]);
        if (Number(payCheck[0]?.count || 0) > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            status: 'error',
            error: 'No es posible anular un periodo con pagos registrados. Anule primero los pagos.'
          });
        }
      }

      // Validar reapertura a Calculado o Borrador: no debe tener pagos registrados activos
      if (['Borrador', 'Calculado'].includes(status) && ['Aprobado', 'Cerrado'].includes(currentPeriod.status)) {
        const { rows: payCheck } = await client.query(`
          SELECT COUNT(*) AS count FROM pedidos_app_payroll_payments p
          JOIN pedidos_app_payroll_items it ON it.id = p.payroll_item_id
          WHERE it.payroll_period_id = $1 AND p.status = 'Pagado'
        `, [id]);
        if (Number(payCheck[0]?.count || 0) > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            status: 'error',
            error: 'No es posible reabrir un periodo con pagos registrados. Anule primero los pagos.'
          });
        }
      }

      // Si se pasa a Cerrado, amortizar deducciones descontadas en este periodo
      if (status === 'Cerrado' && currentPeriod.status !== 'Cerrado') {
        const { rows: appliedItems } = await client.query(`
          SELECT id, employee_id, advances_deduction
          FROM pedidos_app_payroll_items
          WHERE payroll_period_id = $1 AND advances_deduction > 0
        `, [id]);

        for (const item of appliedItems) {
          let remToAmortize = Number(item.advances_deduction);
          if (remToAmortize <= 0) continue;

          const { rows: empDeductions } = await client.query(`
            SELECT id, amount, balance_remaining, installment_amount, installments_total, installments_paid
            FROM pedidos_app_employee_deductions
            WHERE employee_id = $1 AND status IN ('Pendiente', 'Parcial') AND balance_remaining > 0
            ORDER BY request_date ASC, id ASC
            FOR UPDATE
          `, [item.employee_id]);

          for (const ded of empDeductions) {
            if (remToAmortize <= 0) break;
            const instAmount = Number(ded.installment_amount) > 0 ? Number(ded.installment_amount) : Number(ded.balance_remaining);
            const apply = Math.min(remToAmortize, Number(ded.balance_remaining), instAmount);
            if (apply <= 0) continue;

            const newBalance = Math.max(0, Number(ded.balance_remaining) - apply);
            const newStatus = newBalance <= 0.005 ? 'Pagado' : 'Parcial';
            const newInstallmentsPaid = Number(ded.installments_paid || 0) + 1;

            await client.query(`
              UPDATE pedidos_app_employee_deductions SET
                balance_remaining = $1,
                status = $2,
                installments_paid = $3,
                updated_at = NOW()
              WHERE id = $4
            `, [newBalance, newStatus, newInstallmentsPaid, ded.id]);

            await client.query(`
              INSERT INTO pedidos_app_payroll_deduction_amortizations (
                payroll_period_id, payroll_item_id, deduction_id, amount_deducted
              ) VALUES ($1, $2, $3, $4)
            `, [id, item.id, ded.id, apply]);

            remToAmortize -= apply;
          }
        }
      }

      // Si el periodo estaba Cerrado y se reabre a Borrador o Calculado, revertir amortizaciones
      if (currentPeriod.status === 'Cerrado' && status !== 'Cerrado') {
        const { rows: amortizations } = await client.query(`
          SELECT id, deduction_id, amount_deducted
          FROM pedidos_app_payroll_deduction_amortizations
          WHERE payroll_period_id = $1
        `, [id]);

        for (const am of amortizations) {
          await client.query(`
            UPDATE pedidos_app_employee_deductions SET
              balance_remaining = balance_remaining + $1,
              installments_paid = GREATEST(0, installments_paid - 1),
              status = CASE 
                WHEN (balance_remaining + $1) >= amount THEN 'Pendiente'
                ELSE 'Parcial'
              END,
              updated_at = NOW()
            WHERE id = $2
          `, [Number(am.amount_deducted), am.deduction_id]);
        }

        await client.query(`
          DELETE FROM pedidos_app_payroll_deduction_amortizations
          WHERE payroll_period_id = $1
        `, [id]);
      }

      const userName = req.user?.username || 'Administrador';

      const { rows } = await client.query(`
        UPDATE pedidos_app_payroll_periods SET
          status = $1::varchar,
          approved_at = CASE 
            WHEN $1::varchar = 'Aprobado' THEN NOW() 
            WHEN $1::varchar IN ('Borrador', 'Calculado') THEN NULL 
            ELSE approved_at 
          END,
          approved_by = CASE 
            WHEN $1::varchar = 'Aprobado' THEN $2::varchar 
            WHEN $1::varchar IN ('Borrador', 'Calculado') THEN NULL 
            ELSE approved_by 
          END,
          closed_at = CASE 
            WHEN $1::varchar = 'Cerrado' THEN NOW() 
            WHEN $1::varchar != 'Cerrado' THEN NULL 
            ELSE closed_at 
          END,
          closed_by = CASE 
            WHEN $1::varchar = 'Cerrado' THEN $2::varchar 
            WHEN $1::varchar != 'Cerrado' THEN NULL 
            ELSE closed_by 
          END,
          updated_at = NOW()
        WHERE id = $3
        RETURNING *
      `, [status, userName, id]);

      await client.query('COMMIT');
      await audit(req, 'Estado periodo nómina', `Periodo #${id} cambió de ${currentPeriod.status} a ${status}`);
      res.json({ status: 'ok', period: rows[0], message: `Periodo actualizado a ${status}.` });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      handleServerError(res, err, 'Error interno al actualizar el estado del periodo.');
    } finally {
      client.release();
    }
  });

  // ==========================================================================
  // 6. PAGOS Y COMPROBANTES DE NÓMINA
  // ==========================================================================

  // Listar pagos registrados
  router.get('/payments', authenticateToken, checkPerm('ver'), async (req, res) => {
    try {
      const { period_id, employee_id, date_from, date_to } = req.query;

      let query = `
        SELECT 
          p.*,
          e.first_name,
          e.last_name,
          e.document_number,
          e.position,
          per.name AS period_name
        FROM pedidos_app_payroll_payments p
        JOIN pedidos_app_employees e ON e.id = p.employee_id
        JOIN pedidos_app_payroll_items it ON it.id = p.payroll_item_id
        JOIN pedidos_app_payroll_periods per ON per.id = it.payroll_period_id
        WHERE 1=1
      `;
      const params = [];

      if (period_id) {
        params.push(period_id);
        query += ` AND it.payroll_period_id = $${params.length}`;
      }
      if (employee_id) {
        params.push(employee_id);
        query += ` AND p.employee_id = $${params.length}`;
      }
      if (date_from) {
        params.push(date_from);
        query += ` AND p.payment_date >= $${params.length}::date`;
      }
      if (date_to) {
        params.push(date_to);
        query += ` AND p.payment_date <= $${params.length}::date`;
      }

      query += ` ORDER BY p.payment_date DESC, p.created_at DESC`;

      const { rows } = await pool.query(query, params);
      res.json({ status: 'ok', payments: rows });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al listar los pagos de nómina.');
    }
  });

  // Registrar un pago de nómina con idempotencia transaccional.
  //  - idempotency_key OBLIGATORIA (body o cabecera X-Idempotency-Key): una clave = una operación.
  //  - Se serializa por clave con pg_advisory_xact_lock ANTES de consultar; la restricción UNIQUE de la
  //    base de datos y ON CONFLICT DO NOTHING actúan como respaldo sin dejar la transacción abortada.
  //  - Misma clave + mismos datos => se devuelve el pago original (200). Datos distintos => 409.
  router.post('/payments', authenticateToken, checkPerm('pagar'), async (req, res) => {
    const client = await pool.connect();
    try {
      const {
        payroll_item_id,
        amount_paid,
        payment_date,
        payment_method = 'Transferencia',
        voucher_reference,
        idempotency_key: bodyIdempKey,
        receipt_url,
        notes
      } = req.body || {};

      const rawKey = bodyIdempKey || req.headers['x-idempotency-key'] || '';
      const idempotencyKey = typeof rawKey === 'string' ? rawKey.trim() : '';
      if (idempotencyKey.length < 8 || idempotencyKey.length > 120) {
        return res.status(400).json({
          status: 'error',
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          error: 'Se requiere idempotency_key (8 a 120 caracteres, única por operación de pago).'
        });
      }

      const numAmount = Number(amount_paid);
      const itemId = Number(payroll_item_id);
      if (!Number.isInteger(itemId) || itemId <= 0 || !Number.isFinite(numAmount) || numAmount <= 0) {
        return res.status(400).json({ status: 'error', error: 'Ítem de nómina y monto válido son obligatorios.' });
      }
      const requestData = {
        payroll_item_id: itemId,
        amount_paid: numAmount,
        payment_method,
        payment_date: payment_date || null
      };

      const replayOrConflict = async (existing) => {
        await client.query('ROLLBACK');
        const check = evaluatePaymentIdempotency(existing, requestData);
        if (!check.compatible) {
          return res.status(409).json({
            status: 'error',
            code: 'IDEMPOTENCY_KEY_REUSED',
            error: 'La idempotency_key ya se usó en una operación distinta. Genere una clave nueva para un pago diferente.',
            mismatched_fields: check.reasons
          });
        }
        return res.status(200).json({
          status: 'ok',
          payment: existing,
          is_duplicate: true,
          message: 'Pago ya registrado con esta clave; se devuelve el original.'
        });
      };

      await client.query('BEGIN');

      // 1) Serializar solicitudes con la MISMA clave antes de consultar (namespace 41 = nómina)
      await client.query('SELECT pg_advisory_xact_lock(41, hashtext($1))', [idempotencyKey]);

      const { rows: existingRows } = await client.query(
        'SELECT * FROM pedidos_app_payroll_payments WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      if (existingRows.length > 0) {
        return await replayOrConflict(existingRows[0]);
      }

      // 2) Bloquear el ítem y validar el saldo pendiente real (neto - pagado)
      // 2) Bloquear el ítem y su periodo padre con FOR UPDATE para serializar contra cierre o cambios de estado
      const { rows: itemRows } = await client.query(`
        SELECT it.*, p.status AS period_status, p.name AS period_name
        FROM pedidos_app_payroll_items it
        JOIN pedidos_app_payroll_periods p ON p.id = it.payroll_period_id
        WHERE it.id = $1
        FOR UPDATE OF it, p
      `, [itemId]);
      if (itemRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ status: 'error', error: 'Ítem de nómina no encontrado.' });
      }

      const item = itemRows[0];
      if (item.period_status !== 'Aprobado') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          status: 'error',
          code: 'PERIOD_NOT_APPROVED',
          error: `No es posible registrar pagos en el periodo "${item.period_name || item.payroll_period_id}" porque su estado actual es "${item.period_status}". Debe estar en estado "Aprobado".`
        });
      }

      const netPayable = Number(item.net_payable || 0);
      const pendingBalance = round2(netPayable - Number(item.total_paid || 0));

      if (pendingBalance <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ status: 'error', error: 'La liquidación de este ítem ya está pagada en su totalidad.' });
      }
      if (numAmount > pendingBalance + 0.005) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          status: 'error',
          error: `El monto a pagar ($${numAmount}) supera el saldo pendiente de liquidación ($${pendingBalance}).`
        });
      }

      const newTotalPaid = round2(Number(item.total_paid || 0) + numAmount);
      const newPendingBalance = Math.max(0, round2(netPayable - newTotalPaid));
      const newStatus = newPendingBalance <= 0 ? 'Pagado' : 'Parcial';
      const paidBy = req.user?.username || 'Administrador';

      // 3) Insertar con respaldo de unicidad: un conflicto NO aborta la transacción
      const { rows: payRows } = await client.query(`
        INSERT INTO pedidos_app_payroll_payments (
          payroll_item_id, employee_id, payment_date, amount_paid,
          payment_method, voucher_reference, receipt_url, idempotency_key, status, paid_by, notes
        ) VALUES (
          $1, $2, COALESCE($3::date, CURRENT_DATE), $4,
          $5, $6, $7, $8, 'Pagado', $9, $10
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *
      `, [
        itemId,
        item.employee_id,
        payment_date || null,
        numAmount,
        payment_method,
        voucher_reference?.trim() || null,
        receipt_url?.trim() || null,
        idempotencyKey,
        paidBy,
        notes?.trim() || null
      ]);

      if (payRows.length === 0) {
        const { rows: raced } = await client.query(
          'SELECT * FROM pedidos_app_payroll_payments WHERE idempotency_key = $1',
          [idempotencyKey]
        );
        if (raced.length > 0) return await replayOrConflict(raced[0]);
        throw new Error('Conflicto de idempotencia sin pago existente.');
      }

      await client.query(`
        UPDATE pedidos_app_payroll_items SET
          total_paid = $1,
          pending_balance = $2,
          payment_status = $3,
          updated_at = NOW()
        WHERE id = $4
      `, [newTotalPaid, newPendingBalance, newStatus, itemId]);

      await client.query('COMMIT');
      await audit(req, 'Pago nómina registrado', `Pago de $${numAmount} a empleado #${item.employee_id}`);

      res.status(201).json({
        status: 'ok',
        payment: payRows[0],
        is_duplicate: false,
        newPaymentStatus: newStatus,
        pendingBalance: newPendingBalance,
        message: 'Pago de nómina registrado exitosamente.'
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return handleServerError(res, err, 'Error interno al registrar el pago de nómina.');
    } finally {
      client.release();
    }
  });

  // Anular comprobante de pago y revertir saldos (AUD-01)
  router.post('/payments/:id/cancel', authenticateToken, checkPerm('eliminar'), async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const { reason } = req.body;

      if (!reason?.trim()) {
        return res.status(400).json({ status: 'error', error: 'El motivo de anulación es obligatorio.' });
      }

      await client.query('BEGIN');

      // 1. Consultar el pago y su relación con el ítem y periodo padre
      const { rows: payInfo } = await client.query(`
        SELECT p.id, p.status, p.amount_paid, p.payroll_item_id, it.payroll_period_id
        FROM pedidos_app_payroll_payments p
        JOIN pedidos_app_payroll_items it ON it.id = p.payroll_item_id
        WHERE p.id = $1
      `, [id]);

      if (payInfo.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ status: 'error', error: 'Pago no encontrado.' });
      }

      const payment = payInfo[0];
      if (payment.status === 'Anulado') {
        await client.query('ROLLBACK');
        return res.status(400).json({ status: 'error', error: 'Este pago ya se encuentra anulado.' });
      }

      // 2. Bloquear primero el periodo padre en orden jerárquico (per -> it -> pay) para serializar
      // de forma determinista contra PATCH /periods/:id/status y evitar deadlocks o condiciones de carrera
      const { rows: perRows } = await client.query(
        'SELECT id, name, status FROM pedidos_app_payroll_periods WHERE id = $1 FOR UPDATE',
        [payment.payroll_period_id]
      );

      if (perRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ status: 'error', error: 'Periodo de nómina no encontrado.' });
      }

      const period = perRows[0];
      if (period.status === 'Cerrado') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          status: 'error',
          code: 'PERIOD_ALREADY_CLOSED',
          error: `No es posible anular el pago porque el periodo "${period.name || period.id}" ya se encuentra en estado "Cerrado".`
        });
      }

      // 3. Bloquear el ítem de nómina
      const { rows: itemRows } = await client.query(
        'SELECT * FROM pedidos_app_payroll_items WHERE id = $1 FOR UPDATE',
        [payment.payroll_item_id]
      );

      // 4. Bloquear el pago específico
      const { rows: payRows } = await client.query(
        'SELECT * FROM pedidos_app_payroll_payments WHERE id = $1 FOR UPDATE',
        [id]
      );

      if (payRows.length === 0 || payRows[0].status === 'Anulado') {
        await client.query('ROLLBACK');
        return res.status(400).json({ status: 'error', error: 'Este pago ya se encuentra anulado o no es válido.' });
      }

      const userCanceller = req.user?.username || 'Administrador';

      const { rows: updatedPay } = await client.query(`
        UPDATE pedidos_app_payroll_payments SET
          status = 'Anulado',
          annulled_at = NOW(),
          annulled_by = $1,
          annul_reason = $2
        WHERE id = $3
        RETURNING *
      `, [userCanceller, reason.trim(), id]);

      if (itemRows.length > 0) {
        const item = itemRows[0];
        const newTotalPaid = Math.max(0, Number(item.total_paid || 0) - Number(payment.amount_paid));
        const netPayable = Number(item.net_payable || 0);
        const newPendingBalance = Math.max(0, netPayable - newTotalPaid);
        const newStatus = newTotalPaid <= 0 ? 'Pendiente' : (newPendingBalance <= 0 ? 'Pagado' : 'Parcial');

        await client.query(`
          UPDATE pedidos_app_payroll_items SET
            total_paid = $1,
            pending_balance = $2,
            payment_status = $3,
            updated_at = NOW()
          WHERE id = $4
        `, [newTotalPaid, newPendingBalance, newStatus, item.id]);
      }

      await client.query('COMMIT');
      await audit(req, 'Pago nómina anulado', `Pago #${id} por $${payment.amount_paid} anulado`);

      res.json({
        status: 'ok',
        payment: updatedPay[0],
        message: 'Pago anulado y saldo de liquidación recalculado exitosamente.'
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return handleServerError(res, err, 'Error interno al anular el pago de nómina.');
    } finally {
      client.release();
    }
  });

  // Datos para comprobante imprimible de pago de nómina
  router.get('/receipt/:payrollItemId', authenticateToken, checkPerm('ver'), async (req, res) => {
    try {
      const { payrollItemId } = req.params;

      const { rows } = await pool.query(`
        SELECT 
          i.*,
          e.first_name,
          e.last_name,
          e.document_type,
          e.document_number,
          e.position,
          e.contract_type,
          e.phone,
          e.email,
          e.payment_method,
          e.bank_name,
          e.bank_account_type,
          e.bank_account_number,
          p.name AS period_name,
          p.start_date AS period_start_date,
          p.end_date AS period_end_date,
          COALESCE(
            (SELECT json_agg(pay.*) FROM pedidos_app_payroll_payments pay WHERE pay.payroll_item_id = i.id AND pay.status = 'Pagado'),
            '[]'::json
          ) AS payments_list
        FROM pedidos_app_payroll_items i
        JOIN pedidos_app_employees e ON e.id = i.employee_id
        JOIN pedidos_app_payroll_periods p ON p.id = i.payroll_period_id
        WHERE i.id = $1
      `, [payrollItemId]);

      if (rows.length === 0) {
        return res.status(404).json({ status: 'error', error: 'Comprobante no encontrado.' });
      }

      res.json({ status: 'ok', receipt: rows[0] });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al generar el comprobante de pago.');
    }
  });

  // ==========================================================================
  // 7. ANTICIPOS, PRÉSTAMOS Y DESCUENTOS
  // ==========================================================================

  // Listar anticipos y deducciones
  router.get('/deductions', authenticateToken, checkPerm('ver'), async (req, res) => {
    try {
      const { employee_id, status } = req.query;
      let query = `
        SELECT 
          d.*,
          e.first_name,
          e.last_name,
          e.document_number,
          e.position
        FROM pedidos_app_employee_deductions d
        JOIN pedidos_app_employees e ON e.id = d.employee_id
        WHERE 1=1
      `;
      const params = [];

      if (employee_id) {
        params.push(employee_id);
        query += ` AND d.employee_id = $${params.length}`;
      }
      if (status && status !== 'todos') {
        params.push(status);
        query += ` AND d.status = $${params.length}`;
      }

      query += ` ORDER BY d.request_date DESC, d.created_at DESC`;

      const { rows } = await pool.query(query, params);
      res.json({ status: 'ok', deductions: rows });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al listar deducciones.');
    }
  });

  // Crear anticipo / préstamo
  router.post('/deductions', authenticateToken, checkPerm('crear'), async (req, res) => {
    try {
      const {
        employee_id,
        type = 'Anticipo',
        amount,
        request_date,
        reason,
        installments_total = 1,
        installment_amount,
        voucher_url
      } = req.body;

      const numAmount = Number(amount);
      if (!employee_id || isNaN(numAmount) || numAmount <= 0 || !reason?.trim()) {
        return res.status(400).json({ status: 'error', error: 'Empleado, monto positivo y motivo son obligatorios.' });
      }

      const totalInst = Math.max(1, Number(installments_total) || 1);
      const instAmount = Number(installment_amount) > 0 ? Number(installment_amount) : Math.round(numAmount / totalInst);
      const registeredBy = req.user?.username || 'Administrador';

      const { rows } = await pool.query(`
        INSERT INTO pedidos_app_employee_deductions (
          employee_id, type, amount, balance_remaining, request_date,
          reason, installments_total, installments_paid, installment_amount,
          voucher_url, status, registered_by
        ) VALUES (
          $1, $2, $3, $3, COALESCE($4::date, CURRENT_DATE),
          $5, $6, 0, $7,
          $8, 'Pendiente', $9
        )
        RETURNING *
      `, [
        employee_id,
        type,
        numAmount,
        request_date || null,
        reason.trim(),
        totalInst,
        instAmount,
        voucher_url?.trim() || null,
        registeredBy
      ]);

      await audit(req, 'Anticipo registrado', `${type} de $${numAmount} registrado`);
      res.status(201).json({ status: 'ok', deduction: rows[0], message: `${type} registrado exitosamente.` });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al registrar deducción.');
    }
  });

  // ==========================================================================
  // 8. LIQUIDACIONES DE RETIRO
  // ==========================================================================

  // Listar liquidaciones de retiro
  router.get('/settlements', authenticateToken, checkPerm('ver'), async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT 
          s.*,
          e.first_name,
          e.last_name,
          e.document_number,
          e.position,
          e.contract_type
        FROM pedidos_app_employee_settlements s
        JOIN pedidos_app_employees e ON e.id = s.employee_id
        ORDER BY s.discharge_date DESC, s.created_at DESC
      `);
      res.json({ status: 'ok', settlements: rows });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al listar liquidaciones.');
    }
  });

  // Registros de soporte de prestaciones (consignaciones, pagos, saldos pendientes y vacaciones).
  // Son la ÚNICA fuente con la que el estimador puede dar por cubierto o pendiente un periodo anterior.
  const BENEFIT_STATUS_BY_TYPE = {
    CESANTIAS: ['Consignado', 'Pagado', 'Pendiente'],
    INTERESES_CESANTIAS: ['Pagado', 'Pendiente'],
    PRIMA: ['Pagado', 'Pendiente'],
    VACACIONES: ['Disfrutado', 'Compensado']
  };

  const loadBenefitRecords = async (employeeId) => {
    const { rows } = await pool.query(
      'SELECT * FROM pedidos_app_employee_benefit_records WHERE employee_id = $1 AND voided_at IS NULL ORDER BY period_year, period_semester NULLS FIRST, id',
      [employeeId]
    );
    return rows;
  };

  router.get('/benefit-records', authenticateToken, checkPerm('ver'), async (req, res) => {
    try {
      const { employee_id } = req.query;
      if (!employee_id) {
        return res.status(400).json({ status: 'error', error: 'employee_id es obligatorio.' });
      }
      const { rows } = await pool.query(
        'SELECT * FROM pedidos_app_employee_benefit_records WHERE employee_id = $1 ORDER BY period_year DESC, period_semester DESC NULLS LAST, id DESC',
        [employee_id]
      );
      res.json({ status: 'ok', records: rows });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al listar registros de prestaciones.');
    }
  });

  router.post('/benefit-records', authenticateToken, checkPerm('editar'), async (req, res) => {
    try {
      const { employee_id, benefit_type, period_year, period_semester, status, amount, days, evidence_reference, notes } = req.body || {};
      const allowed = BENEFIT_STATUS_BY_TYPE[benefit_type];
      const year = Number(period_year);
      const semester = period_semester === undefined || period_semester === null || period_semester === '' ? null : Number(period_semester);
      const numAmount = amount === undefined || amount === null || amount === '' ? 0 : Number(amount);
      const numDays = days === undefined || days === null || days === '' ? null : Number(days);

      if (!employee_id || !allowed) {
        return res.status(400).json({ status: 'error', error: 'Empleado y tipo de prestación válidos son obligatorios.' });
      }
      if (!allowed.includes(status)) {
        return res.status(400).json({ status: 'error', error: `Estado inválido para ${benefit_type}. Permitidos: ${allowed.join(', ')}.` });
      }
      if (!Number.isInteger(year) || year < 1990 || year > 2100) {
        return res.status(400).json({ status: 'error', error: 'Año del periodo inválido.' });
      }
      if (benefit_type === 'PRIMA' && ![1, 2].includes(semester)) {
        return res.status(400).json({ status: 'error', error: 'La prima requiere semestre 1 o 2.' });
      }
      if (benefit_type !== 'PRIMA' && semester !== null) {
        return res.status(400).json({ status: 'error', error: 'Solo la prima admite semestre.' });
      }
      if (!Number.isFinite(numAmount) || numAmount < 0 || (numDays !== null && (!Number.isFinite(numDays) || numDays < 0))) {
        return res.status(400).json({ status: 'error', error: 'Monto o días inválidos.' });
      }
      if (benefit_type === 'VACACIONES' && numDays === null) {
        return res.status(400).json({ status: 'error', error: 'Las vacaciones requieren el número de días (0 si confirma que no hubo).' });
      }
      if (status !== 'Disfrutado' && status !== 'Compensado' && numAmount <= 0) {
        return res.status(400).json({ status: 'error', error: 'El monto debe ser mayor que cero para este estado.' });
      }
      if (!evidence_reference || !String(evidence_reference).trim()) {
        return res.status(400).json({ status: 'error', error: 'La referencia de soporte (evidencia) es obligatoria.' });
      }

      const { rows } = await pool.query(`
        INSERT INTO pedidos_app_employee_benefit_records (
          employee_id, benefit_type, period_year, period_semester, status,
          amount, days, evidence_reference, notes, registered_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `, [
        employee_id, benefit_type, year, semester, status,
        numAmount, numDays, String(evidence_reference).trim(), notes?.trim() || null,
        req.user?.username || 'Administrador'
      ]);

      await audit(req, 'Registro de prestación', `${benefit_type} ${status} ${year}${semester ? '-S' + semester : ''} para empleado #${employee_id}`);
      res.status(201).json({ status: 'ok', record: rows[0], message: 'Registro de soporte guardado.' });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al registrar prestación.');
    }
  });

  // Los registros no se borran: se anulan conservando trazabilidad
  router.post('/benefit-records/:id/void', authenticateToken, checkPerm('eliminar'), async (req, res) => {
    try {
      const { reason } = req.body || {};
      if (!reason || !String(reason).trim()) {
        return res.status(400).json({ status: 'error', error: 'El motivo de anulación es obligatorio.' });
      }
      const { rows } = await pool.query(`
        UPDATE pedidos_app_employee_benefit_records
        SET voided_at = NOW(), voided_by = $1, void_reason = $2
        WHERE id = $3 AND voided_at IS NULL
        RETURNING *
      `, [req.user?.username || 'Administrador', String(reason).trim(), req.params.id]);
      if (rows.length === 0) {
        return res.status(404).json({ status: 'error', error: 'Registro no encontrado o ya anulado.' });
      }
      await audit(req, 'Registro de prestación anulado', `Registro #${req.params.id} anulado`);
      res.json({ status: 'ok', record: rows[0] });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al anular registro de prestación.');
    }
  });

  // Estima la liquidación con parámetros vigentes, registros de soporte y saldos pendientes reales
  const buildSettlementEstimate = async (employeeId, dischargeDate, confirmLastPeriodSettled) => {
    const { rows: empRows } = await pool.query('SELECT * FROM pedidos_app_employees WHERE id = $1', [employeeId]);
    if (empRows.length === 0) return null;
    const emp = empRows[0];
    const activeCfg = await getActivePayrollConfig(dischargeDate);

    const { rows: pendRows } = await pool.query(
      'SELECT COALESCE(SUM(balance_remaining), 0) AS total_pending FROM pedidos_app_employee_deductions WHERE employee_id = $1 AND status IN (\'Pendiente\', \'Parcial\')',
      [employeeId]
    );
    const { rows: wageRows } = await pool.query(
      'SELECT COALESCE(SUM(pending_balance), 0) AS pending_wages FROM pedidos_app_payroll_items WHERE employee_id = $1 AND pending_balance > 0',
      [employeeId]
    );
    const benefitRecords = await loadBenefitRecords(employeeId);

    const estimate = calculateSettlementEstimator({
      hireDateStr: emp.hire_date,
      dischargeDateStr: dischargeDate,
      salaryBase: emp.salary_base || (Number(emp.daily_rate || 0) * 30),
      appliedSmmlv: activeCfg.smmlv_amount,
      hasTransportAllowance: emp.has_transport_allowance,
      transportMonthly: activeCfg.transport_allowance_monthly,
      contractType: emp.contract_type,
      pendingDeductions: Number(pendRows[0].total_pending || 0),
      benefitRecords,
      pendingWages: Number(wageRows[0].pending_wages || 0),
      lastPeriodSettledConfirmed: confirmLastPeriodSettled === true
    });
    return { emp, estimate };
  };

  router.post('/settlements/estimate', authenticateToken, checkPerm('calcular'), async (req, res) => {
    try {
      const { employee_id, discharge_date, confirm_last_period_settled } = req.body || {};
      if (!employee_id || !discharge_date) {
        return res.status(400).json({ status: 'error', error: 'Empleado y fecha de retiro son obligatorios.' });
      }

      const built = await buildSettlementEstimate(employee_id, discharge_date, confirm_last_period_settled);
      if (!built) {
        return res.status(404).json({ status: 'error', error: 'Empleado no encontrado.' });
      }

      res.json({
        status: 'ok',
        estimate: {
          employee_id,
          employee_name: `${built.emp.first_name} ${built.emp.last_name}`,
          hire_date: built.emp.hire_date,
          discharge_date,
          ...built.estimate,
          base_salary_transport: built.estimate.base_for_benefits,
          base_salary_only: built.estimate.base_salary,
          cesantias_current_days: built.estimate.days_in_current_year,
          cesantias_current_amount: built.estimate.severance_pay,
          intereses_current_amount: built.estimate.severance_interest,
          prima_current_days: built.estimate.days_in_current_semester,
          prima_current_amount: built.estimate.service_bonus,
          vacaciones_pending_days: built.estimate.vacations?.pending_days || 0,
          vacaciones_amount: built.estimate.vacation_pay,
          prior_cesantias_pending: built.estimate.prior_obligations_documented || 0,
          pending_deductions_total: built.estimate.total_deductions || 0,
          net_settlement_payable: built.estimate.net_settlement
        }
      });
    } catch (err) {
      if (err instanceof RangeError) {
        return res.status(400).json({ status: 'error', error: err.message });
      }
      return handleServerError(res, err, 'No fue posible calcular la estimación de liquidación.');
    }
  });

  // Guardar liquidación de retiro. El cálculo y el carácter provisional lo fija SIEMPRE el servidor
  // (según soportes registrados); el cliente no puede declarar montos arbitrarios ni omitir el estado provisional.
  router.post('/settlements', authenticateToken, checkPerm('crear'), async (req, res) => {
    try {
      const {
        employee_id,
        discharge_date,
        compensation_amount,
        notes,
        confirm_last_period_settled,
        is_provisional: clientProvisional,
        severance_pay: clientSeverance,
        severance_interest: clientInterest,
        service_bonus: clientBonus,
        vacation_pay: clientVacation,
        net_settlement: clientNet
      } = req.body || {};

      if (!employee_id || !discharge_date) {
        return res.status(400).json({ status: 'error', error: 'Empleado y fecha de retiro son obligatorios.' });
      }

      // Validar si ya existe una liquidación activa o definitiva para este empleado (FIN-01)
      const { rows: existingRows } = await pool.query(
        'SELECT id, status FROM pedidos_app_employee_settlements WHERE employee_id = $1 AND status IN (\'Borrador\', \'Aprobado\', \'Pagado\') LIMIT 1',
        [employee_id]
      );
      if (existingRows.length > 0) {
        return res.status(409).json({
          status: 'error',
          code: 'SETTLEMENT_ALREADY_EXISTS',
          error: `Ya existe una liquidación registrada para este colaborador en estado ${existingRows[0].status}.`
        });
      }

      const built = await buildSettlementEstimate(employee_id, discharge_date, confirm_last_period_settled);
      if (!built) {
        return res.status(404).json({ status: 'error', error: 'Empleado no encontrado.' });
      }

      // Validar montos del cliente si se envían: deben coincidir con el cálculo del servidor
      const est = built.estimate;
      const tol = 1.0; // tolerancia de redondeo de 1 peso

      if (clientSeverance !== undefined && Math.abs(Number(clientSeverance) - est.severance_pay) > tol) {
        return res.status(400).json({ status: 'error', code: 'SETTLEMENT_AMOUNT_MISMATCH', error: 'El valor de cesantías no coincide con el cálculo del servidor.' });
      }
      if (clientInterest !== undefined && Math.abs(Number(clientInterest) - est.severance_interest) > tol) {
        return res.status(400).json({ status: 'error', code: 'SETTLEMENT_AMOUNT_MISMATCH', error: 'El valor de intereses de cesantías no coincide con el cálculo del servidor.' });
      }
      if (clientBonus !== undefined && Math.abs(Number(clientBonus) - est.service_bonus) > tol) {
        return res.status(400).json({ status: 'error', code: 'SETTLEMENT_AMOUNT_MISMATCH', error: 'El valor de prima de servicios no coincide con el cálculo del servidor.' });
      }
      if (clientVacation !== undefined && Math.abs(Number(clientVacation) - est.vacation_pay) > tol) {
        return res.status(400).json({ status: 'error', code: 'SETTLEMENT_AMOUNT_MISMATCH', error: 'El valor de vacaciones no coincide con el cálculo del servidor.' });
      }

      // Validar indemnización (compensation_amount >= 0)
      const numComp = Number(compensation_amount) || 0;
      if (numComp < 0 || isNaN(numComp)) {
        return res.status(400).json({ status: 'error', code: 'INVALID_COMPENSATION', error: 'La indemnización debe ser un valor mayor o igual a cero.' });
      }
      if (numComp > 0 && (!notes || !notes.trim())) {
        return res.status(400).json({ status: 'error', code: 'COMPENSATION_JUSTIFICATION_REQUIRED', error: 'Se requiere una justificación en las notas cuando se incluye indemnización.' });
      }

      // Servidor es fuente de verdad para el estado provisional
      const isProvisional = est.is_provisional;
      if (clientProvisional === false && isProvisional) {
        return res.status(400).json({
          status: 'error',
          code: 'CANNOT_MARK_DEFINITIVE',
          error: 'No es posible declarar la liquidación como definitiva porque faltan soportes de periodos anteriores o confirmaciones requeridas.'
        });
      }

      // Recalcular el neto estrictamente en el servidor
      const calculatedNet = Math.max(0, est.severance_pay + est.severance_interest + est.service_bonus + est.vacation_pay + (est.prior_obligations_documented || 0) + (est.pending_wages || 0) + numComp - est.total_deductions);

      if (clientNet !== undefined && Math.abs(Number(clientNet) - calculatedNet) > tol) {
        return res.status(400).json({ status: 'error', code: 'SETTLEMENT_AMOUNT_MISMATCH', error: 'El valor neto de la liquidación no coincide con el cálculo del servidor.' });
      }

      const { rows } = await pool.query(`
        INSERT INTO pedidos_app_employee_settlements (
          employee_id, hire_date, discharge_date, days_worked_total,
          base_salary, transport_allowance_included, severance_pay,
          severance_interest, service_bonus, vacation_pay, pending_wages,
          compensation_amount, total_deductions, net_settlement,
          is_provisional, status, notes
        ) VALUES (
          $1, $2::date, $3::date, $4,
          $5, $6, $7,
          $8, $9, $10, $11,
          $12, $13, $14,
          $15, 'Borrador', $16
        )
        RETURNING *
      `, [
        employee_id, built.emp.hire_date, discharge_date, est.days_worked_total,
        est.base_salary, est.transport_allowance_included, est.severance_pay,
        est.severance_interest, est.service_bonus, est.vacation_pay, est.pending_wages,
        numComp, est.total_deductions, calculatedNet,
        isProvisional, notes?.trim() || null
      ]);

      await audit(req, 'Liquidación registrada', `Liquidación para empleado #${employee_id} por $${calculatedNet} (provisional: ${isProvisional})`);
      res.status(201).json({
        status: 'ok',
        settlement: rows[0],
        is_provisional: isProvisional,
        missing_information: built.estimate.missing_information,
        message: isProvisional
          ? 'Liquidación guardada como PROVISIONAL: faltan soportes de periodos anteriores o confirmaciones.'
          : 'Liquidación guardada (sujeta a validación contable y jurídica).'
      });
    } catch (err) {
      if (err instanceof RangeError) {
        return res.status(400).json({ status: 'error', error: err.message });
      }
      return handleServerError(res, err, 'No fue posible guardar la liquidación.');
    }
  });

  // ==========================================================================
  // 9. RESUMEN EJECUTIVO (KPIS)
  // ==========================================================================

  router.get('/summary', authenticateToken, checkPerm('ver'), async (req, res) => {
    try {
      const { date_from, date_to } = req.query;
      const today = new Date();
      const currentYear = today.getFullYear();
      const currentMonth = today.getMonth() + 1;
      const lastDay = new Date(currentYear, currentMonth, 0).getDate();

      const start = date_from || `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
      const end = date_to || `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

      const { rows: empCounts } = await pool.query(`
        SELECT 
          COUNT(*)::int AS total_employees,
          COUNT(*) FILTER (WHERE status = 'Activo')::int AS active_employees
        FROM pedidos_app_employees
      `);

      const { rows: attCounts } = await pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'Trabajó')::int AS days_worked,
          COUNT(*) FILTER (WHERE status <> 'Trabajó')::int AS days_not_worked,
          COALESCE(SUM(hours_worked), 0)::numeric AS total_hours_worked,
          COALESCE(SUM(daily_value_applied), 0)::numeric AS total_base_earned,
          COALESCE(SUM(transport_allowance_applied), 0)::numeric AS total_transport_earned,
          COALESCE(SUM(overtime_value_applied), 0)::numeric AS total_overtime_earned
        FROM pedidos_app_employee_attendance
        WHERE attendance_date BETWEEN $1::date AND $2::date
      `, [start, end]);

      const { rows: mealCounts } = await pool.query(`
        SELECT 
          COUNT(*)::int AS meals_count,
          COALESCE(SUM(total_cost), 0)::numeric AS internal_consumption_total
        FROM pedidos_app_employee_meals
        WHERE status = 'Entregado' AND delivery_date BETWEEN $1::date AND $2::date
      `, [start, end]);

      const { rows: payCounts } = await pool.query(`
        SELECT 
          COALESCE(SUM(total_accrued), 0)::numeric AS total_accrued,
          COALESCE(SUM(total_deductions), 0)::numeric AS total_deductions,
          COALESCE(SUM(total_net_payable), 0)::numeric AS total_net_payable,
          COALESCE(SUM(total_net_payable - (
            SELECT COALESCE(SUM(p.amount_paid), 0) FROM pedidos_app_payroll_payments p 
            JOIN pedidos_app_payroll_items it ON it.id = p.payroll_item_id
            WHERE it.payroll_period_id = pedidos_app_payroll_periods.id AND p.status = 'Pagado'
          )), 0)::numeric AS total_pending_to_pay
        FROM pedidos_app_payroll_periods
        WHERE start_date >= $1::date AND end_date <= $2::date
      `, [start, end]);

      const { rows: settCounts } = await pool.query(`
        SELECT 
          COUNT(*)::int AS pending_settlements_count,
          COALESCE(SUM(net_settlement), 0)::numeric AS pending_settlements_amount
        FROM pedidos_app_employee_settlements
        WHERE status <> 'Pagado'
      `);

      res.json({
        status: 'ok',
        summary: {
          period_start: start,
          period_end: end,
          total_employees: empCounts[0].total_employees || 0,
          active_employees: empCounts[0].active_employees || 0,
          days_worked: attCounts[0].days_worked || 0,
          days_not_worked: attCounts[0].days_not_worked || 0,
          total_hours_worked: Number(attCounts[0].total_hours_worked || 0),
          total_base_earned: Number(attCounts[0].total_base_earned || 0),
          total_transport_earned: Number(attCounts[0].total_transport_earned || 0),
          total_overtime_earned: Number(attCounts[0].total_overtime_earned || 0),
          meals_delivered_count: mealCounts[0].meals_count || 0,
          internal_consumption_cost: Number(mealCounts[0].internal_consumption_total || 0),
          total_accrued: Number(payCounts[0]?.total_accrued || attCounts[0].total_base_earned || 0),
          total_deductions: Number(payCounts[0]?.total_deductions || 0),
          total_net_payable: Number(payCounts[0]?.total_net_payable || attCounts[0].total_base_earned || 0),
          total_pending_to_pay: Number(payCounts[0]?.total_pending_to_pay || 0),
          pending_settlements_count: settCounts[0].pending_settlements_count || 0,
          pending_settlements_amount: Number(settCounts[0].pending_settlements_amount || 0)
        }
      });
    } catch (err) {
      return handleServerError(res, err, 'Error interno al generar resumen de nómina.');
    }
  });

  // Montar router en la ruta base administrativa de nómina
  app.use('/api/pedidos/admin/nomina', router);
};

module.exports.calculateSettlementEstimator = calculateSettlementEstimator;

