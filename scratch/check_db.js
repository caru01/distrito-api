require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
async function check() {
  const tzInfo = await pool.query(`
    SELECT table_name, column_name 
    FROM information_schema.columns 
    WHERE data_type = 'timestamp without time zone' AND table_schema = 'public';
  `);
  console.log('Columns to alter:', tzInfo.rows);
  
  for (const row of tzInfo.rows) {
    console.log(`Altering ${row.table_name}.${row.column_name}...`);
    await pool.query(`ALTER TABLE "${row.table_name}" ALTER COLUMN "${row.column_name}" TYPE timestamp with time zone USING "${row.column_name}" AT TIME ZONE 'America/Bogota';`);
  }
  console.log('Done!');
  pool.end();
}
check();
