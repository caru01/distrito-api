const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const supertest = require('supertest');

const {
  httpError,
  isClientError,
  redactSensitiveText,
  sendInternalError,
} = require('../src/http-errors');

const registerHorarios = require('../horarios_api');
const registerInventoryAdvanced = require('../inventory_advanced_api');
const registerAiApi = require('../src/ai_api');
const registerRappiApi = require('../rappi_api');
const registerExternalDeliveryApi = require('../external_delivery_api');
const registerDeliveryApi = require('../delivery_api');
const registerCrmApi = require('../crm_api');
const registerNominaApi = require('../nomina_api');
const registerPrintAgentApi = require('../print_agent_api');

const SQL_LEAK_TOKEN = 'secret_db_token_99123';
const FAKE_SQL_MESSAGE = `syntax error at or near "FROM pedidos_app_orders" column "customer_phone" postgres://postgres:SuperSecretPass@db.internal:5432/distrito Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def AIzaSyFakeGoogleKey1234567890123456 ${SQL_LEAK_TOKEN}`;

function assertNoSqlOrSecretLeak(resBody, rawText = '') {
  const serialized = `${JSON.stringify(resBody || {})} ${rawText}`;
  const forbiddenFragments = [
    'SELECT ',
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'FROM ',
    'pedidos_app_',
    'syntax error',
    'relation "',
    'column "',
    'postgres://',
    'SuperSecretPass',
    'Bearer ',
    'eyJhbGciOi',
    'AIzaSy',
    SQL_LEAK_TOKEN,
    'at Object.<anonymous>',
  ];
  for (const frag of forbiddenFragments) {
    assert.equal(
      serialized.includes(frag),
      false,
      `La respuesta HTTP filtró fragmento prohibido "${frag}": ${serialized}`
    );
  }
}

function makeSqlFailurePool({ code = '42P01', duplicateOnQueryMatch = null } = {}) {
  const makeErr = () => {
    const err = new Error(FAKE_SQL_MESSAGE);
    err.code = code;
    return err;
  };
  const makeClient = () => ({
    async query(sql) {
      const normalized = String(sql || '').trim().toUpperCase();
      if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (duplicateOnQueryMatch && normalized.includes(duplicateOnQueryMatch)) {
        const dup = new Error('duplicate key value violates unique constraint "pedidos_app_unique_idx"');
        dup.code = '23505';
        throw dup;
      }
      throw makeErr();
    },
    release() {},
  });
  return {
    async query(sql) {
      return makeClient().query(sql);
    },
    async connect() {
      return makeClient();
    },
  };
}

const passAuth = (req, _res, next) => {
  req.user = { id: 1, username: 'admin_test', role: 'Administrador' };
  next();
};
const allowPerm = () => (_req, _res, next) => next();

test('http-errors: redactSensitiveText oculta DSNs, JWT, Bearer, passwords y claves API', () => {
  const redacted = redactSensitiveText(
    'Failed connecting postgres://user:pass123@host:5432/db token=abc999 password=mysecret Bearer eyJ123.456.789 AIzaSyAbcdefghijklmnopqrstuvwxyz123456'
  );
  assert.equal(redacted.includes('pass123'), false);
  assert.equal(redacted.includes('mysecret'), false);
  assert.equal(redacted.includes('abc999'), false);
  assert.equal(redacted.includes('eyJ123'), false);
  assert.equal(redacted.includes('AIzaSy'), false);
  assert.ok(redacted.includes('[REDACTED]'));
});

test('http-errors: sendInternalError preserva 4xx, sanitiza 500, redacta logs y respeta headersSent', () => {
  const capturedLogs = [];
  const origError = console.error;
  console.error = (...args) => capturedLogs.push(args.join(' '));

  try {
    // 1. Error 4xx explícito
    let status4xx = null;
    let body4xx = null;
    const res4xx = {
      headersSent: false,
      status(code) { status4xx = code; return this; },
      json(payload) { body4xx = payload; return this; },
    };
    sendInternalError(res4xx, httpError(400, 'Dato inválido del usuario', { code: 'BAD_INPUT' }));
    assert.equal(status4xx, 400);
    assert.equal(body4xx.error, 'Dato inválido del usuario');
    assert.equal(body4xx.code, 'BAD_INPUT');

    // 2. Error PostgreSQL sin statusCode -> 500 genérico + log redactado
    let status500 = null;
    let body500 = null;
    const res500 = {
      headersSent: false,
      status(code) { status500 = code; return this; },
      json(payload) { body500 = payload; return this; },
    };
    const pgErr = new Error(FAKE_SQL_MESSAGE);
    pgErr.code = '42P01';
    sendInternalError(res500, pgErr, 'Mensaje seguro genérico', { component: 'unit-test' });
    assert.equal(status500, 500);
    assert.equal(body500.error, 'Mensaje seguro genérico');
    assertNoSqlOrSecretLeak(body500);
    assert.equal(capturedLogs.length, 1);
    assert.equal(capturedLogs[0].includes('SuperSecretPass'), false);
    assert.equal(capturedLogs[0].includes('eyJhbGciOi'), false);

    // 3. Error con statusCode 502 no se clasifica como 4xx ni se filtra
    assert.equal(isClientError({ statusCode: 500 }), false);
    assert.equal(isClientError({ statusCode: 502 }), false);
    assert.equal(isClientError({ statusCode: 404 }), true);

    // 4. Respeta headersSent sin intentar escribir segunda respuesta
    let called = false;
    sendInternalError(
      { headersSent: true, status() { called = true; return this; }, json() { called = true; } },
      new Error('late error')
    );
    assert.equal(called, false);
  } finally {
    console.error = origError;
  }
});

