const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function checkSchema() {
  try {
    const res = await pool.query(`
      SELECT table_name, column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name IN ('pedidos_app_users', 'pedidos_app_roles', 'pedidos_app_audit', 'pedidos_app_sessions')
      ORDER BY table_name, ordinal_position;
    `);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch(e) { 
    console.error(e); 
  } finally { 
    pool.end(); 
  }
}

checkSchema();
