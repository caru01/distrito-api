const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');

const envFileName = process.env.ENV_FILE || '.env';
dotenv.config({ path: path.resolve(__dirname, '..', envFileName), override: true });

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

function validateDatabaseEnvironment(connectionString) {
  const isTestMode = process.env.NODE_ENV === 'test' || process.env.DATABASE_ENV === 'test' || process.env.ENV_FILE === '.env.test';
  try {
    const url = new URL(connectionString);
    const host = url.hostname;
    const PROD_HOST_SIGNATURE = 'ep-round-lake-at22joot';

    if (isTestMode && host.includes(PROD_HOST_SIGNATURE)) {
      console.error('\n🚨 [FATAL ERROR] DATABASE ENVIRONMENT MISMATCH!');
      console.error('El servidor está en MODO TEST pero detectó la base de datos de PRODUCCIÓN: ' + host);
      console.error('Deteniendo el proceso para proteger los datos de producción.\n');
      throw new Error('DATABASE ENVIRONMENT MISMATCH: Intento de conectar entorno de pruebas a producción.');
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

  return new Pool({
    connectionString: normalizedConnectionString(connectionString),
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000),
    ...overrides,
  });
}

module.exports = { createPool, getDatabaseUrl };
