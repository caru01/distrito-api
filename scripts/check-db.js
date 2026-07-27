const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://neondb_owner:n8WqR9DkLIGv@ep-rapid-math-a54lssn6.us-east-2.aws.neon.tech/neondb?sslmode=require' });
async function check() {
  const { rows } = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'pedidos_app_inventory' AND column_name = 'id'`);
  console.log(rows);
  process.exit(0);
}
check().catch(console.error);
