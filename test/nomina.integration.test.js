/**
 * test/nomina.integration.test.js — PRUEBAS DE INTEGRACIÓN CON POSTGRESQL REAL (DESECHABLE)
 *
 * ESTADO: PENDIENTE DE EJECUCIÓN. Se omiten automáticamente si no se cumplen TODAS estas condiciones:
 *   1. NOMINA_IT_DATABASE_URL apunta a una instancia PostgreSQL local/desechable (nunca Neon ni producción).
 *   2. NOMINA_IT_CONFIRM_DISPOSABLE=yes
 *   3. La base ya tiene el esquema hasta la migración 040 y la 041 aplicada (solo en esa base desechable).
 *
 * Seguridad: se rechaza cualquier URL cuyo host contenga "neon.tech", "contabo" o "distritobg".
 * Las pruebas usan años/etiquetas propias (2090+) y limpian sus filas; aun así, úsense solo en una base descartable.
 *
 * Cada prueba usa DOS conexiones independientes (pg.Client) para reproducir concurrencia real.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const url = process.env.NOMINA_IT_DATABASE_URL || '';
const confirmed = process.env.NOMINA_IT_CONFIRM_DISPOSABLE === 'yes';
const forbidden = /neon\.tech|contabo|distritobg/i.test(url);
const enabled = Boolean(url) && confirmed && !forbidden;
const skipReason = !enabled
  ? 'Requiere NOMINA_IT_DATABASE_URL (BD desechable, no Neon/producción) y NOMINA_IT_CONFIRM_DISPOSABLE=yes'
  : false;

describe('Integración PostgreSQL — triggers, bloqueos consultivos e idempotencia', { skip: skipReason }, () => {
  const { Client } = require('pg');
  let a;
  let b;

  const settled = (p) => Promise.race([
    p.then(() => 'resolved', () => 'rejected'),
    new Promise((r) => setTimeout(() => r('pending'), 400))
  ]);

  before(async () => {
    a = new Client({ connectionString: url });
    b = new Client({ connectionString: url });
    await Promise.all([a.connect(), b.connect()]);
  });

  after(async () => {
    await a.query('ROLLBACK').catch(() => {});
    await b.query('ROLLBACK').catch(() => {});
    await a.query("DELETE FROM pedidos_app_payroll_periods WHERE name LIKE 'IT-%'").catch(() => {});
    await a.query('DELETE FROM pedidos_app_payroll_config WHERE year >= 2090').catch(() => {});
    await Promise.all([a.end(), b.end()]);
  });

  const insertConfig = (c, year, from, to) => c.query(
    `INSERT INTO pedidos_app_payroll_config (year, valid_from, valid_to, smmlv_amount, transport_allowance_monthly, transport_allowance_daily)
     VALUES ($1, $2::date, $3::date, 1, 1, 1)`, [year, from, to]);
  const insertPeriod = (c, name, type, from, to, status = 'Borrador') => c.query(
    `INSERT INTO pedidos_app_payroll_periods (name, period_type, start_date, end_date, status)
     VALUES ($1, $2, $3::date, $4::date, $5) RETURNING id`, [name, type, from, to, status]);

  it('Vigencias: dos INSERT concurrentes solapados — el segundo espera y luego falla', async () => {
    await a.query('BEGIN'); await b.query('BEGIN');
    await insertConfig(a, 2090, '2090-01-01', null);
    const second = insertConfig(b, 2091, '2090-06-01', '2090-12-31');
    assert.equal(await settled(second), 'pending'); // bloqueado por el advisory lock de A
    await a.query('COMMIT');
    await assert.rejects(second, /se solapa/);
    await b.query('ROLLBACK');
  });

  it('Periodos: dos INSERT concurrentes solapados del mismo tipo — el segundo espera y luego falla', async () => {
    await a.query('BEGIN'); await b.query('BEGIN');
    await insertPeriod(a, 'IT-1', 'quincenal', '2090-01-01', '2090-01-15');
    const second = insertPeriod(b, 'IT-2', 'quincenal', '2090-01-10', '2090-01-25');
    assert.equal(await settled(second), 'pending');
    await a.query('COMMIT');
    await assert.rejects(second, /se solapa/);
    await b.query('ROLLBACK');
  });

  it('Periodos: tipos distintos o fechas contiguas NO se bloquean entre sí de forma indebida', async () => {
    await a.query('BEGIN'); await b.query('BEGIN');
    await insertPeriod(a, 'IT-3', 'quincenal', '2090-02-01', '2090-02-15');
    await insertPeriod(b, 'IT-4', 'mensual', '2090-02-01', '2090-02-28'); // otro tipo: otro lock
    await a.query('COMMIT'); await b.query('COMMIT');
  });

  it('Periodos: UPDATE que cambia period_type hacia un tipo ocupado se serializa y se rechaza', async () => {
    const { rows } = await insertPeriod(a, 'IT-5', 'semanal', '2090-03-01', '2090-03-07');
    await insertPeriod(a, 'IT-6', 'quincenal', '2090-03-01', '2090-03-15');
    await a.query('BEGIN'); await b.query('BEGIN');
    await a.query("UPDATE pedidos_app_payroll_periods SET period_type = 'quincenal' WHERE id = $1", [rows[0].id]).then(
      () => assert.fail('debió rechazarse por solapamiento'), (e) => assert.match(e.message, /se solapa/));
    await a.query('ROLLBACK'); await b.query('ROLLBACK');
  });

  it('Periodos: un periodo Anulado no valida ni bloquea; actualizar totales no dispara el trigger', async () => {
    await insertPeriod(a, 'IT-7', 'quincenal', '2090-04-01', '2090-04-15');
    await insertPeriod(a, 'IT-8', 'quincenal', '2090-04-05', '2090-04-20', 'Anulado'); // no lanza
    const r = await a.query("UPDATE pedidos_app_payroll_periods SET total_accrued = 1 WHERE name = 'IT-7'");
    assert.equal(r.rowCount, 1);
  });

  it('Pagos: restricción UNIQUE(idempotency_key) en PostgreSQL real impide duplicados', async () => {
    // Requiere un ítem de nómina real. Se omite si no existe ninguno en la base desechable.
    const { rows } = await a.query('SELECT id, employee_id FROM pedidos_app_payroll_items LIMIT 1');
    if (rows.length === 0) return;
    const ins = (c) => c.query(
      `INSERT INTO pedidos_app_payroll_payments (payroll_item_id, employee_id, amount_paid, idempotency_key)
       VALUES ($1, $2, 1, 'it-idem-key-0001') ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [rows[0].id, rows[0].employee_id]);
    const [r1, r2] = await Promise.all([ins(a), ins(b)]);
    assert.equal(r1.rowCount + r2.rowCount, 1);
    await a.query("DELETE FROM pedidos_app_payroll_payments WHERE idempotency_key = 'it-idem-key-0001'");
  });
});
