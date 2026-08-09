const { createPool } = require('../src/db');
const pool = createPool();

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
