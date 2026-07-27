require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_pClfKMJxI0a7@ep-round-lake-at22joot-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    console.log('⏳ Creando tablas de Inventario...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_app_inventory (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        image TEXT,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(50) DEFAULT 'Ingrediente',
        category VARCHAR(100),
        unit VARCHAR(50),
        stock FLOAT DEFAULT 0,
        min_stock FLOAT DEFAULT 0,
        expiry_date DATE,
        unit_cost INTEGER DEFAULT 0,
        supplier VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS pedidos_app_inventory_movements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        inventory_id UUID REFERENCES pedidos_app_inventory(id) ON DELETE CASCADE,
        movement_type VARCHAR(20) NOT NULL, -- IN, OUT, ADJUST
        quantity FLOAT NOT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('✅ Tablas de inventario creadas con éxito!');

  } catch (error) {
    console.error('❌ Error creando las tablas:', error);
  } finally {
    pool.end();
  }
}

run();
