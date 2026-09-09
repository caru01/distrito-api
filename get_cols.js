const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function getStats() {
  const { rows } = await pool.query(
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'pedidos_app_crm_contacts'
  );
  console.log(JSON.stringify(rows.map(r => r.column_name)));
  await pool.end();
}
getStats().catch(console.error);
