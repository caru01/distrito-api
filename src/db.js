const path = require('path');
const dotenv = require('dotenv');
const { Pool, types } = require('pg');

// Garantizar que las columnas tipo DATE de PostgreSQL (oid 1082) se devuelvan como string 'YYYY-MM-DD'
// sin conversión a objeto Date de JavaScript, evitando desfases por zona horaria de servidor o cliente.
types.setTypeParser(1082, (val) => val);

const envFileName = process.env.ENV_FILE || '.env';
dotenv.config({ path: path.resolve(__dirname, '..', envFileName), override: false });

function getDatabaseUrl() {
  const isTestMode = process.env.NODE_ENV === 'test' || process.env.DATABASE_ENV === 'test' || process.env.ENV_FILE === '.env.test' || process.env.APP_ENV === 'test';
  if (isTestMode && process.env.TEST_DATABASE_URL) {
    return process.env.TEST_DATABASE_URL;
  }
  return process.env.PRODUCTION_DATABASE_URL || process.env.DATABASE_URL || process.env.VITE_NEON_URL || '';
}

function normalizedConnectionString(connectionString) {
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  return url.toString();
}

const PROD_HOST_SIGNATURES = [
  'ep-round-lake-at22joot',
  'ep-winter-darkness-b4bnsal3',
  'neon.tech',
];

function validateDatabaseEnvironment(connectionString) {
  const isTestMode = process.env.NODE_ENV === 'test' || process.env.DATABASE_ENV === 'test' || process.env.ENV_FILE === '.env.test' || process.argv.some(a => a.includes('test'));
  try {
    const url = new URL(connectionString);
    const host = url.hostname;

    if (isTestMode && PROD_HOST_SIGNATURES.some(sig => host.includes(sig)) && process.env.ALLOW_PROD_TESTS !== 'true') {
      console.error('\n🚨 [PROTECCIÓN DE PRODUCCIÓN ACTIVA]');
      console.error('Se detectó intento de ejecutar pruebas en la base de datos de PRODUCCIÓN: ' + host);
      console.error('Para proteger la numeración consecutiva de pedidos reales, use: npm run test:contracts\n');
      throw new Error('DATABASE ENVIRONMENT MISMATCH: Bloqueado para proteger el consecutivo de pedidos de producción.');
    }
  } catch (e) {
    if (e.message.includes('MISMATCH')) throw e;
  }
}

function createPool(overrides = {}) {
  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    throw new Error('DATABASE_URL no está configurada.');
  }

  validateDatabaseEnvironment(connectionString);

  const pool = new Pool({
    connectionString: normalizedConnectionString(connectionString),
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000),
    ...overrides,
  });

  pool.on('error', (err) => {
    console.error('⚠️ [Neon DB Pool Error]:', err?.message || err);
  });

  return pool;
}

module.exports = { createPool, getDatabaseUrl };
