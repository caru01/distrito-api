require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.VITE_NEON_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    console.log('1. Querying orders...');
    await pool.query("SELECT * FROM pedidos_app_orders WHERE DATE(created_at) >= '2026-07-01' AND DATE(created_at) <= '2026-07-31' AND status IN ('Entregado', 'Listo', 'Completado')");
    
    console.log('2. Querying recipes...');
    await pool.query("SELECT r.product_id, r.cantidad_usada, r.costo_calculado, ren.ingrediente_name FROM pedidos_app_recipes r JOIN pedidos_app_rendimientos ren ON r.rendimiento_id = ren.id");
    
    console.log('3. Querying expenses...');
    await pool.query("SELECT * FROM pedidos_app_expenses WHERE expense_date >= '2026-07-01' AND expense_date <= '2026-07-31'");
    
    console.log('4. Querying inventory...');
    await pool.query("SELECT i.name AS ingrediente_name, COALESCE(i.consumption_unit, i.unit) AS unidad_consumo, COALESCE(SUM(l.available_quantity), 0) AS cantidad, COALESCE(SUM(l.available_quantity * l.unit_cost), 0) AS valor FROM pedidos_app_inventory i LEFT JOIN pedidos_app_inventory_lots l ON l.inventory_id = i.id AND l.branch_id = 1 AND l.status = 'Disponible' GROUP BY i.id, i.name, i.consumption_unit, i.unit");
    
    console.log('All queries passed successfully.');
  } catch(e) {
    console.error('ERROR:', e.message);
  } finally {
    process.exit();
  }
}

run();
