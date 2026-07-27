require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_pClfKMJxI0a7@ep-round-lake-at22joot-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    console.log('⏳ Creando tablas de Compras...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_app_purchases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice_number VARCHAR(100),
        supplier VARCHAR(255),
        purchase_date DATE,
        total_amount INTEGER DEFAULT 0,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS pedidos_app_purchase_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        purchase_id UUID REFERENCES pedidos_app_purchases(id) ON DELETE CASCADE,
        inventory_id UUID REFERENCES pedidos_app_inventory(id) ON DELETE CASCADE,
        quantity FLOAT NOT NULL,
        unit_cost INTEGER NOT NULL,
        total_cost INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('✅ Tablas de compras creadas con éxito!');

  } catch (error) {
    console.error('❌ Error creando las tablas:', error);
  } finally {
    pool.end();
  }
}

run();
