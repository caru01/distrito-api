const { createPool } = require('../src/db');

async function analyzeDatabase() {
  const pool = createPool({ max: 1 });
  try {
    await pool.query('VACUUM (ANALYZE) pedidos_app_orders');
    await pool.query('VACUUM (ANALYZE) pedidos_app_products');
    await pool.query('VACUUM (ANALYZE) pedidos_app_inventory_lots');
    await pool.query('VACUUM (ANALYZE) pedidos_app_inventory_movements');
    console.log('✓ Estadísticas y espacio reutilizable actualizados.');
  } finally {
    await pool.end();
  }
}

analyzeDatabase().catch((error) => {
  console.error('Error actualizando estadísticas:', error.message);
  process.exitCode = 1;
});
