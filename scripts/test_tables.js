require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.VITE_NEON_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const { rows } = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    console.log(rows.map(r => r.table_name));
  } catch(e) {
    console.error('ERROR:', e.message);
  } finally {
    process.exit();
  }
}
run();
