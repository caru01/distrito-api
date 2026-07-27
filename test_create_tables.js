require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.VITE_NEON_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    console.log('Creating table pedidos_app_inventory_lots...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_app_inventory_lots (
        id BIGSERIAL PRIMARY KEY,
        inventory_id UUID NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE RESTRICT,
        purchase_item_id INTEGER,
        branch_id INTEGER NOT NULL DEFAULT 1,
        lot_code VARCHAR(100) NOT NULL,
        source_quantity NUMERIC(14,4) NOT NULL,
        source_unit VARCHAR(50),
        initial_quantity NUMERIC(14,4) NOT NULL CHECK (initial_quantity > 0),
        available_quantity NUMERIC(14,4) NOT NULL CHECK (available_quantity >= 0),
        unit_cost NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
        expiration_date DATE,
        status VARCHAR(20) NOT NULL DEFAULT 'Disponible',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (branch_id, lot_code)
      );
    `);
    
    console.log('Creating table pedidos_app_inventory_movements...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_app_inventory_movements (
        id BIGSERIAL PRIMARY KEY,
        inventory_id UUID NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE RESTRICT,
        lot_id BIGINT REFERENCES pedidos_app_inventory_lots(id) ON DELETE RESTRICT,
        branch_id INTEGER NOT NULL DEFAULT 1,
        movement_type VARCHAR(30) NOT NULL,
        quantity NUMERIC(14,4) NOT NULL,
        unit_cost NUMERIC(14,4),
        balance_after NUMERIC(14,4) NOT NULL,
        reference_type VARCHAR(50),
        reference_id VARCHAR(50),
        notes TEXT,
        created_by VARCHAR(50),
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    
    console.log('Creating table pedidos_app_order_inventory_consumptions...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_app_order_inventory_consumptions (
        id BIGSERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES pedidos_app_orders(id) ON DELETE RESTRICT,
        inventory_id UUID NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE RESTRICT,
        lot_id BIGINT NOT NULL REFERENCES pedidos_app_inventory_lots(id) ON DELETE RESTRICT,
        movement_id BIGINT REFERENCES pedidos_app_inventory_movements(id) ON DELETE RESTRICT,
        quantity NUMERIC(14,4) NOT NULL CHECK (quantity > 0),
        unit_cost NUMERIC(14,4) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        reversed_at TIMESTAMP
      );
    `);
    
    console.log('All tables created successfully.');
  } catch(e) {
    console.error('ERROR:', e.message);
  } finally {
    process.exit();
  }
}
run();
