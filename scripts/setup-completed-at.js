const { createPool } = require('../src/db');
const pool = createPool();

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
