require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.VITE_NEON_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const { rows } = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'pedidos_app_inventory'");
    console.log(rows);
  } catch(e) {
    console.error('ERROR:', e.message);
  } finally {
    process.exit();
  }
}
run();
