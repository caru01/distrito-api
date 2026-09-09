const { Pool } = require('pg');
require('dotenv').config();
const fs = require('fs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function runMig() {
  const sql = fs.readFileSync('migrations/024_orders_bsuid_support.sql', 'utf8');
  await pool.query(sql);
  console.log('Migration executed successfully.');
  await pool.end();
}
runMig().catch(e => { console.error(e); process.exit(1); });
