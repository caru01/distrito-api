const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createPool } = require('../src/db');

const migrationsDirectory = path.resolve(__dirname, '..', 'migrations');

function checksum(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

async function migrate() {
  const pool = createPool({ max: 1 });
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pedidos_app_schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = fs.readdirSync(migrationsDirectory)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['distrito-api-migrations']);
    try {
      for (const file of files) {
        const sql = fs.readFileSync(path.join(migrationsDirectory, file), 'utf8');
        const currentChecksum = checksum(sql);
        const { rows } = await client.query(
          'SELECT checksum FROM pedidos_app_schema_migrations WHERE name = $1',
          [file]
        );

        if (rows.length) {
          if (rows[0].checksum !== currentChecksum) {
            throw new Error(`La migración aplicada ${file} fue modificada.`);
          }
          console.log(`↷ ${file} ya aplicada`);
          continue;
        }

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO pedidos_app_schema_migrations (name, checksum) VALUES ($1, $2)',
            [file, currentChecksum]
          );
          await client.query('COMMIT');
          console.log(`✓ ${file}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['distrito-api-migrations']);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error('Error aplicando migraciones:', error.message);
  process.exitCode = 1;
});
