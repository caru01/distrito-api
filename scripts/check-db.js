const { createPool } = require('../src/db');
const pool = createPool({ max: 1 });
async function check() {
  const { rows } = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'pedidos_app_inventory' AND column_name = 'id'`);
  console.log(rows);
  process.exit(0);
}
check().catch(console.error);
