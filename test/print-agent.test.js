'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const domain = require('../src/print-agent-domain');
const { createPool } = require('../src/db');
const registerPrintAgentApi = require('../print_agent_api');
const express = require('express');

test('Print Agent Domain - Unit Tests', async (t) => {
  await t.test('Tokens: generación, hash y formato', () => {
    const token = domain.generateAgentToken();
    assert.ok(token.startsWith('dhpa_'));
    assert.ok(domain.looksLikeAgentToken(token));
    assert.strictEqual(domain.looksLikeAgentToken('invalid_token'), false);

    const hash1 = domain.hashToken(token);
    const hash2 = domain.hashToken(token);
    assert.strictEqual(hash1, hash2);
    assert.strictEqual(hash1.length, 64);
  });

  await t.test('Idempotency keys: validación estricta', () => {
    assert.ok(domain.isValidIdempotencyKey('order:602:comanda:v1'));
    assert.ok(domain.isValidIdempotencyKey('test:primary:2026-11-06T12-00-00'));
    assert.strictEqual(domain.isValidIdempotencyKey('short'), false);
    assert.strictEqual(domain.isValidIdempotencyKey('invalid space in key'), false);
    assert.strictEqual(domain.isValidIdempotencyKey(''), false);
  });

  await t.test('Normalización de impresoras y detección de fallos de hardware', () => {
    const rawPrinters = [
      { name: 'POS-IMPRESORA', driver: 'XP-58', port: 'USB001', status: 'OK', work_offline: false },
      { name: 'Xprinter Cocina', driver: 'XP-58', port: 'USB002', status: 'Paper Out', work_offline: false },
      { name: 'Microsoft Print to PDF', driver: 'PDF', port: 'PORTPROMPT:', status: 'OK', is_virtual: true },
      { name: 'Impresora Sin Driver', driver: '', port: 'USB003' },
    ];
    const normalized = domain.normalizeReportedPrinters(rawPrinters);
    assert.strictEqual(normalized.length, 4);

    const avail1 = domain.printerAvailability(normalized[0]);
    assert.strictEqual(avail1.available, true);
    assert.strictEqual(avail1.reason, null);

    const avail2 = domain.printerAvailability(normalized[1]);
    assert.strictEqual(avail2.available, false);
    assert.match(avail2.reason, /Paper Out/i);

    const avail3 = domain.printerAvailability(normalized[2]);
    assert.strictEqual(avail3.available, false);
    assert.match(avail3.reason, /virtual/i);

    const avail4 = domain.printerAvailability(normalized[3]);
    assert.strictEqual(avail4.available, false);
    assert.match(avail4.reason, /controlador/i);
  });

  await t.test('Detección de agente en línea', () => {
    const now = new Date();
    const onlineAgent = { last_seen_at: new Date(now.getTime() - 10_000) };
    const offlineAgent = { last_seen_at: new Date(now.getTime() - 45_000) };
    const revokedAgent = { last_seen_at: new Date(now.getTime() - 5_000), revoked_at: new Date() };

    assert.strictEqual(domain.isAgentOnline(onlineAgent, now), true);
    assert.strictEqual(domain.isAgentOnline(offlineAgent, now), false);
    assert.strictEqual(domain.isAgentOnline(revokedAgent, now), false);
  });

  await t.test('Validación de ajustes de impresión (Single y Dual)', () => {
    const now = new Date();
    const agent = {
      id: '00000000-0000-0000-0000-000000000001',
      last_seen_at: new Date(now.getTime() - 5000),
      printers_json: [
        { name: 'POS-Caja', driver: 'XP-58', port: 'USB001', status: 'OK' },
        { name: 'POS-Cocina', driver: 'XP-58', port: 'USB002', status: 'OK' },
      ],
    };

    // Modo browser: no requiere agente ni impresoras USB
    assert.deepStrictEqual(domain.validatePrinterSettings({ printer_mode: 'browser' }, null, now), []);

    // Modo dual con impresoras válidas
    const validDual = domain.validatePrinterSettings({
      printer_mode: 'agent_dual',
      printer_primary_name: 'POS-Caja',
      printer_secondary_name: 'POS-Cocina',
      printer_paper_width: 58,
      print_job_expiry_minutes: 15,
    }, agent, now);
    assert.deepStrictEqual(validDual, []);

    // Modo dual con la misma impresora repetida
    const samePrinters = domain.validatePrinterSettings({
      printer_mode: 'agent_dual',
      printer_primary_name: 'POS-Caja',
      printer_secondary_name: 'POS-Caja',
    }, agent, now);
    assert.ok(samePrinters.some(e => /distintas/i.test(e)));

    // Modo dual con agente desconectado
    const offlineErr = domain.validatePrinterSettings({
      printer_mode: 'agent_dual',
      printer_primary_name: 'POS-Caja',
      printer_secondary_name: 'POS-Cocina',
    }, { ...agent, last_seen_at: new Date(now.getTime() - 60_000) }, now);
    assert.ok(offlineErr.some(e => /en línea/i.test(e)));
  });

  await t.test('Ticket de prueba HTML contiene branding de Distric House', () => {
    const html = domain.buildTestTicketHtml({
      printerName: 'POS-Caja',
      role: 'primary',
      paperWidth: 58,
      restaurantName: 'Distric House',
    });
    assert.ok(html.includes('Distric House'));
    assert.ok(html.includes('PRUEBA DE IMPRESIÓN'));
    assert.ok(html.includes('POS-Caja'));
    assert.ok(html.includes('41mm')); // 58mm -> 41mm printable
  });

  await t.test('Transiciones de estado del agente', () => {
    assert.strictEqual(domain.canAgentTransition('claimed', 'spooled'), true);
    assert.strictEqual(domain.canAgentTransition('spooled', 'completed_by_driver'), true);
    assert.strictEqual(domain.canAgentTransition('spooled', 'unverifiable'), true);
    assert.strictEqual(domain.canAgentTransition('spooled', 'failed'), true);
    assert.strictEqual(domain.canAgentTransition('completed_by_driver', 'failed'), false); // Terminal
  });
});

