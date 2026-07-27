require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.VITE_NEON_URL,
  ssl: { rejectUnauthorized: false }
});

async function fixOldOrders() {
  try {
    console.log('Arreglando completed_at en pedidos viejos...');
    
    // Set completed_at to created_at + 30 minutes for all orders that are already 'Entregado' but have no completed_at
    const result = await pool.query(`
      UPDATE pedidos_app_orders 
      SET completed_at = created_at + interval '30 minutes'
      WHERE status = 'Entregado' AND completed_at IS NULL
    `);
    
    console.log(`Se arreglaron ${result.rowCount} pedidos viejos.`);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    pool.end();
  }
}

fixOldOrders();
