const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function getDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.VITE_NEON_URL || '';
}

function normalizedConnectionString(connectionString) {
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  return url.toString();
}

function createPool(overrides = {}) {
  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    throw new Error('DATABASE_URL no está configurada.');
  }

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