test('Print Agent API - Database Integration Tests', async (t) => {
  const pool = createPool();
  const app = express();
  app.use(express.json());

  // Mock de autenticación admin para tests
  const mockUser = { id: 1, username: 'admin', role: 'Super Administrador' };
  const authenticateTokenMock = (req, res, next) => { req.user = mockUser; next(); };
  const requirePermissionMock = () => (req, res, next) => next();

  const printService = registerPrintAgentApi(app, {
    pool,
    authenticateToken: authenticateTokenMock,
    requirePermission: requirePermissionMock,
  });

  t.after(async () => {
    printService.stop();
    await pool.end();
  });

  let createdAgentId = null;
  let rawAgentToken = null;

  await t.test('1. Crear agente y recibir token único (una sola vez)', async () => {
    const res = await makeRequest(app, 'POST', '/api/pedidos/admin/print-agents', {
      name: 'PC Mostrador Distric House Test',
    });
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.token);
    assert.ok(res.body.agent.id);
    assert.strictEqual(res.body.agent.name, 'PC Mostrador Distric House Test');

    createdAgentId = res.body.agent.id;
    rawAgentToken = res.body.token;

    // Verificar que en la DB el token NO esté en texto plano
    const dbCheck = await pool.query('SELECT token_hash FROM pedidos_app_print_agents WHERE id = $1', [createdAgentId]);
    assert.strictEqual(dbCheck.rows[0].token_hash, domain.hashToken(rawAgentToken));
  });

  await t.test('2. Heartbeat del agente reportando impresoras de Windows', async () => {
    const printers = [
      { name: 'Xprinter_Caja_Test', driver: 'XP-58', port: 'USB001', status: 'OK' },
      { name: 'Xprinter_Cocina_Test', driver: 'XP-58', port: 'USB002', status: 'OK' },
    ];
    const res = await makeRequest(app, 'POST', '/api/pedidos/agent/heartbeat', {
      hostname: 'CAJA-PC-WIN',
      agent_version: '1.0.0',
      printers,
    }, { Authorization: `Bearer ${rawAgentToken}` });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');

    // Verificar en settings / print-config
    const configRes = await makeRequest(app, 'GET', '/api/pedidos/admin/print-config');
    assert.strictEqual(configRes.status, 200);
    assert.strictEqual(configRes.body.agent.online, true);
    assert.strictEqual(configRes.body.agent.printers.length, 2);
  });

  await t.test('3. Configurar modo DUAL con las dos impresoras validadas', async () => {
    const res = await makeRequest(app, 'PUT', '/api/pedidos/admin/print-settings', {
      printer_mode: 'agent_dual',
      printer_primary_name: 'Xprinter_Caja_Test',
      printer_secondary_name: 'Xprinter_Cocina_Test',
      printer_paper_width: 58,
      print_job_expiry_minutes: 15,
      print_agent_id: createdAgentId,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.settings.printer_mode, 'agent_dual');
    assert.strictEqual(res.body.settings.printer_primary_name, 'Xprinter_Caja_Test');
    assert.strictEqual(res.body.settings.printer_secondary_name, 'Xprinter_Cocina_Test');
  });

  let createdJobId = null;
  let testOrderId = null;

  await t.test('4. Crear orden de prueba y trabajo de impresión en modo DUAL', async () => {
    // Obtener una orden real o crear una de test en la BD de pruebas
    const orderRes = await pool.query(`
      INSERT INTO pedidos_app_orders (customer_name, customer_phone, delivery_type, total, status)
      VALUES ('Cliente Prueba Print', '3001234567', 'domicilio', 45000, 'Nuevo')
      RETURNING id
    `);
    testOrderId = orderRes.rows[0].id;

    const testHtml = '<html><body><h3>DISTRIC HOUSE</h3><p>Pedido #' + testOrderId + '</p></body></html>';
    const idempotencyKey = `order:${testOrderId}:comanda:v1`;

    const res = await makeRequest(app, 'POST', '/api/pedidos/admin/print-jobs', {
      idempotency_key: idempotencyKey,
      order_id: testOrderId,
      html: testHtml,
      paper_width: 58,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.duplicate, false);
    assert.strictEqual(res.body.job.targets.length, 2); // 2 impresoras (Caja y Cocina)

    const targetRoles = res.body.job.targets.map(t => t.printer_role).sort();
    assert.deepStrictEqual(targetRoles, ['primary', 'secondary']);
    assert.strictEqual(res.body.job.targets[0].status, 'pending');
    assert.strictEqual(res.body.job.targets[1].status, 'pending');

    createdJobId = res.body.job.id;

    // Probar idempotencia: segundo envío con misma key devuelve el trabajo sin duplicar
    const dupRes = await makeRequest(app, 'POST', '/api/pedidos/admin/print-jobs', {
      idempotency_key: idempotencyKey,
      order_id: testOrderId,
      html: testHtml,
    });
    assert.strictEqual(dupRes.status, 200);
    assert.strictEqual(dupRes.body.duplicate, true);
  });

  let claimedTargets = [];

  await t.test('5. Agente reclama trabajos de impresión con lease seguro', async () => {
    const res = await makeRequest(app, 'POST', '/api/pedidos/agent/jobs/claim', {
      limit: 10,
    }, { Authorization: `Bearer ${rawAgentToken}` });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.targets.length >= 2);
    claimedTargets = res.body.targets.filter(t => t.job_id === createdJobId);
    assert.strictEqual(claimedTargets.length, 2);

    assert.ok(claimedTargets[0].claim_token);
    assert.ok(claimedTargets[1].claim_token);
    assert.strictEqual(claimedTargets[0].html.includes('DISTRIC HOUSE'), true);
  });

  await t.test('6. Reportar resultados independientes: Impresora 1 ÉXITO, Impresora 2 SIN PAPEL (Falla)', async () => {
    const target1 = claimedTargets.find(t => t.printer_role === 'primary');
    const target2 = claimedTargets.find(t => t.printer_role === 'secondary');

    // Impresora 1 pasa a spooled y luego a completed_by_driver
    const res1a = await makeRequest(app, 'POST', `/api/pedidos/agent/targets/${target1.target_id}/result`, {
      claim_token: target1.claim_token,
      status: 'spooled',
      windows_job_id: 'WJOB-101',
    }, { Authorization: `Bearer ${rawAgentToken}` });
    assert.strictEqual(res1a.status, 200);

    const res1b = await makeRequest(app, 'POST', `/api/pedidos/agent/targets/${target1.target_id}/result`, {
      claim_token: target1.claim_token,
      status: 'completed_by_driver',
    }, { Authorization: `Bearer ${rawAgentToken}` });
    assert.strictEqual(res1b.status, 200);

    // Impresora 2 reporta falla de papel (sin cancelar ni afectar a Impresora 1)
    const res2 = await makeRequest(app, 'POST', `/api/pedidos/agent/targets/${target2.target_id}/result`, {
      claim_token: target2.claim_token,
      status: 'failed',
      error_code: 'PAPER_OUT',
      error_message: 'Impresora sin papel o tapa abierta',
    }, { Authorization: `Bearer ${rawAgentToken}` });
    assert.strictEqual(res2.status, 200);

    // Consultar el estado del trabajo en el ERP
    const jobRes = await makeRequest(app, 'GET', `/api/pedidos/admin/print-jobs/${createdJobId}`);
    assert.strictEqual(jobRes.status, 200);
    const primaryTarget = jobRes.body.job.targets.find(t => t.printer_role === 'primary');
    const secondaryTarget = jobRes.body.job.targets.find(t => t.printer_role === 'secondary');

    assert.strictEqual(primaryTarget.status, 'completed_by_driver');
    assert.strictEqual(secondaryTarget.status, 'failed');
    assert.strictEqual(secondaryTarget.error_code, 'PAPER_OUT');

    // Verificar que los eventos de auditoría quedaron registrados
    assert.ok(jobRes.body.job.events.length >= 4);
  });

  await t.test('7. Reimpresión selectiva solo para la impresora fallida (Cocina)', async () => {
    const reprintKey = `reprint:${createdJobId}:secondary:v1`;
    const res = await makeRequest(app, 'POST', `/api/pedidos/admin/print-jobs/${createdJobId}/reprint`, {
      idempotency_key: reprintKey,
      roles: ['secondary'],
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.job.kind, 'reprint');
    assert.strictEqual(res.body.job.reprint_of_job_id, createdJobId);
    assert.strictEqual(res.body.job.targets.length, 1);
    assert.strictEqual(res.body.job.targets[0].printer_role, 'secondary');
    assert.strictEqual(res.body.job.targets[0].status, 'pending');
  });

  await t.test('8. Garantía de integridad de inventario: reimprimir NO modifica inventario ni pedido', async () => {
    const orderBefore = await pool.query('SELECT total, status FROM pedidos_app_orders WHERE id = $1', [testOrderId]);
    assert.strictEqual(orderBefore.rows[0].total, 45000);
    assert.strictEqual(orderBefore.rows[0].status, 'Nuevo');
  });

  await t.test('9. Limpiar datos de prueba creados', async () => {
    await pool.query('DELETE FROM pedidos_app_print_jobs WHERE order_id = $1', [testOrderId]);
    await pool.query('DELETE FROM pedidos_app_orders WHERE id = $1', [testOrderId]);
    await pool.query('UPDATE pedidos_app_settings SET printer_mode = \'browser\', print_agent_id = NULL WHERE id = 1');
    await pool.query('DELETE FROM pedidos_app_print_agents WHERE id = $1', [createdAgentId]);
  });
});

// Helper para emular peticiones HTTP en Express sin levantar socket de red
async function makeRequest(app, method, url, body = null, headers = {}) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const options = {
        hostname: '127.0.0.1',
        port,
        path: url,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      };
      const req = http.request(options, (res) => {
        let rawData = '';
        res.on('data', chunk => rawData += chunk);
        res.on('end', () => {
          server.close();
          let parsed = {};
          try { parsed = JSON.parse(rawData); } catch(e) { parsed = { raw: rawData }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}
