const { createPool } = require('../src/db');
const pool = createPool();
async function run() {
  try {
    const res = await pool.query("SELECT trigger_name, event_manipulation, event_object_table, action_statement FROM information_schema.triggers WHERE event_object_table = 'pedidos_app_orders'");
    console.log(JSON.stringify(res.rows, null, 2));
  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
run();