test('Routers sanitizan errores SQL 500 y conservan errores funcionales 4xx en todos los módulos auditados', async () => {
  const origError = console.error;
  const capturedLogs = [];
  console.error = (...args) => capturedLogs.push(args.join(' '));

  const app = express();
  app.use(express.json());

  const failPool = makeSqlFailurePool({ duplicateOnQueryMatch: 'DELIVERY_DRIVERS' });

  registerHorarios(app, failPool, passAuth);
  registerInventoryAdvanced(app, { pool: failPool, authenticateToken: passAuth });
  registerAiApi(app, { pool: failPool, authenticateToken: passAuth, requirePermission: allowPerm });
  registerRappiApi(app, { pool: failPool, authenticateToken: passAuth, deliveryOrderService: {} });
  registerExternalDeliveryApi(app, {
    pool: failPool,
    whatsappClient: {},
    authenticateToken: passAuth,
    requirePermission: allowPerm,
  });
  registerDeliveryApi(app, {
    pool: failPool,
    authenticateToken: passAuth,
    requirePermission: allowPerm,
    trackingLimiter: (_req, _res, next) => next(),
    webpush: {},
    publicVapidKey: 'test',
    minPasswordLength: 8,
    authorizeTrackingAccess: () => true,
    trackingSecret: 'test',
    deliveryOrderService: {},
    publishEphemeral: () => {},
    whatsappClient: {},
  });
  registerCrmApi(app, {
    pool: failPool,
    authenticateToken: passAuth,
    requirePermission: allowPerm,
    whatsappClient: {},
    processWebhookEvent: async () => {},
    markOrderSent: async () => {},
    verifyWebhookSignature: () => true,
  });
  registerNominaApi(app, {
    pool: failPool,
    authenticateToken: passAuth,
    requirePermission: allowPerm,
    logActivity: async () => {},
  });
  const printCtrl = registerPrintAgentApi(app, {
    pool: failPool,
    authenticateToken: passAuth,
    requirePermission: allowPerm,
  });

  const request = supertest(app);

  try {
    // 1. horarios_api.js -> 500 genérico + 400 validación
    const hor500 = await request.get('/api/pedidos/admin/horarios');
    assert.equal(hor500.status, 500);
    assertNoSqlOrSecretLeak(hor500.body, hor500.text);

    const hor400 = await request.put('/api/pedidos/admin/horarios').send({ schedules: 'invalid' });
    assert.equal(hor400.status, 400);
    assert.ok(hor400.body.error);

    // 2. inventory_advanced_api.js -> 500 genérico (incluso donde antes devolvía 400) + 400 funcional
    const invGet = await request.get('/api/pedidos/admin/suppliers');
    assert.equal(invGet.status, 500);
    assertNoSqlOrSecretLeak(invGet.body, invGet.text);

    const invProduceSqlErr = await request
      .post('/api/pedidos/admin/production/produce')
      .send({ target_inventory_id: 1, quantity_produced: 5 });
    assert.equal(invProduceSqlErr.status, 500);
    assertNoSqlOrSecretLeak(invProduceSqlErr.body, invProduceSqlErr.text);

    const invProduceValidation = await request
      .post('/api/pedidos/admin/production/produce')
      .send({ target_inventory_id: 1, quantity_produced: 0 });
    assert.equal(invProduceValidation.status, 400);
    assert.equal(invProduceValidation.body.error, 'La cantidad producida debe ser mayor a 0');

    // 3. src/ai_api.js -> 500 genérico en GET overview + validation 400 sin fuga
    const aiOverview = await request.get('/api/pedidos/admin/ai/overview');
    assert.equal(aiOverview.status, 500);
    assertNoSqlOrSecretLeak(aiOverview.body, aiOverview.text);

    // 4. rappi_api.js -> 500 genérico en config / logs / webhook + 400 credencial faltante si aplica
    const rappiCfg = await request.get('/api/pedidos/admin/rappi/config');
    assert.equal(rappiCfg.status, 500);
    assertNoSqlOrSecretLeak(rappiCfg.body, rappiCfg.text);

    const rappiSim = await request.post('/api/pedidos/admin/rappi/simulate-order').send({});
    assert.equal(rappiSim.status, 500);
    assertNoSqlOrSecretLeak(rappiSim.body, rappiSim.text);

    // 5. external_delivery_api.js -> 500 genérico + 400 validación
    const extCompanies = await request.get('/api/pedidos/admin/delivery-companies');
    assert.equal(extCompanies.status, 500);
    assertNoSqlOrSecretLeak(extCompanies.body, extCompanies.text);

    const extDriverBad = await request.post('/api/pedidos/admin/delivery-companies/1/drivers').send({ name: '' });
    assert.equal(extDriverBad.status, 400);

    // 6. crm_api.js -> regresión respondError con error PostgreSQL (code 42P01): NO debe filtrar error.message
    const crmDash = await request.get('/api/pedidos/admin/crm/dashboard');
    assert.equal(crmDash.status, 500);
    assertNoSqlOrSecretLeak(crmDash.body, crmDash.text);
    assert.equal(crmDash.body.error, 'No fue posible procesar la operación CRM.');
    assert.equal(crmDash.body.code, 'CRM_INTERNAL_ERROR');

    // 7. nomina_api.js -> 500 genérico
    const nomCfg = await request.get('/api/pedidos/admin/nomina/config');
    assert.equal(nomCfg.status, 500);
    assertNoSqlOrSecretLeak(nomCfg.body, nomCfg.text);

    // 8. print_agent_api.js -> 500 genérico
    const printCfg = await request.get('/api/pedidos/admin/print-config');
    assert.equal(printCfg.status, 500);
    assertNoSqlOrSecretLeak(printCfg.body, printCfg.text);

    // 8b. delivery_api.js -> 500 genérico en notify-driver + 400 ID inválido
    const notify500 = await request.post('/api/pedidos/admin/delivery/orders/1/notify-driver').send({});
    assert.equal(notify500.status, 500);
    assertNoSqlOrSecretLeak(notify500.body, notify500.text);
    const notify400 = await request.post('/api/pedidos/admin/delivery/orders/invalid/notify-driver').send({});
    assert.equal(notify400.status, 400);

    // 9. Verificar que los logs internos nunca registraron credenciales ni tokens en claro
    const allLogs = capturedLogs.join('\n');
    assert.equal(allLogs.includes('SuperSecretPass'), false);
    assert.equal(allLogs.includes('eyJhbGciOi'), false);
    assert.equal(allLogs.includes('AIzaSyFakeGoogleKey'), false);
  } finally {
    printCtrl?.stop?.();
    console.error = origError;
  }
});

