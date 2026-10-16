'use strict';
/**
 * nomina_calc.js
 * Funciones PURAS del módulo de nómina (sin acceso a base de datos).
 * Se prueban directamente en test/nomina.unit.test.js: las pruebas ejecutan este código real.
 *
 * REGLAS CON INCERTIDUMBRE JURÍDICA (validar con asesor laboral antes de producción):
 *  - Base 360 (meses comerciales de 30 días) para días de cesantías, prima y vacaciones. El último día
 *    de febrero se cuenta como día 30. Es el criterio más usado, pero debe confirmarlo el asesor.
 *  - Incapacidades: el salario mensual NO se descuenta en la quincena (no se modela el 66,67 % / EPS).
 *  - Auxilio de transporte en contrato mensual: se paga por día comercial empleado, excluyendo permisos no
 *    remunerados, incapacidades y vacaciones. Descansos y festivos no se excluyen (criterio a validar).
 *  - Descuento de anticipos/préstamos sobre la liquidación final requiere autorización escrita (Art. 149 CST).
 *  - Salario variable (promedio para prestaciones) y cesantías retroactivas (régimen anterior a Ley 50) no se modelan.
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

/** Normaliza string 'YYYY-MM-DD…' o Date (la librería pg entrega DATE como Date en hora local) a 'YYYY-MM-DD'. */
function toYMD(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  if (value instanceof Date && !isNaN(value.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  return null;
}

const parts = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return { y, m, d };
};
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const commercialDay = (p) => (p.m === 2 && p.d === lastDayOfMonth(p.y, p.m) ? 30 : Math.min(p.d, 30));
const maxYMD = (a, b) => (a >= b ? a : b);
const minYMD = (a, b) => (a <= b ? a : b);

/** Días comerciales (base 360) entre dos fechas, ambas incluidas. 0 si fin < inicio. */
function days360Inclusive(startValue, endValue) {
  const s = toYMD(startValue);
  const e = toYMD(endValue);
  if (!s || !e || e < s) return 0;
  const a = parts(s);
  const b = parts(e);
  return (b.y - a.y) * 360 + (b.m - a.m) * 30 + (commercialDay(b) - commercialDay(a)) + 1;
}

const WORKED_FRACTION = { 'Trabajó': 1, 'Media jornada': 0.5 };

/**
 * Resume asistencia por FECHA (no por fila), para que turnos múltiples no dupliquen días ni auxilio.
 *  - Días trabajados: suma de fracciones por fecha, con tope de 1 por fecha.
 *  - Auxilio de transporte: UNA vez por fecha trabajada (el mayor valor aplicado ese día).
 *  - Horas: solo de filas con estado trabajado (el valor por defecto de 8 h en descansos no cuenta).
 *  - Recargos/extras: se suman aparte desde overtime_value_applied (nunca se mezclan con el salario base).
 *  - Valor base: suma de daily_value_applied; si una fecha acumula más de 1 jornada se emite advertencia
 *    (convención: turnos parciales deben registrarse como 'Media jornada' o con custom_daily_value).
 */
function summarizeAttendance(rows) {
  const byDate = new Map();
  let hoursWorked = 0;
  let overtimeAmount = 0;

  for (const r of rows || []) {
    const date = toYMD(r.attendance_date);
    if (!date) continue;
    const e = byDate.get(date) || { fraction: 0, statuses: [], base: 0, transport: 0 };
    const frac = WORKED_FRACTION[r.status] || 0;
    e.fraction += frac;
    e.statuses.push(r.status);
    e.base += Number(r.daily_value_applied) || 0;
    if (frac > 0) {
      e.transport = Math.max(e.transport, Number(r.transport_allowance_applied) || 0);
      hoursWorked += Number(r.hours_worked) || 0;
    }
    overtimeAmount += Number(r.overtime_value_applied) || 0;
    byDate.set(date, e);
  }

  const out = {
    daysWorked: 0, daysRest: 0, daysLeavePaid: 0, daysLeaveUnpaid: 0,
    daysSick: 0, daysVacation: 0, daysHoliday: 0,
    hoursWorked: 0, baseSalaryEarned: 0, transportAllowanceEarned: 0, overtimeAmount: 0,
    warnings: []
  };
  let base = 0;
  let transport = 0;

  for (const [date, e] of byDate) {
    base += e.base;
    if (e.fraction > 0) {
      out.daysWorked += Math.min(1, e.fraction);
      transport += e.transport;
      if (e.fraction > 1) out.warnings.push({ date, code: 'MULTIPLE_FULL_SHIFTS_SAME_DATE' });
      continue;
    }
    const st = e.statuses[0];
    if (st === 'Descanso') out.daysRest += 1;
    else if (st === 'Permiso remunerado') out.daysLeavePaid += 1;
    else if (st === 'Permiso no remunerado') out.daysLeaveUnpaid += 1;
    else if (st === 'Incapacidad') out.daysSick += 1;
    else if (st === 'Vacaciones') out.daysVacation += 1;
    else if (st === 'Festivo') out.daysHoliday += 1;
  }

  out.hoursWorked = round2(hoursWorked);
  out.baseSalaryEarned = round2(base);
  out.transportAllowanceEarned = round2(transport);
  out.overtimeAmount = round2(overtimeAmount);
  return out;
}

/**
 * Salario mensual fijo, proporcional al periodo en días comerciales (quincena = 15; mes = 30).
 *  - Febrero 16-28, abril 16-30 y octubre 16-31 equivalen todos a 15 días comerciales.
 *  - Ingreso o retiro dentro del periodo: solo se pagan los días comerciales vinculados.
 *  - Permiso no remunerado: se descuenta UNA sola vez (días distintos, nunca más que los vinculados).
 *  - Las novedades se pasan ya contadas por fecha (ver summarizeAttendance).
 */
function calculateMonthlyPeriodPay({
  salaryBase, periodStart, periodEnd, hireDate, dischargeDate = null,
  unpaidLeaveDays = 0, sickDays = 0, vacationDays = 0,
  hasTransportAllowance = false, eligibleForTransport = false, transportMonthly = 0
}) {
  const ps = toYMD(periodStart);
  const pe = toYMD(periodEnd);
  const periodCommercialDays = days360Inclusive(ps, pe);
  const effStart = maxYMD(ps, toYMD(hireDate) || ps);
  const effEnd = minYMD(pe, toYMD(dischargeDate) || pe);
  const employedDays = days360Inclusive(effStart, effEnd);
  const unpaid = Math.min(Math.max(0, Number(unpaidLeaveDays) || 0), employedDays);
  const paidDays = employedDays - unpaid;
  const baseSalaryEarned = round2((Number(salaryBase) / 30) * paidDays);

  let transportAllowanceEarned = 0;
  if (hasTransportAllowance && eligibleForTransport) {
    const eligibleDays = Math.max(0, employedDays - unpaid - (Number(sickDays) || 0) - (Number(vacationDays) || 0));
    transportAllowanceEarned = round2((Number(transportMonthly) / 30) * eligibleDays);
  }
  return { periodCommercialDays, employedDays, paidDays, baseSalaryEarned, transportAllowanceEarned };
}

/**
 * Idempotencia de pagos: compara una solicitud con el pago ya registrado bajo la misma clave.
 * Devuelve { compatible, reasons[] }. Una clave solo es reutilizable para EXACTAMENTE la misma operación.
 */
function evaluatePaymentIdempotency(existing, request) {
  const reasons = [];
  if (Number(existing.payroll_item_id) !== Number(request.payroll_item_id)) reasons.push('payroll_item_id');
  if (round2(existing.amount_paid) !== round2(request.amount_paid)) reasons.push('amount_paid');
  if (String(existing.payment_method) !== String(request.payment_method)) reasons.push('payment_method');
  const reqDate = toYMD(request.payment_date);
  if (reqDate && toYMD(existing.payment_date) !== reqDate) reasons.push('payment_date');
  return { compatible: reasons.length === 0, reasons };
}

const COVERED_STATUSES = ['Consignado', 'Pagado'];

/**
 * Estimador de liquidación definitiva de retiro (contrato laboral).
 * NUNCA presume pagos previos: sin registros de soporte (benefitRecords) los periodos anteriores quedan
 * como "información faltante" y la liquidación es PROVISIONAL.
 *
 * benefitRecords: filas de pedidos_app_employee_benefit_records (o null si no se consultó):
 *   { benefit_type: CESANTIAS|INTERESES_CESANTIAS|PRIMA|VACACIONES, period_year, period_semester,
 *     status: Consignado|Pagado|Pendiente|Disfrutado|Compensado, amount, days, voided_at }
 */
function calculateSettlementEstimator({
  hireDateStr, dischargeDateStr, salaryBase,
  appliedSmmlv = 1750905, hasTransportAllowance = true, transportMonthly = 249095,
  contractType = 'Laboral - Término Indefinido', pendingDeductions = 0,
  benefitRecords = null, pendingWages = 0, lastPeriodSettledConfirmed = false
}) {
  const hire = toYMD(hireDateStr);
  const dis = toYMD(dischargeDateStr);
  if (!hire || !dis || dis < hire) {
    throw new RangeError('Fechas de ingreso/retiro inválidas.');
  }
  const salary = Number(salaryBase) || 0;
  const deductions = Number(pendingDeductions) || 0;
  const daysTotal = days360Inclusive(hire, dis);

  if (contractType === 'Prestación de Servicios') {
    return {
      contract_type: contractType, days_worked_total: daysTotal,
      days_in_current_year: 0, days_in_current_semester: 0, base_salary: salary,
      transport_allowance_included: false,
      severance_pay: 0, severance_interest: 0, service_bonus: 0, vacation_pay: 0,
      pending_wages: 0, total_deductions: deductions, net_settlement: 0,
      is_provisional: true, requires_legal_validation: true,
      missing_information: [{ concept: 'HONORARIOS_PENDIENTES', detail: 'No se calculan honorarios pendientes; verificar cuentas de cobro y pagos de seguridad social del contratista.' }],
      notes: 'Prestación de servicios: no causa prestaciones sociales laborales. La calificación real del vínculo debe validarla el asesor jurídico.'
    };
  }

  const hp = parts(hire);
  const dp = parts(dis);
  const records = Array.isArray(benefitRecords) ? benefitRecords.filter((r) => !r.voided_at) : null;
  const missing = [];
  const warnings = [];
  const recs = (type, year, semester = null) => (records || []).filter((r) =>
    r.benefit_type === type && Number(r.period_year) === year &&
    (semester === null || Number(r.period_semester) === semester));
  const sumAmount = (list) => list.reduce((a, r) => a + (Number(r.amount) || 0), 0);

  const eligibleTransport = salary <= 2 * Number(appliedSmmlv);
  const transportApplied = hasTransportAllowance && eligibleTransport ? Number(transportMonthly) : 0;
  const base = salary + transportApplied;

  // --- Año corriente: cesantías e intereses (Ley 50/1990; intereses 12 % anual, Ley 52/1975)
  const daysYear = Math.min(360, days360Inclusive(maxYMD(hire, `${dp.y}-01-01`), dis));
  const cesGross = Math.round((base * daysYear) / 360);
  const cesPaidCurrent = sumAmount(recs('CESANTIAS', dp.y).filter((r) => COVERED_STATUSES.includes(r.status)));
  const severancePay = Math.max(0, cesGross - cesPaidCurrent);
  const intGross = Math.round((cesGross * daysYear * 0.12) / 360);
  const intPaidCurrent = sumAmount(recs('INTERESES_CESANTIAS', dp.y).filter((r) => r.status === 'Pagado'));
  const severanceInterest = Math.max(0, intGross - intPaidCurrent);

  // --- Años anteriores: cesantías e intereses (nunca presumidos como pagados ni como adeudados)
  const prior = { covered: [], documented_pending: [], unknown: [] };
  let priorPendingAmount = 0;
  const classifyPrior = (type, year, semester = null, coveredStatuses = COVERED_STATUSES) => {
    const rs = recs(type, year, semester);
    const label = { concept: type, year, ...(semester ? { semester } : {}) };
    if (rs.some((r) => coveredStatuses.includes(r.status))) { prior.covered.push(label); return; }
    const pend = rs.filter((r) => r.status === 'Pendiente');
    if (pend.length) {
      const amt = sumAmount(pend);
      priorPendingAmount += amt;
      prior.documented_pending.push({ ...label, amount: amt });
      return;
    }
    prior.unknown.push(label);
    missing.push({
      ...label,
      detail: records === null
        ? 'No se consultaron registros de soporte; registre consignación/pago o saldo pendiente con evidencia.'
        : 'Sin registro de consignación/pago ni de saldo pendiente. Falta soporte (fondo/recibo) y salario devengado del periodo para calcularlo.'
    });
  };
  for (let y = hp.y; y < dp.y; y++) {
    classifyPrior('CESANTIAS', y);
    classifyPrior('INTERESES_CESANTIAS', y, null, ['Pagado']);
  }

  // --- Prima de servicios por semestre legal (1-ene/30-jun y 1-jul/31-dic)
  const semOf = (m) => (m <= 6 ? 1 : 2);
  const curSem = semOf(dp.m);
  const semStart = curSem === 1 ? `${dp.y}-01-01` : `${dp.y}-07-01`;
  const daysSemester = Math.min(180, days360Inclusive(maxYMD(hire, semStart), dis));
  const primaGross = Math.round((base * daysSemester) / 360);
  const primaPaidCurrent = sumAmount(recs('PRIMA', dp.y, curSem).filter((r) => r.status === 'Pagado'));
  const serviceBonus = Math.max(0, primaGross - primaPaidCurrent);
  for (let y = hp.y; y <= dp.y; y++) {
    for (const s of [1, 2]) {
      const before = y < dp.y || s < curSem;
      const after = y > hp.y || s >= semOf(hp.m);
      if (before && after) classifyPrior('PRIMA', y, s, ['Pagado']);
    }
  }

  // --- Vacaciones: causadas, disfrutadas, compensadas y pendientes
  const accruedDaysExact = (daysTotal * 15) / 360; // sin redondear: el pago se calcula con el dato exacto
  const accruedDays = round4(accruedDaysExact);
  const vacRecs = (records || []).filter((r) => r.benefit_type === 'VACACIONES');
  const enjoyedDays = vacRecs.filter((r) => r.status === 'Disfrutado').reduce((a, r) => a + (Number(r.days) || 0), 0);
  const compensatedDays = vacRecs.filter((r) => r.status === 'Compensado').reduce((a, r) => a + (Number(r.days) || 0), 0);
  const vacDataAvailable = vacRecs.length > 0;
  if (!vacDataAvailable) {
    missing.push({ concept: 'VACACIONES', detail: 'Sin registro de días disfrutados/compensados. Registre los días (o un registro con 0 días como confirmación) para fijar el saldo.' });
  }
  if (enjoyedDays + compensatedDays > accruedDaysExact + 0.0001) {
    warnings.push({ code: 'VACATION_DAYS_EXCEED_ACCRUED', detail: 'Días disfrutados + compensados superan los causados; revisar registros.' });
  }
  const pendingVacDaysExact = Math.max(0, accruedDaysExact - enjoyedDays - compensatedDays);
  const pendingVacDays = round4(pendingVacDaysExact);
  const vacationPay = Math.round((salary / 30) * pendingVacDaysExact);

  if (!lastPeriodSettledConfirmed) {
    missing.push({ concept: 'SALARIOS_PERIODO_EN_CURSO', detail: 'Confirmar que la nómina hasta la fecha de retiro fue calculada y pagada (o incluirla como saldo pendiente).' });
  }

  const wages = Number(pendingWages) || 0;
  const net = Math.max(0, severancePay + severanceInterest + serviceBonus + vacationPay + priorPendingAmount + wages - deductions);
  const isProvisional = missing.length > 0;

  return {
    contract_type: contractType,
    days_worked_total: daysTotal,
    days_in_current_year: daysYear,
    days_in_current_semester: daysSemester,
    base_salary: salary,
    transport_allowance_included: transportApplied > 0,
    transport_allowance_monthly: transportApplied,
    base_for_benefits: base,
    severance_pay: severancePay,
    severance_interest: severanceInterest,
    service_bonus: serviceBonus,
    vacation_pay: vacationPay,
    pending_wages: wages,
    prior_obligations_documented: priorPendingAmount,
    total_deductions: deductions,
    net_settlement: net,
    is_provisional: isProvisional,
    can_be_marked_definitive: !isProvisional,
    requires_legal_validation: true,
    current_year_detail: {
      year: dp.y, cesantias_causadas: cesGross, cesantias_ya_pagadas: cesPaidCurrent,
      intereses_causados: intGross, intereses_ya_pagados: intPaidCurrent
    },
    current_semester_detail: { year: dp.y, semester: curSem, prima_causada: primaGross, prima_ya_pagada: primaPaidCurrent },
    prior_obligations: prior,
    vacations: {
      accrued_days: accruedDays, enjoyed_days: enjoyedDays, compensated_days: compensatedDays,
      pending_days: pendingVacDays, data_available: vacDataAvailable
    },
    missing_information: missing,
    warnings,
    legal_notes: [
      'Días en base 360 (meses de 30 días; último día de febrero = 30). Validar criterio con asesor laboral.',
      'Intereses sobre cesantías: 12 % anual proporcional (Ley 52 de 1975).',
      'Descontar anticipos/préstamos de la liquidación final exige autorización escrita del trabajador (Art. 149 CST). Validar.',
      'No se modelan salario variable (promedios) ni cesantías retroactivas anteriores a Ley 50 de 1990.',
      'Esta cifra es una estimación; no sustituye revisión contable y jurídica.'
    ]
  };
}

module.exports = {
  round2, toYMD, days360Inclusive, summarizeAttendance, calculateMonthlyPeriodPay,
  evaluatePaymentIdempotency, calculateSettlementEstimator
};
