require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function runMigration() {
  try {
    console.log('Adding reset_token columns to pedidos_app_users...');
    await pool.query(`
      ALTER TABLE pedidos_app_users 
      ADD COLUMN IF NOT EXISTS reset_token VARCHAR(255),
      ADD COLUMN IF NOT EXISTS reset_token_expiry TIMESTAMP;
    `);
    console.log('Migration successful.');
  } catch (err) {
    console.error('Error during migration:', err);
  } finally {
    await pool.end();
  }
}

runMigration();
