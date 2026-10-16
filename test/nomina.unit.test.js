/**
 * test/nomina.unit.test.js — PRUEBAS UNITARIAS (sin PostgreSQL, sin red, sin escrituras en Neon)
 *
 * Ejecutan código REAL del proyecto:
 *   - nomina_calc.js  (cálculos puros: quincenas, asistencia, estimador, idempotencia)
 *   - nomina_api.js   (el handler real de POST /payments, contra una BD simulada en memoria)
 *
 * LIMITACIÓN: la BD simulada reproduce la semántica de bloqueos (advisory lock por clave, FOR UPDATE por fila,
 * ON CONFLICT DO NOTHING) pero NO es PostgreSQL. La concurrencia real se verifica en
 * test/nomina.integration.test.js (requiere una instancia desechable; ver ese archivo).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  days360Inclusive, summarizeAttendance, calculateMonthlyPeriodPay,
  evaluatePaymentIdempotency, calculateSettlementEstimator
} = require('../nomina_calc');
const mountNomina = require('../nomina_api');

// ============================================================================
// A. Días comerciales y salario mensual (febrero, abril, octubre)
// ============================================================================
describe('A. Días comerciales (base 360) y salario mensual por quincena', () => {
  const SALARY = 1750905;
  const TRANSPORT = 249095;
  const monthly = (over) => calculateMonthlyPeriodPay({
    salaryBase: SALARY, hireDate: '2020-01-01', hasTransportAllowance: true,
    eligibleForTransport: true, transportMonthly: TRANSPORT, ...over
  });

  it('days360Inclusive: segundas quincenas de febrero, abril y octubre valen 15; mes completo vale 30', () => {
    assert.equal(days360Inclusive('2026-02-16', '2026-02-28'), 15);
    assert.equal(days360Inclusive('2028-02-16', '2028-02-29'), 15); // bisiesto
    assert.equal(days360Inclusive('2026-04-16', '2026-04-30'), 15);
    assert.equal(days360Inclusive('2026-10-16', '2026-10-31'), 15);
    assert.equal(days360Inclusive('2026-02-01', '2026-02-15'), 15);
    assert.equal(days360Inclusive('2026-02-01', '2026-02-28'), 30);
    assert.equal(days360Inclusive('2026-10-31', '2026-10-01'), 0);
    assert.equal(days360Inclusive(new Date(2026, 0, 1), new Date(2026, 9, 15)), 285); // acepta Date de pg
  });

  for (const [mes, ini, fin] of [['febrero', '2026-02-16', '2026-02-28'], ['abril', '2026-04-16', '2026-04-30'], ['octubre', '2026-10-16', '2026-10-31']]) {
    it(`Mensual en ${mes}: paga siempre 15 días comerciales (base 875.452,50 y auxilio 124.547,50)`, () => {
      const r = monthly({ periodStart: ini, periodEnd: fin });
      assert.equal(r.periodCommercialDays, 15);
      assert.equal(r.paidDays, 15);
      assert.equal(r.baseSalaryEarned, 875452.5);
      assert.equal(r.transportAllowanceEarned, 124547.5);
    });
  }

  it('Permiso no remunerado: se descuenta UNA vez del salario y del auxilio (13 días)', () => {
    const r = monthly({ periodStart: '2026-10-16', periodEnd: '2026-10-31', unpaidLeaveDays: 2 });
    assert.equal(r.paidDays, 13);
    assert.equal(r.baseSalaryEarned, 758725.5); // 58.363,50 × 13
    assert.equal(r.transportAllowanceEarned, 107941.17); // 8.303,1667 × 13
  });

  it('Incapacidad/vacaciones: no descuentan salario (regla a validar) pero sí auxilio; sin doble descuento con permisos', () => {
    const sick = monthly({ periodStart: '2026-04-16', periodEnd: '2026-04-30', sickDays: 2 });
    assert.equal(sick.baseSalaryEarned, 875452.5);
    assert.equal(sick.transportAllowanceEarned, 107941.17);
    const mix = monthly({ periodStart: '2026-04-16', periodEnd: '2026-04-30', unpaidLeaveDays: 2, sickDays: 1 });
    assert.equal(mix.baseSalaryEarned, 758725.5); // solo los 2 días no remunerados descuentan salario
    assert.equal(mix.transportAllowanceEarned, 99638); // 15 − 2 − 1 = 12 días elegibles
  });

  it('Ingreso a mitad de periodo: solo días vinculados (21→31 oct = 10 días comerciales)', () => {
    const r = monthly({ periodStart: '2026-10-16', periodEnd: '2026-10-31', hireDate: '2026-10-21' });
    assert.equal(r.employedDays, 10);
    assert.equal(r.baseSalaryEarned, 583635);
    assert.equal(r.transportAllowanceEarned, 83031.67);
  });

  it('Retiro a mitad de periodo (16→20 feb = 5 días) y empleado ingresado después del periodo (0 días)', () => {
    const out = monthly({ periodStart: '2026-02-16', periodEnd: '2026-02-28', dischargeDate: '2026-02-20' });
    assert.equal(out.employedDays, 5);
    assert.equal(out.baseSalaryEarned, 291817.5);
    const none = monthly({ periodStart: '2026-02-16', periodEnd: '2026-02-28', hireDate: '2026-03-02' });
    assert.equal(none.employedDays, 0);
    assert.equal(none.baseSalaryEarned, 0);
  });

  it('Sin derecho a auxilio (> 2 SMMLV o sin auxilio pactado): auxilio 0', () => {
    assert.equal(monthly({ periodStart: '2026-10-16', periodEnd: '2026-10-31', eligibleForTransport: false }).transportAllowanceEarned, 0);
    assert.equal(monthly({ periodStart: '2026-10-16', periodEnd: '2026-10-31', hasTransportAllowance: false }).transportAllowanceEarned, 0);
  });

  it('Periodo mensual completo en febrero = 30 días comerciales (salario completo)', () => {
    const r = monthly({ periodStart: '2026-02-01', periodEnd: '2026-02-28' });
    assert.equal(r.paidDays, 30);
    assert.equal(r.baseSalaryEarned, SALARY);
  });
});

// ============================================================================
// B. Jornal / turno: asistencia por fecha, auxilio, horas y recargos separados
// ============================================================================
describe('B. Jornal / turno: asistencia por fecha', () => {
  const row = (date, status, extra = {}) => ({
    attendance_date: date, shift_number: 1, status, hours_worked: 8,
    daily_value_applied: 60000, transport_allowance_applied: 8303.17, overtime_value_applied: 0, ...extra
  });
  const mesCon = (year, month, days, status = 'Trabajó') => Array.from({ length: days }, (_, i) =>
    row(`${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`, status));

  it('Octubre 16 días trabajados: paga 16 jornales y 16 auxilios (no se trunca a 15)', () => {
    const rows = mesCon(2026, 10, 16);
    const s = summarizeAttendance(rows);
    assert.equal(s.daysWorked, 16);
    assert.equal(s.baseSalaryEarned, 960000);
    assert.equal(s.transportAllowanceEarned, 132850.72); // 16 × 8.303,17
    assert.equal(s.hoursWorked, 128);
  });

  it('Febrero 13 días y abril 15 días: pagan exactamente los días registrados', () => {
    assert.equal(summarizeAttendance(mesCon(2026, 2, 13)).baseSalaryEarned, 780000);
    assert.equal(summarizeAttendance(mesCon(2026, 4, 15)).baseSalaryEarned, 900000);
  });

  it('Dos turnos de media jornada el mismo día: 1 día, auxilio UNA vez, sin advertencia', () => {
    const rows = [
      row('2026-10-16', 'Media jornada', { shift_number: 1, hours_worked: 4, daily_value_applied: 30000 }),
      row('2026-10-16', 'Media jornada', { shift_number: 2, hours_worked: 4, daily_value_applied: 30000 })
    ];
    const s = summarizeAttendance(rows);
    assert.equal(s.daysWorked, 1);
    assert.equal(s.baseSalaryEarned, 60000);
    assert.equal(s.transportAllowanceEarned, 8303.17); // antes se pagaba dos veces
    assert.equal(s.hoursWorked, 8);
    assert.deepEqual(s.warnings, []);
  });

  it('Dos turnos "Trabajó" completos el mismo día: días tope 1, auxilio una vez y ADVERTENCIA (no se altera el valor base)', () => {
    const rows = [row('2026-10-17', 'Trabajó', { shift_number: 1 }), row('2026-10-17', 'Trabajó', { shift_number: 2 })];
    const s = summarizeAttendance(rows);
    assert.equal(s.daysWorked, 1);
    assert.equal(s.transportAllowanceEarned, 8303.17);
    assert.equal(s.baseSalaryEarned, 120000);
    assert.deepEqual(s.warnings, [{ date: '2026-10-17', code: 'MULTIPLE_FULL_SHIFTS_SAME_DATE' }]);
  });

  it('Recargos/extras se suman aparte y no alteran días, horas ni salario base', () => {
    const s = summarizeAttendance([
      row('2026-10-18', 'Trabajó', { overtime_value_applied: 39600 }),
      row('2026-10-19', 'Trabajó', { overtime_value_applied: 12000 })
    ]);
    assert.equal(s.overtimeAmount, 51600);
    assert.equal(s.baseSalaryEarned, 120000);
    assert.equal(s.daysWorked, 2);
  });

  it('Descanso/permiso/incapacidad: cuentan por fecha, sin auxilio y sin horas (el valor por defecto de 8 h no cuenta)', () => {
    const s = summarizeAttendance([
      row('2026-04-16', 'Descanso', { daily_value_applied: 60000, transport_allowance_applied: 0 }),
      row('2026-04-17', 'Permiso no remunerado', { daily_value_applied: 0, transport_allowance_applied: 0 }),
      row('2026-04-18', 'Incapacidad', { daily_value_applied: 0, transport_allowance_applied: 0 }),
      row('2026-04-19', 'Vacaciones', { transport_allowance_applied: 0 }),
      row('2026-04-20', 'Festivo', { transport_allowance_applied: 0 })
    ]);
    assert.deepEqual(
      [s.daysRest, s.daysLeaveUnpaid, s.daysSick, s.daysVacation, s.daysHoliday, s.daysWorked],
      [1, 1, 1, 1, 1, 0]
    );
    assert.equal(s.hoursWorked, 0);
    assert.equal(s.transportAllowanceEarned, 0);
  });

  it('Un día con ausencia no remunerada y un turno trabajado cuenta como trabajado (sin descuento doble)', () => {
    const s = summarizeAttendance([
      row('2026-10-20', 'Permiso no remunerado', { shift_number: 1, daily_value_applied: 0, transport_allowance_applied: 0 }),
      row('2026-10-20', 'Media jornada', { shift_number: 2, daily_value_applied: 30000 })
    ]);
    assert.equal(s.daysLeaveUnpaid, 0);
    assert.equal(s.daysWorked, 0.5);
  });
});

// ============================================================================
// C. Idempotencia de pagos: lógica pura
// ============================================================================
describe('C. evaluatePaymentIdempotency (lógica pura)', () => {
  const stored = { payroll_item_id: 7, amount_paid: '300000.00', payment_method: 'Transferencia', payment_date: new Date(2026, 9, 15) };
  it('Misma operación => compatible', () => {
    assert.deepEqual(evaluatePaymentIdempotency(stored,
      { payroll_item_id: 7, amount_paid: 300000, payment_method: 'Transferencia', payment_date: '2026-10-15' }),
      { compatible: true, reasons: [] });
  });
  it('Otro ítem, otro importe, otro medio u otra fecha => incompatible con el campo señalado', () => {
    const base = { payroll_item_id: 7, amount_paid: 300000, payment_method: 'Transferencia', payment_date: null };
    assert.deepEqual(evaluatePaymentIdempotency(stored, { ...base, payroll_item_id: 8 }).reasons, ['payroll_item_id']);
    assert.deepEqual(evaluatePaymentIdempotency(stored, { ...base, amount_paid: 300001 }).reasons, ['amount_paid']);
    assert.deepEqual(evaluatePaymentIdempotency(stored, { ...base, payment_method: 'Efectivo' }).reasons, ['payment_method']);
    assert.deepEqual(evaluatePaymentIdempotency(stored, { ...base, payment_date: '2026-10-16' }).reasons, ['payment_date']);
  });
});

// ============================================================================
// D. POST /payments REAL contra BD simulada con bloqueos (NO es PostgreSQL)
// ============================================================================
function makeFakeDb() {
  const state = {
    periods: new Map(),
    items: new Map(),
    payments: [],
    meals: new Map(),
    settlements: [],
    employees: new Map(),
    benefitRecords: [],
    config: { smmlv_amount: 1750905, transport_allowance_monthly: 249095 },
    nextPaymentId: 1,
    openLocks: 0,
    releasedClients: 0,
    txOpenAtRelease: 0
  };
  const addPeriod = (id, name, status, start_date = '2026-10-01', end_date = '2026-10-15') => state.periods.set(id, {
    id, name, status, start_date, end_date
  });
  const addItem = (id, employeeId, net, periodId = 1) => state.items.set(id, {
    id, employee_id: employeeId, payroll_period_id: periodId,
    net_payable: net, total_paid: 0, pending_balance: net, payment_status: 'Pendiente'
  });
  addPeriod(1, 'Periodo Activo 2026', 'Aprobado', '2026-10-01', '2026-10-15');
  addPeriod(2, 'Periodo Borrador 2026', 'Borrador', '2026-10-16', '2026-10-31');
  addPeriod(3, 'Periodo Cerrado 2026', 'Cerrado', '2026-09-16', '2026-09-30');
  addItem(1, 'emp-A', 1000000, 1);
  addItem(2, 'emp-B', 500000, 1);
  addItem(3, 'emp-Draft', 500000, 2);
  addItem(4, 'emp-Closed', 500000, 3);

  const locks = new Map(); // nombre -> { owner, waiters[] }
  const tick = () => new Promise((r) => setImmediate(r));
  async function acquire(name, owner) {
    let l = locks.get(name);
    if (!l) { l = { owner: null, waiters: [] }; locks.set(name, l); }
    if (l.owner === owner) return;
    if (l.owner !== null) await new Promise((resolve) => l.waiters.push(resolve));
    l.owner = owner;
    owner.held.push(name);
    state.openLocks++;
  }
  function releaseAll(owner) {
    for (const name of owner.held) {
      const l = locks.get(name);
      l.owner = null;
      state.openLocks--;
      const next = l.waiters.shift();
      if (next) next();
    }
    owner.held = [];
  }

  class FakeClient {
    constructor() { this.held = []; this.inTx = false; }
    async query(sql, params = []) {
      await tick();
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s === 'BEGIN') { this.inTx = true; return { rows: [] }; }
      if (s === 'COMMIT' || s === 'ROLLBACK') { this.inTx = false; releaseAll(this); return { rows: [] }; }
      if (s.includes('pg_advisory_xact_lock')) { await acquire(`adv:${params[0]}`, this); return { rows: [] }; }
      if (s.startsWith('SELECT * FROM pedidos_app_payroll_payments WHERE idempotency_key')) {
        return { rows: state.payments.filter((p) => p.idempotency_key === params[0]).map((p) => ({ ...p })) };
      }
      if (s.includes('FROM pedidos_app_payroll_items') && (s.includes('WHERE it.id = $1') || s.includes('WHERE id = $1')) && s.includes('FOR UPDATE')) {
        await acquire(`item:${params[0]}`, this);
        const it = state.items.get(Number(params[0]));
        if (!it) return { rows: [] };
        const period = state.periods.get(Number(it.payroll_period_id)) || { status: 'Aprobado', name: 'Periodo 1' };
        return { rows: [{ ...it, period_status: period.status, period_name: period.name }] };
      }
      if (s.startsWith('INSERT INTO pedidos_app_payroll_payments')) {
        const [itemId, employeeId, date, amount, method, , , key, , paidBy] = params;
        if (state.payments.some((p) => p.idempotency_key === key)) return { rows: [] }; // ON CONFLICT DO NOTHING
        const row = {
          id: state.nextPaymentId++, payroll_item_id: itemId, employee_id: employeeId,
          payment_date: date || '2026-10-15', amount_paid: amount, payment_method: method,
          idempotency_key: key, status: 'Pagado', paid_by: paidBy
        };
        state.payments.push(row);
        return { rows: [{ ...row }] };
      }
      if (s.startsWith('UPDATE pedidos_app_payroll_items')) {
        const [totalPaid, pending, status, id] = params;
        Object.assign(state.items.get(Number(id)), { total_paid: totalPaid, pending_balance: pending, payment_status: status });
        return { rows: [] };
      }
      if (s.includes('FROM pedidos_app_payroll_periods WHERE id = $1')) {
        if (s.includes('FOR UPDATE')) await acquire(`period:${params[0]}`, this);
        const p = state.periods.get(Number(params[0]));
        return { rows: p ? [{ ...p }] : [] };
      }
      if (s.includes('FROM pedidos_app_payroll_payments p') && s.includes('JOIN pedidos_app_payroll_items it') && s.includes('WHERE p.id = $1')) {
        const p = state.payments.find((pay) => pay.id === Number(params[0]));
        if (!p) return { rows: [] };
        const it = state.items.get(Number(p.payroll_item_id));
        return { rows: [{ ...p, payroll_period_id: it?.payroll_period_id || 1 }] };
      }
      if (s.includes('FROM pedidos_app_payroll_payments WHERE id = $1')) {
        if (s.includes('FOR UPDATE')) await acquire(`payment:${params[0]}`, this);
        const p = state.payments.find((pay) => pay.id === Number(params[0]));
        return { rows: p ? [{ ...p }] : [] };
      }
      if (s.startsWith('UPDATE pedidos_app_payroll_payments SET')) {
        const [canceller, reason, id] = params;
        const p = state.payments.find((pay) => pay.id === Number(id));
        if (p) {
          p.status = 'Anulado';
          p.annulled_at = new Date().toISOString();
          p.annulled_by = canceller;
          p.annul_reason = reason;
          return { rows: [{ ...p }] };
        }
        return { rows: [] };
      }
      if (s.includes('FROM pedidos_app_payroll_items WHERE payroll_period_id = $1') && s.includes('COUNT(*) AS count')) {
        const count = Array.from(state.items.values()).filter((it) => it.payroll_period_id === Number(params[0])).length;
        return { rows: [{ count }] };
      }
      if (s.includes('FROM pedidos_app_payroll_items WHERE payroll_period_id = $1') && s.includes('pending_balance > 0.005')) {
        if (s.includes('FOR UPDATE')) await acquire(`period_items:${params[0]}`, this);
        const pItems = Array.from(state.items.values()).filter((it) => it.payroll_period_id === Number(params[0]) && it.pending_balance > 0.005);
        const pendTotal = pItems.reduce((acc, it) => acc + it.pending_balance, 0);
        return { rows: [{ pend_count: pItems.length, pend_total: pendTotal }] };
      }
      if (s.includes('FROM pedidos_app_payroll_payments') && s.includes('payroll_period_id = $1')) {
        const count = state.payments.filter((p) => {
          const it = state.items.get(Number(p.payroll_item_id));
          return it && it.payroll_period_id === Number(params[0]) && p.status === 'Pagado';
        }).length;
        return { rows: [{ count }] };
      }
      if (s.startsWith('UPDATE pedidos_app_payroll_periods SET')) {
        const [newStatus, userName, id] = params;
        const p = state.periods.get(Number(id));
        if (p) {
          p.status = newStatus;
          if (newStatus === 'Aprobado') { p.approved_at = new Date().toISOString(); p.approved_by = userName; }
          if (newStatus === 'Cerrado') { p.closed_at = new Date().toISOString(); p.closed_by = userName; }
          return { rows: [{ ...p }] };
        }
        return { rows: [] };
      }
      if (s.startsWith('SELECT * FROM pedidos_app_employee_meals WHERE id = $1')) {
        const m = state.meals.get(Number(params[0]));
        return { rows: m ? [{ ...m }] : [] };
      }
      if (s.includes('FROM pedidos_app_payroll_periods WHERE $1::date BETWEEN start_date AND end_date')) {
        const dateStr = String(params[0]);
        const match = Array.from(state.periods.values()).find(
          (p) => ['Aprobado', 'Cerrado'].includes(p.status) && p.start_date && p.end_date && dateStr >= p.start_date && dateStr <= p.end_date
        );
        return { rows: match ? [{ ...match }] : [] };
      }
      if (s.startsWith('INSERT INTO pedidos_app_employee_settlements')) {
        const row = { id: state.settlements.length + 1, employee_id: params[0], net_settlement: params[13], is_provisional: params[14], status: 'Borrador' };
        state.settlements.push(row);
        return { rows: [row] };
      }
      throw new Error(`Consulta no simulada: ${s.slice(0, 80)}`);
    }
    release() { state.releasedClients++; if (this.inTx) state.txOpenAtRelease++; releaseAll(this); }
  }

  async function fakePoolQuery(sql, params = []) {
    await tick();
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT * FROM pedidos_app_payroll_periods WHERE id = $1')) {
      const p = state.periods.get(Number(params[0]));
      return { rows: p ? [{ ...p }] : [] };
    }
    if (s.includes('FROM pedidos_app_payroll_items WHERE payroll_period_id = $1') && s.includes('COUNT(*) AS count')) {
      const count = Array.from(state.items.values()).filter((it) => it.payroll_period_id === Number(params[0])).length;
      return { rows: [{ count }] };
    }
    if (s.includes('FROM pedidos_app_payroll_items WHERE payroll_period_id = $1') && s.includes('pending_balance > 0.005')) {
      const pItems = Array.from(state.items.values()).filter((it) => it.payroll_period_id === Number(params[0]) && it.pending_balance > 0.005);
      const pendTotal = pItems.reduce((acc, it) => acc + it.pending_balance, 0);
      return { rows: [{ pend_count: pItems.length, pend_total: pendTotal }] };
    }
    if (s.startsWith('UPDATE pedidos_app_payroll_periods SET status = $1')) {
      const [newStatus, userName, id] = params;
      const p = state.periods.get(Number(id));
      if (p) {
        p.status = newStatus;
        if (newStatus === 'Aprobado') { p.approved_at = new Date().toISOString(); p.approved_by = userName; }
        if (newStatus === 'Cerrado') { p.closed_at = new Date().toISOString(); p.closed_by = userName; }
        return { rows: [{ ...p }] };
      }
      return { rows: [] };
    }
    if (s.includes('FROM pedidos_app_employee_settlements WHERE employee_id = $1 AND status IN')) {
      const match = state.settlements.filter((st) => st.employee_id === params[0] && ['Borrador', 'Aprobado', 'Pagado'].includes(st.status));
      return { rows: match.map((st) => ({ ...st })) };
    }
    if (s.startsWith('SELECT * FROM pedidos_app_employees WHERE id = $1')) {
      const emp = state.employees.get(params[0]);
      return { rows: emp ? [{ ...emp }] : [] };
    }
    if (s.includes('FROM pedidos_app_payroll_config')) {
      return { rows: [{ ...state.config }] };
    }
    if (s.includes('FROM pedidos_app_employee_deductions WHERE employee_id = $1')) {
      return { rows: [{ total_pending: 0 }] };
    }
    if (s.includes('FROM pedidos_app_payroll_items WHERE employee_id = $1')) {
      return { rows: [{ pending_wages: 0 }] };
    }
    if (s.includes('FROM pedidos_app_employee_benefit_records WHERE employee_id = $1')) {
      return { rows: state.benefitRecords.filter((b) => b.employee_id === params[0]) };
    }
    if (s.startsWith('SELECT * FROM pedidos_app_payroll_periods WHERE 1=1')) {
      return { rows: Array.from(state.periods.values()) };
    }
    return { rows: [] };
  }

  return { state, pool: { connect: async () => new FakeClient(), query: fakePoolQuery } };
}

function mountPaymentsHandler(db) {
  let router;
  const app = { use: (_path, r) => { router = r; } };
  mountNomina(app, {
    pool: db.pool,
    authenticateToken: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    logActivity: undefined
  });
  const layer = router.stack.find((l) => l.route && l.route.path === '/payments' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  return (body, headers = {}) => new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; }
    };
    Promise.resolve(handler({ body, headers, user: { username: 'tester' } }, res)).catch(reject);
  });
}

function mountPeriodStatusHandler(db) {
  let router;
  const app = { use: (_path, r) => { router = r; } };
  mountNomina(app, {
    pool: db.pool,
    authenticateToken: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    logActivity: undefined
  });
  const layer = router.stack.find((l) => l.route && l.route.path === '/periods/:id/status' && l.route.methods.patch);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  return (id, body) => new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; }
    };
    Promise.resolve(handler({ params: { id }, body, user: { username: 'tester' } }, res)).catch(reject);
  });
}

function mountMealCancelHandler(db) {
  let router;
  const app = { use: (_path, r) => { router = r; } };
  mountNomina(app, {
    pool: db.pool,
    authenticateToken: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    logActivity: undefined
  });
  const layer = router.stack.find((l) => l.route && l.route.path === '/meals/:id/cancel' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  return (id, body = { reason: 'Motivo prueba' }) => new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; }
    };
    Promise.resolve(handler({ params: { id }, body, user: { username: 'tester' } }, res)).catch(reject);
  });
}

function mountSettlementsHandler(db) {
  let router;
  const app = { use: (_path, r) => { router = r; } };
  mountNomina(app, {
    pool: db.pool,
    authenticateToken: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    logActivity: undefined
  });
  const layer = router.stack.find((l) => l.route && l.route.path === '/settlements' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  return (body) => new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; }
    };
    Promise.resolve(handler({ body, user: { username: 'tester' } }, res)).catch(reject);
  });
}

function mountPeriodsGetHandler(db) {
  let router;
  const app = { use: (_path, r) => { router = r; } };
  mountNomina(app, {
    pool: db.pool,
    authenticateToken: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    logActivity: undefined
  });
  const layer = router.stack.find((l) => l.route && l.route.path === '/periods' && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  return (query = {}) => new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; }
    };
    Promise.resolve(handler({ query, user: { username: 'tester' } }, res)).catch(reject);
  });
}

function mountPaymentCancelHandler(db) {
  let router;
  const app = { use: (_path, r) => { router = r; } };
  mountNomina(app, {
    pool: db.pool,
    authenticateToken: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    logActivity: undefined
  });
  const layer = router.stack.find((l) => l.route && l.route.path === '/payments/:id/cancel' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  return (id, body = { reason: 'Motivo prueba anulación' }) => new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; }
    };
    Promise.resolve(handler({ params: { id }, body, user: { username: 'tester' } }, res)).catch(reject);
  });
}

describe('D. POST /payments (handler real, BD simulada con bloqueos)', () => {
  const pay = (over = {}) => ({
    payroll_item_id: 1, amount_paid: 300000, payment_method: 'Transferencia',
    idempotency_key: 'key-uuid-0001', ...over
  });

  it('Dos solicitudes SIMULTÁNEAS con la misma clave: un solo pago (201 + 200 duplicado)', async () => {
    const db = makeFakeDb();
    const post = mountPaymentsHandler(db);
    const [a, b] = await Promise.all([post(pay()), post(pay())]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    const replay = [a, b].find((r) => r.status === 200);
    const created = [a, b].find((r) => r.status === 201);
    assert.equal(replay.body.is_duplicate, true);
    assert.equal(replay.body.payment.id, created.body.payment.id);
    assert.equal(db.state.payments.length, 1);
    assert.equal(db.state.items.get(1).total_paid, 300000);
    assert.equal(db.state.items.get(1).pending_balance, 700000);
  });

  it('Diez solicitudes simultáneas con la misma clave: exactamente un pago', async () => {
    const db = makeFakeDb();
    const post = mountPaymentsHandler(db);
    const results = await Promise.all(Array.from({ length: 10 }, () => post(pay())));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 200).length, 9);
    assert.equal(db.state.payments.length, 1);
    assert.equal(db.state.items.get(1).total_paid, 300000);
  });

  it('Reintento posterior con la misma clave devuelve el pago original sin tocar saldos', async () => {
    const db = makeFakeDb();
    const post = mountPaymentsHandler(db);
    const first = await post(pay());
    const retry = await post(pay());
    assert.equal(first.status, 201);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.payment.id, first.body.payment.id);
    assert.equal(db.state.items.get(1).total_paid, 300000);
  });

  it('Clave reutilizada con otro importe, otro ítem u otro medio: 409 y no se crea ningún pago', async () => {
    const db = makeFakeDb();
    const post = mountPaymentsHandler(db);
    await post(pay());
    const diffAmount = await post(pay({ amount_paid: 100000 }));
    const diffItem = await post(pay({ payroll_item_id: 2 }));
    const diffMethod = await post(pay({ payment_method: 'Efectivo' }));
    for (const r of [diffAmount, diffItem, diffMethod]) {
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'IDEMPOTENCY_KEY_REUSED');
    }
    assert.deepEqual(diffAmount.body.mismatched_fields, ['amount_paid']);
    assert.deepEqual(diffItem.body.mismatched_fields, ['payroll_item_id']);
    assert.deepEqual(diffMethod.body.mismatched_fields, ['payment_method']);
    assert.equal(db.state.payments.length, 1);
    assert.equal(db.state.items.get(2).total_paid, 0);
  });

  it('Pagos parciales con claves distintas: Parcial, Parcial, Pagado; luego rechaza cualquier abono extra', async () => {
    const db = makeFakeDb();
    const post = mountPaymentsHandler(db);
    const r1 = await post(pay({ idempotency_key: 'key-partial-1', amount_paid: 300000 }));
    const r2 = await post(pay({ idempotency_key: 'key-partial-2', amount_paid: 300000 }));
    const r3 = await post(pay({ idempotency_key: 'key-partial-3', amount_paid: 400000 }));
    assert.deepEqual([r1.body.newPaymentStatus, r2.body.newPaymentStatus, r3.body.newPaymentStatus], ['Parcial', 'Parcial', 'Pagado']);
    assert.equal(db.state.items.get(1).pending_balance, 0);
    const extra = await post(pay({ idempotency_key: 'key-partial-4', amount_paid: 1 }));
    assert.equal(extra.status, 400); // ítem totalmente pagado (antes `pending_balance || net_payable` lo permitía)
    assert.equal(db.state.payments.length, 3);
  });

  it('Pagos CONCURRENTES con claves distintas que exceden el saldo: solo uno se acepta', async () => {
    const db = makeFakeDb();
    const post = mountPaymentsHandler(db);
    const [a, b] = await Promise.all([
      post(pay({ idempotency_key: 'key-race-aaaa', amount_paid: 600000 })),
      post(pay({ idempotency_key: 'key-race-bbbb', amount_paid: 600000 }))
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 400]);
    assert.equal(db.state.items.get(1).total_paid, 600000);
    assert.equal(db.state.payments.length, 1);
  });

  it('Sin clave o con clave corta: 400 IDEMPOTENCY_KEY_REQUIRED; la cabecera X-Idempotency-Key es válida', async () => {
    const db = makeFakeDb();
    const post = mountPaymentsHandler(db);
    const none = await post(pay({ idempotency_key: undefined }));
    const short = await post(pay({ idempotency_key: 'abc' }));
    assert.equal(none.status, 400);
    assert.equal(none.body.code, 'IDEMPOTENCY_KEY_REQUIRED');
    assert.equal(short.status, 400);
    const viaHeader = await post(pay({ idempotency_key: undefined }), { 'x-idempotency-key': 'header-key-0001' });
    assert.equal(viaHeader.status, 201);
    assert.equal(viaHeader.body.payment.idempotency_key, 'header-key-0001');
  });

  it('Ítem inexistente y monto inválido: 404 / 400 sin dejar transacciones ni bloqueos abiertos', async () => {
    const db = makeFakeDb();
    const post = mountPaymentsHandler(db);
    assert.equal((await post(pay({ payroll_item_id: 99, idempotency_key: 'key-missing-1' }))).status, 404);
    assert.equal((await post(pay({ amount_paid: -5, idempotency_key: 'key-negative-1' }))).status, 400);
    assert.equal((await post(pay({ amount_paid: 2000000, idempotency_key: 'key-toobig-001' }))).status, 400);
    assert.equal(db.state.openLocks, 0);
    assert.equal(db.state.txOpenAtRelease, 0);
  });

  it('Rechaza pago si el periodo está en "Borrador" con código PERIOD_NOT_APPROVED', async () => {
    const db = makeFakeDb();
    const post = mountPaymentsHandler(db);
    const res = await post(pay({ payroll_item_id: 3, idempotency_key: 'key-draft-item' }));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'PERIOD_NOT_APPROVED');
    assert.match(res.body.error, /Debe estar en estado "Aprobado"/);
  });

  it('Rechaza pago si el periodo está en "Cerrado" con código PERIOD_NOT_APPROVED', async () => {
    const db = makeFakeDb();
    const post = mountPaymentsHandler(db);
    const res = await post(pay({ payroll_item_id: 4, idempotency_key: 'key-closed-item' }));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'PERIOD_NOT_APPROVED');
    assert.match(res.body.error, /Debe estar en estado "Aprobado"/);
  });

  it('Actualiza total_paid, pending_balance y payment_status en pedidos_app_payroll_items al procesar un pago', async () => {
    const db = makeFakeDb();
    const post = mountPaymentsHandler(db);
    const itemBefore = db.state.items.get(1);
    assert.equal(itemBefore.total_paid, 0);
    assert.equal(itemBefore.pending_balance, 1000000);
    assert.equal(itemBefore.payment_status, 'Pendiente');

    const res = await post(pay({ payroll_item_id: 1, amount_paid: 250000, idempotency_key: 'key-update-item-paid' }));
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.newPaymentStatus, 'Parcial');
    assert.equal(res.body.pendingBalance, 750000);

    const itemAfter = db.state.items.get(1);
    assert.equal(itemAfter.total_paid, 250000);
    assert.equal(itemAfter.pending_balance, 750000);
    assert.equal(itemAfter.payment_status, 'Parcial');

    // Registro único del pago en pedidos_app_payroll_payments
    const paymentsForItem = db.state.payments.filter((p) => p.payroll_item_id === 1);
    assert.equal(paymentsForItem.length, 1);
    assert.equal(paymentsForItem[0].amount_paid, 250000);
    assert.equal(paymentsForItem[0].status, 'Pagado');
    assert.equal(paymentsForItem[0].idempotency_key, 'key-update-item-paid');
  });

  it('Tras conflictos de clave no queda ninguna transacción abierta ni bloqueo retenido', async () => {
    const db = makeFakeDb();
    const post = mountPaymentsHandler(db);
    await Promise.all([post(pay()), post(pay()), post(pay({ amount_paid: 1 }))]);
    assert.equal(db.state.openLocks, 0);
    assert.equal(db.state.txOpenAtRelease, 0);
    assert.equal(db.state.releasedClients, 3);
  });
});

// ============================================================================
// D.2. PATCH /periods/:id/status (transiciones de estado y saldos pendientes)
// ============================================================================
describe('D.2. PATCH /periods/:id/status (transiciones de estado y saldos pendientes)', () => {
  it('Rechaza aprobar un periodo sin liquidaciones calculadas', async () => {
    const db = makeFakeDb();
    db.state.periods.set(99, { id: 99, name: 'Vacio', status: 'Borrador' });
    const patch = mountPeriodStatusHandler(db);
    const res = await patch(99, { status: 'Aprobado' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /no ha sido calculado/);
  });

  it('Rechaza cerrar un periodo si no se encuentra en estado Aprobado', async () => {
    const db = makeFakeDb();
    const patch = mountPeriodStatusHandler(db);
    const res = await patch(2, { status: 'Cerrado' }); // Periodo 2 está en Borrador
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Solo es posible cerrar un periodo que se encuentre en estado "Aprobado"/);
  });

  it('Rechaza cerrar un periodo con saldos pendientes por pagar', async () => {
    const db = makeFakeDb();
    const patch = mountPeriodStatusHandler(db);
    const res = await patch(1, { status: 'Cerrado' }); // Periodo 1 tiene saldo pendiente
    assert.equal(res.status, 400);
    assert.match(res.body.error, /aún existen saldos pendientes de pago/);
  });

  it('Permite cerrar el periodo cuando todos los saldos han sido pagados', async () => {
    const db = makeFakeDb();
    for (const it of db.state.items.values()) {
      if (it.payroll_period_id === 1) {
        it.total_paid = it.net_payable;
        it.pending_balance = 0;
        it.payment_status = 'Pagado';
      }
    }
    const patch = mountPeriodStatusHandler(db);
    const res = await patch(1, { status: 'Cerrado' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.period.status, 'Cerrado');
  });
});

// ============================================================================
// E. Estimador de liquidación definitiva
// ============================================================================
describe('E. calculateSettlementEstimator', () => {
  const base = { salaryBase: 1750905, appliedSmmlv: 1750905, transportMonthly: 249095, hasTransportAllowance: true, dischargeDateStr: '2026-10-15' };
  const rec = (benefit_type, period_year, status, extra = {}) => ({
    benefit_type, period_year, status, period_semester: null, amount: 0, days: null, voided_at: null, ...extra
  });
  const missingOf = (e, concept) => e.missing_information.filter((m) => m.concept === concept);

  it('Menos de un año, SIN soportes: calcula el año corriente y marca PROVISIONAL con lo que falta', () => {
    const e = calculateSettlementEstimator({ ...base, hireDateStr: '2026-03-01' });
    assert.equal(e.days_worked_total, 225);
    assert.equal(e.days_in_current_year, 225);
    assert.equal(e.days_in_current_semester, 105);
    assert.equal(e.severance_pay, 1250000); // 2.000.000 × 225 / 360
    assert.equal(e.severance_interest, 93750);
    assert.equal(e.service_bonus, 583333); // semestre 2: 105 días
    assert.equal(e.vacations.accrued_days, 9.375);
    assert.equal(e.vacation_pay, 547158);
    assert.equal(e.net_settlement, 2474241);
    assert.equal(e.is_provisional, true);
    assert.equal(e.can_be_marked_definitive, false);
    assert.equal(missingOf(e, 'PRIMA').length, 1); // semestre 1 de 2026 (ingresó en marzo)
    assert.equal(missingOf(e, 'VACACIONES').length, 1);
    assert.equal(missingOf(e, 'SALARIOS_PERIODO_EN_CURSO').length, 1);
    assert.equal(e.prior_obligations_documented, 0);
  });

  it('Menos de un año, CON soportes y confirmación: deja de ser provisional (sigue requiriendo validación legal)', () => {
    const e = calculateSettlementEstimator({
      ...base, hireDateStr: '2026-03-01', lastPeriodSettledConfirmed: true,
      benefitRecords: [
        rec('PRIMA', 2026, 'Pagado', { period_semester: 1, amount: 480000 }),
        rec('VACACIONES', 2026, 'Disfrutado', { days: 0 })
      ]
    });
    assert.equal(e.missing_information.length, 0);
    assert.equal(e.is_provisional, false);
    assert.equal(e.can_be_marked_definitive, true);
    assert.equal(e.requires_legal_validation, true);
    assert.equal(e.net_settlement, 2474241);
  });

  it('Varios años SIN soportes: NO suma toda la antigüedad ni da por pagados los años previos; lista lo que falta', () => {
    const e = calculateSettlementEstimator({ ...base, hireDateStr: '2023-01-01' });
    assert.equal(e.days_worked_total, 1365);
    assert.equal(e.days_in_current_year, 285);
    assert.equal(e.severance_pay, 1583333); // solo 2026 (la fórmula anterior daba una cifra por toda la antigüedad)
    assert.equal(e.severance_interest, 150417);
    assert.equal(e.service_bonus, 583333);
    assert.equal(e.vacations.accrued_days, 56.875);
    assert.equal(e.vacation_pay, 3319424);
    assert.equal(e.net_settlement, 5636507);
    assert.equal(missingOf(e, 'CESANTIAS').map((m) => m.year).join(), '2023,2024,2025');
    assert.equal(missingOf(e, 'INTERESES_CESANTIAS').length, 3);
    assert.equal(missingOf(e, 'PRIMA').length, 7); // 2023-S1 … 2026-S1
    assert.equal(e.prior_obligations.unknown.length, 13);
    assert.equal(e.prior_obligations_documented, 0);
    assert.equal(e.is_provisional, true);
  });

  it('Varios años CON soportes: periodos cubiertos no suman; los pendientes documentados se suman aparte', () => {
    const records = [
      rec('CESANTIAS', 2023, 'Consignado', { amount: 1100000 }),
      rec('CESANTIAS', 2024, 'Consignado', { amount: 1200000 }),
      rec('CESANTIAS', 2025, 'Pendiente', { amount: 1400000 }),
      rec('INTERESES_CESANTIAS', 2023, 'Pagado', { amount: 132000 }),
      rec('INTERESES_CESANTIAS', 2024, 'Pagado', { amount: 144000 }),
      rec('INTERESES_CESANTIAS', 2025, 'Pendiente', { amount: 168000 }),
      ...[[2023, 1], [2023, 2], [2024, 1], [2024, 2], [2025, 1], [2026, 1]].map(([y, s]) => rec('PRIMA', y, 'Pagado', { period_semester: s, amount: 600000 })),
      rec('PRIMA', 2025, 'Pendiente', { period_semester: 2, amount: 700000 }),
      rec('VACACIONES', 2024, 'Disfrutado', { days: 30 }),
      rec('VACACIONES', 2025, 'Compensado', { days: 15 })
    ];
    const e = calculateSettlementEstimator({ ...base, hireDateStr: '2023-01-01', benefitRecords: records, lastPeriodSettledConfirmed: true });
    assert.equal(e.missing_information.length, 0);
    assert.equal(e.prior_obligations.covered.length, 10); // 2 cesantías + 2 intereses + 6 primas
    assert.equal(e.prior_obligations.documented_pending.length, 3);
    assert.equal(e.prior_obligations_documented, 2268000);
    assert.equal(e.vacations.pending_days, 11.875);
    assert.equal(e.vacation_pay, 693067);
    assert.equal(e.net_settlement, 5278150);
    assert.equal(e.is_provisional, false);
  });

  it('Prima del semestre corriente parcialmente pagada: descuenta lo ya pagado (sin duplicar)', () => {
    const e = calculateSettlementEstimator({
      ...base, hireDateStr: '2026-07-01',
      benefitRecords: [rec('PRIMA', 2026, 'Pagado', { period_semester: 2, amount: 100000 })]
    });
    assert.equal(e.service_bonus, 583333 - 100000);
    assert.equal(e.current_semester_detail.prima_ya_pagada, 100000);
    assert.equal(missingOf(e, 'PRIMA').length, 0); // ingresó el 1-jul: no hay semestre previo
  });

  it('Cesantías del año corriente ya anticipadas se descuentan', () => {
    const e = calculateSettlementEstimator({
      ...base, hireDateStr: '2026-03-01',
      benefitRecords: [rec('CESANTIAS', 2026, 'Pagado', { amount: 400000 })]
    });
    assert.equal(e.severance_pay, 850000);
    assert.equal(e.current_year_detail.cesantias_causadas, 1250000);
  });

  it('Registros anulados se ignoran (el periodo vuelve a quedar sin soporte)', () => {
    const e = calculateSettlementEstimator({
      ...base, hireDateStr: '2024-01-01',
      benefitRecords: [rec('CESANTIAS', 2024, 'Consignado', { amount: 1200000, voided_at: '2026-01-01' })]
    });
    assert.equal(missingOf(e, 'CESANTIAS').length, 2); // 2024 y 2025
  });

  it('Vacaciones disfrutadas + compensadas por encima de las causadas generan advertencia', () => {
    const e = calculateSettlementEstimator({
      ...base, hireDateStr: '2026-03-01',
      benefitRecords: [rec('VACACIONES', 2026, 'Disfrutado', { days: 30 })]
    });
    assert.equal(e.vacations.pending_days, 0);
    assert.equal(e.vacation_pay, 0);
    assert.equal(e.warnings[0].code, 'VACATION_DAYS_EXCEED_ACCRUED');
  });

  it('Prestación de servicios: sin prestaciones; fechas inválidas lanzan RangeError', () => {
    const e = calculateSettlementEstimator({ ...base, hireDateStr: '2025-01-01', contractType: 'Prestación de Servicios', salaryBase: 3000000 });
    assert.equal(e.severance_pay + e.service_bonus + e.vacation_pay + e.net_settlement, 0);
    assert.equal(e.is_provisional, true);
    assert.throws(() => calculateSettlementEstimator({ ...base, hireDateStr: '2026-11-01' }), RangeError);
    assert.throws(() => calculateSettlementEstimator({ ...base, hireDateStr: 'x' }), RangeError);
  });

  it('Acepta fechas Date (como entrega pg) y descuenta anticipos pendientes del neto', () => {
    const e = calculateSettlementEstimator({ ...base, hireDateStr: new Date(2026, 2, 1), dischargeDateStr: new Date(2026, 9, 15), pendingDeductions: 100000 });
    assert.equal(e.days_worked_total, 225);
    assert.equal(e.net_settlement, 2474241 - 100000);
  });
});

// ============================================================================
// F. Fase 4.1: Seguridad, integridad financiera y sanitización (SEC-01, INV-01, FIN-01, SEC-02)
// ============================================================================
describe('F. Fase 4.1: Seguridad, integridad financiera y sanitización', () => {
  it('SEC-01: Rechaza anular un periodo que tiene pagos activos registrados', async () => {
    const db = makeFakeDb();
    // Registrar un pago en el periodo 1
    db.state.payments.push({
      id: 99,
      payroll_item_id: 1,
      status: 'Pagado',
      amount_paid: 100000
    });
    const patch = mountPeriodStatusHandler(db);
    const res = await patch(1, { status: 'Anulado' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /No es posible anular un periodo con pagos registrados/);
  });

  it('INV-01: Rechaza anular comida si la fecha cae en un periodo Aprobado o Cerrado', async () => {
    const db = makeFakeDb();
    db.state.meals.set(10, {
      id: 10,
      employee_id: 'emp-A',
      delivery_date: '2026-10-10', // Cae dentro del periodo 1 (2026-10-01 a 2026-10-15, Aprobado)
      status: 'Entregado'
    });
    const cancelMeal = mountMealCancelHandler(db);
    const res = await cancelMeal(10, { reason: 'Anulación de prueba' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'PERIOD_CLOSED_OR_APPROVED');
    assert.match(res.body.error, /No es posible anular la entrega.*porque pertenece al periodo/);
  });

  it('FIN-01: Rechaza registrar liquidación si ya existe una liquidación activa (409 Conflict)', async () => {
    const db = makeFakeDb();
    db.state.employees.set('emp-001', {
      id: 'emp-001',
      first_name: 'Carlos',
      last_name: 'Pérez',
      hire_date: '2024-01-01',
      salary_base: 2000000,
      contract_type: 'Término Fijo',
      has_transport_allowance: true
    });
    db.state.settlements.push({
      id: 1,
      employee_id: 'emp-001',
      status: 'Borrador',
      net_settlement: 1500000
    });

    const postSettlement = mountSettlementsHandler(db);
    const res = await postSettlement({
      employee_id: 'emp-001',
      discharge_date: '2026-10-15'
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'SETTLEMENT_ALREADY_EXISTS');
  });

  it('FIN-01: Rechaza montos de cesantías manipulados por el cliente (SETTLEMENT_AMOUNT_MISMATCH)', async () => {
    const db = makeFakeDb();
    db.state.employees.set('emp-002', {
      id: 'emp-002',
      first_name: 'Ana',
      last_name: 'Gómez',
      hire_date: '2026-01-01',
      salary_base: 2000000,
      contract_type: 'Término Indefinido',
      has_transport_allowance: false
    });

    const postSettlement = mountSettlementsHandler(db);
    const res = await postSettlement({
      employee_id: 'emp-002',
      discharge_date: '2026-10-15',
      severance_pay: 99999999 // Monto falso
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'SETTLEMENT_AMOUNT_MISMATCH');
    assert.match(res.body.error, /no coincide con el cálculo del servidor/);
  });

  it('FIN-01: Rechaza indemnización negativa y exige justificación si es positiva', async () => {
    const db = makeFakeDb();
    db.state.employees.set('emp-003', {
      id: 'emp-003',
      first_name: 'Mario',
      last_name: 'López',
      hire_date: '2026-01-01',
      salary_base: 1800000,
      contract_type: 'Término Indefinido',
      has_transport_allowance: true
    });

    const postSettlement = mountSettlementsHandler(db);

    // Indemnización negativa
    const resNegative = await postSettlement({
      employee_id: 'emp-003',
      discharge_date: '2026-10-15',
      compensation_amount: -50000
    });
    assert.equal(resNegative.status, 400);
    assert.equal(resNegative.body.code, 'INVALID_COMPENSATION');

    // Indemnización positiva sin notas explicativas
    const resNoNotes = await postSettlement({
      employee_id: 'emp-003',
      discharge_date: '2026-10-15',
      compensation_amount: 500000,
      notes: '   '
    });
    assert.equal(resNoNotes.status, 400);
    assert.equal(resNoNotes.body.code, 'COMPENSATION_JUSTIFICATION_REQUIRED');
  });

  it('FIN-01: Rechaza intento del cliente de forzar is_provisional = false sin cumplir soportes', async () => {
    const db = makeFakeDb();
    db.state.employees.set('emp-004', {
      id: 'emp-004',
      first_name: 'Luisa',
      last_name: 'Morales',
      hire_date: '2024-01-01',
      salary_base: 2000000,
      contract_type: 'Término Indefinido',
      has_transport_allowance: true
    });

    const postSettlement = mountSettlementsHandler(db);
    const res = await postSettlement({
      employee_id: 'emp-004',
      discharge_date: '2026-10-15',
      is_provisional: false // Intento de spoofing
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'CANNOT_MARK_DEFINITIVE');
  });

  it('SEC-02: Errores internos de base de datos se sanitizan y no filtran SQL ni detalles técnicos', async () => {
    const db = makeFakeDb();
    // Forzar un error interno simulando fallo catastrófico en la consulta
    db.pool.query = async () => {
      throw new Error('PG: syntax error at or near "DROP TABLE confidential_orders"');
    };

    const getPeriods = mountPeriodsGetHandler(db);
    const res = await getPeriods();

    assert.equal(res.status, 500);
    assert.equal(res.body.status, 'error');
    assert.equal(res.body.code, 'INTERNAL_SERVER_ERROR');
    assert.equal(res.body.error, 'Error interno al consultar periodos de nómina.');
    assert.doesNotMatch(res.body.error, /DROP TABLE/);
    assert.doesNotMatch(res.body.error, /confidential_orders/);
  });
});

describe('G. Fase 4.3: Corrección AUD-01 — Anulación de pagos en periodos cerrados', () => {
  it('Anulación de pago en periodo abierto: revierte saldos correctamente y marca pago como Anulado', async () => {
    const db = makeFakeDb();
    // Configurar periodo 1 en Aprobado
    db.state.periods.set(1, { id: 1, name: 'Quincena 1 Octubre', status: 'Aprobado' });
    // Configurar item 1 con pago parcial
    db.state.items.set(1, {
      id: 1, payroll_period_id: 1, employee_id: 'emp-001',
      net_payable: 1000000, total_paid: 300000, pending_balance: 700000, payment_status: 'Parcial'
    });
    // Configurar pago 1
    db.state.payments.push({
      id: 1, payroll_item_id: 1, employee_id: 'emp-001', amount_paid: 300000,
      payment_method: 'Transferencia', status: 'Pagado', idempotency_key: 'pay-key-01'
    });

    const cancelPay = mountPaymentCancelHandler(db);
    const res = await cancelPay(1, { reason: 'Comprobante duplicado por error de digitación' });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.payment.status, 'Anulado');

    // Verificar en el estado del mock que el pago quedó anulado
    const updatedPayment = db.state.payments.find((p) => p.id === 1);
    assert.equal(updatedPayment.status, 'Anulado');
    assert.equal(updatedPayment.annul_reason, 'Comprobante duplicado por error de digitación');

    // Verificar que el saldo del ítem revirtió el importe anulado
    const updatedItem = db.state.items.get(1);
    assert.equal(updatedItem.total_paid, 0);
    assert.equal(updatedItem.pending_balance, 1000000);
    assert.equal(updatedItem.payment_status, 'Pendiente');
  });

  it('Anulación de pago en periodo cerrado: rechazo 400 con código PERIOD_ALREADY_CLOSED e integridad intacta', async () => {
    const db = makeFakeDb();
    // Configurar periodo 1 en Cerrado
    db.state.periods.set(1, { id: 1, name: 'Quincena 1 Octubre (Cerrada)', status: 'Cerrado' });
    // Configurar item 1 totalmente pagado
    db.state.items.set(1, {
      id: 1, payroll_period_id: 1, employee_id: 'emp-001',
      net_payable: 1000000, total_paid: 1000000, pending_balance: 0, payment_status: 'Pagado'
    });
    // Configurar pago 1
    db.state.payments.push({
      id: 1, payroll_item_id: 1, employee_id: 'emp-001', amount_paid: 1000000,
      payment_method: 'Transferencia', status: 'Pagado', idempotency_key: 'pay-key-closed-01'
    });

    const cancelPay = mountPaymentCancelHandler(db);
    const res = await cancelPay(1, { reason: 'Intento de anulación extemporánea' });

    assert.equal(res.status, 400);
    assert.equal(res.body.status, 'error');
    assert.equal(res.body.code, 'PERIOD_ALREADY_CLOSED');
    assert.match(res.body.error, /se encuentra en estado "Cerrado"/);

    // Verificación crítica: El pago debe permanecer intacto en estado 'Pagado'
    const payment = db.state.payments.find((p) => p.id === 1);
    assert.equal(payment.status, 'Pagado');
    assert.equal(payment.annul_reason, undefined);

    // Verificación crítica: Los saldos del ítem deben permanecer inalterados
    const item = db.state.items.get(1);
    assert.equal(item.total_paid, 1000000);
    assert.equal(item.pending_balance, 0);
    assert.equal(item.payment_status, 'Pagado');
  });

  it('Doble anulación: rechazo sin duplicar efecto financiero sobre el saldo', async () => {
    const db = makeFakeDb();
    db.state.periods.set(1, { id: 1, name: 'Quincena 1 Octubre', status: 'Aprobado' });
    db.state.items.set(1, {
      id: 1, payroll_period_id: 1, employee_id: 'emp-001',
      net_payable: 1000000, total_paid: 500000, pending_balance: 500000, payment_status: 'Parcial'
    });
    // Pago ya marcado como Anulado previamente
    db.state.payments.push({
      id: 1, payroll_item_id: 1, employee_id: 'emp-001', amount_paid: 500000,
      payment_method: 'Transferencia', status: 'Anulado', idempotency_key: 'pay-key-dup'
    });

    const cancelPay = mountPaymentCancelHandler(db);
    const res = await cancelPay(1, { reason: 'Reintento de anulación' });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /ya se encuentra anulado/);

    // Saldos deben continuar exactamente iguales
    const item = db.state.items.get(1);
    assert.equal(item.total_paid, 500000);
    assert.equal(item.pending_balance, 500000);
  });

  it('Error intermedio en transacción provoca rollback y conserva estado original', async () => {
    const db = makeFakeDb();
    db.state.periods.set(1, { id: 1, name: 'Quincena 1 Octubre', status: 'Aprobado' });
    db.state.items.set(1, {
      id: 1, payroll_period_id: 1, employee_id: 'emp-001',
      net_payable: 1000000, total_paid: 300000, pending_balance: 700000, payment_status: 'Parcial'
    });
    db.state.payments.push({
      id: 1, payroll_item_id: 1, employee_id: 'emp-001', amount_paid: 300000,
      payment_method: 'Transferencia', status: 'Pagado', idempotency_key: 'pay-key-err'
    });

    // Inyectar fallo cuando se actualiza el ítem
    const origQuery = db.pool.connect;
    db.pool.connect = async () => {
      const client = await origQuery();
      const origClientQuery = client.query.bind(client);
      client.query = async (sql, params) => {
        if (typeof sql === 'string' && sql.includes('UPDATE pedidos_app_payroll_payments')) {
          throw new Error('PG connection lost during payment status update');
        }
        return origClientQuery(sql, params);
      };
      return client;
    };

    const cancelPay = mountPaymentCancelHandler(db);
    const res = await cancelPay(1, { reason: 'Anulación con error forzado' });

    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'INTERNAL_SERVER_ERROR');

    // Comprobar que el rollback restauró el pago a Pagado y no alteró saldos
    const payment = db.state.payments.find((p) => p.id === 1);
    assert.equal(payment.status, 'Pagado');
    const item = db.state.items.get(1);
    assert.equal(item.total_paid, 300000);
    assert.equal(item.pending_balance, 700000);
  });

  it('Reintento después de rechazo por motivo faltante', async () => {
    const db = makeFakeDb();
    db.state.periods.set(1, { id: 1, name: 'Quincena 1 Octubre', status: 'Aprobado' });
    db.state.items.set(1, {
      id: 1, payroll_period_id: 1, employee_id: 'emp-001',
      net_payable: 1000000, total_paid: 400000, pending_balance: 600000, payment_status: 'Parcial'
    });
    db.state.payments.push({
      id: 1, payroll_item_id: 1, employee_id: 'emp-001', amount_paid: 400000,
      payment_method: 'Transferencia', status: 'Pagado', idempotency_key: 'pay-key-retry'
    });

    const cancelPay = mountPaymentCancelHandler(db);
    // 1. Envío sin motivo
    const res1 = await cancelPay(1, { reason: '   ' });
    assert.equal(res1.status, 400);
    assert.match(res1.body.error, /El motivo de anulación es obligatorio/);
    assert.equal(db.state.payments.find((p) => p.id === 1).status, 'Pagado');

    // 2. Reintento con motivo válido
    const res2 = await cancelPay(1, { reason: 'Motivo corregido y justificado' });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.status, 'ok');
    assert.equal(db.state.payments.find((p) => p.id === 1).status, 'Anulado');
    assert.equal(db.state.items.get(1).pending_balance, 1000000);
  });
});