test('Contrato estático: ningún endpoint HTTP devuelve err.message o error.message en respuestas 500 ni catch(400) crudo', () => {
  const apiDir = path.resolve(__dirname, '..');
  const targets = [
    'server.js',
    'horarios_api.js',
    'rappi_api.js',
    'inventory_advanced_api.js',
    'src/ai_api.js',
    'external_delivery_api.js',
    'delivery_api.js',
    'crm_api.js',
    'nomina_api.js',
    'print_agent_api.js',
    'customer_auth_api.js',
  ];

  for (const rel of targets) {
    const full = path.join(apiDir, rel);
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/res\.status\(500\)\.json\([^)]*\b(err|error)\.message\b/.test(line)) {
        assert.fail(`Fuga directa 500 en ${rel}:${i + 1}: ${line.trim()}`);
      }
      if (/res\.status\(error\.code\s*===\s*['"]23505['"]\s*\?\s*409\s*:\s*500\)\.json\([^)]*\.message/.test(line)) {
        assert.fail(`Fuga condicional 23505/500 en ${rel}:${i + 1}: ${line.trim()}`);
      }
      if (/res\.status\((error|err)\.statusCode\s*\|\|\s*500\)\.json\([^)]*\b(err|error)\.message\b/.test(line)) {
        const surrounding = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join(' ');
        if (!/isClientError|clientError|KNOWN_AI_CODES/.test(surrounding)) {
          assert.fail(`Fuga statusCode||500 sin guardia 4xx en ${rel}:${i + 1}: ${line.trim()}`);
        }
      }
    }
  }
});
