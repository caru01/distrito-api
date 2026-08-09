const { createPool } = require('../src/db');
const pool = createPool();
async function run() {
  try {
    console.log('Fixing UUID default for pedidos_app_products.id...');
    await pool.query('ALTER TABLE pedidos_app_products ALTER COLUMN id SET DEFAULT gen_random_uuid();');
    console.log('Fixed!');
  } catch(e) {
    console.error('Error:', e);
  } finally {
    pool.end();
  }
}
run();
