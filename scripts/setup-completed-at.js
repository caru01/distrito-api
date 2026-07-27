require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.VITE_NEON_URL,
  ssl: { rejectUnauthorized: false }
});

async function addCompletedAt() {
  try {
    console.log('Añadiendo completed_at...');
    await pool.query(`
      ALTER TABLE pedidos_app_orders 
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
    `);
    console.log('Listo!');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    pool.end();
  }
}

addCompletedAt();
