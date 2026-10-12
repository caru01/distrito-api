const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  try {
    const query = `
      SELECT 
        item->>'title' AS product_name,
        SUM((item->>'quantity')::int) AS total_sold,
        SUM((item->>'price')::numeric * (item->>'quantity')::int) AS total_revenue
      FROM pedidos_app_orders o,
      jsonb_array_elements(o.cart_json::jsonb) AS item
      WHERE (o.created_at AT TIME ZONE 'America/Bogota')::date >= '2026-10-04' 
        AND (o.created_at AT TIME ZONE 'America/Bogota')::date <= '2026-10-06'
        AND o.status IN ('Entregado', 'Completado', 'Pendiente') -- Adjusting to include standard success statuses. Usually Entregado/Completado.
      GROUP BY item->>'title'
      ORDER BY total_sold DESC;
    `;
    const res = await pool.query(query);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch(e) { 
    console.error(e); 
  } finally { 
    pool.end(); 
  }
}
run();
