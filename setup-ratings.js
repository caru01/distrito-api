require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.VITE_NEON_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function setupRatings() {
  try {
    console.log('Añadiendo columnas de calificación a pedidos_app_products...');
    await pool.query(`
      ALTER TABLE pedidos_app_products 
      ADD COLUMN IF NOT EXISTS rating_sum INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS rating_count INTEGER DEFAULT 0;
    `);
    
    console.log('Columnas de calificación listas.');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    pool.end();
  }
}

setupRatings();
