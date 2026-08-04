const { createPool } = require('../src/db');
const pool = createPool({ max: 1 });
async function run() {
  try {
    const res = await pool.query("SELECT column_default, data_type FROM information_schema.columns WHERE table_name = 'pedidos_app_products' AND column_name = 'id'");
    console.log(JSON.stringify(res.rows, null, 2));
  } finally {
    pool.end();
  }
}
run();
