const { createPool } = require('../src/db');
const pool = createPool();
async function run() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos_app_closures (
      id SERIAL PRIMARY KEY,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status VARCHAR(20) DEFAULT 'Cerrado',
      total_sales INTEGER DEFAULT 0,
      total_costs INTEGER DEFAULT 0,
      total_expenses INTEGER DEFAULT 0,
      net_profit INTEGER DEFAULT 0,
      summary_json JSONB,
      closed_by VARCHAR(100),
      closed_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("Tabla pedidos_app_closures creada exitosamente.");
  process.exit(0);
}
run().catch(console.error);
