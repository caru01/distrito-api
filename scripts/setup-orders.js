require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_pClfKMJxI0a7@ep-round-lake-at22joot-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    console.log('Creando tabla de ordenes y usuarios en Neon...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_app_products (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        price INTEGER NOT NULL,
        category VARCHAR(100),
        image TEXT
      );
      
      ALTER TABLE pedidos_app_products ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Activo';
      ALTER TABLE pedidos_app_products ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT false;
      ALTER TABLE pedidos_app_products ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT NULL;

      CREATE TABLE IF NOT EXISTS pedidos_app_orders (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(255),
        customer_phone VARCHAR(50),
        address TEXT,
        barrio VARCHAR(255),
        delivery_type VARCHAR(50),
        payment_method VARCHAR(50),
        total INTEGER,
        cart_json JSONB,
        status VARCHAR(50) DEFAULT 'Nuevo',
        source VARCHAR(50) DEFAULT 'Web',
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      );
      
      -- Agregar columnas si la tabla ya existía
      ALTER TABLE pedidos_app_orders ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Nuevo';
      ALTER TABLE pedidos_app_orders ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'Web';
      ALTER TABLE pedidos_app_orders ADD COLUMN IF NOT EXISTS notes TEXT;
      CREATE TABLE IF NOT EXISTS pedidos_app_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS pedidos_app_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        description TEXT,
        image TEXT,
        status VARCHAR(20) DEFAULT 'Activa',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    const bcrypt = require('bcryptjs');
    const { rows: userCount } = await pool.query('SELECT COUNT(*) FROM pedidos_app_users');
    if (parseInt(userCount[0].count) === 0) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash('Distrito2026*', salt);
      await pool.query('INSERT INTO pedidos_app_users (username, password_hash, role) VALUES ($1, $2, $3)', ['admin', hashedPassword, 'admin']);
      console.log('✅ USUARIO ADMIN CREADO POR DEFECTO');
    }
    
    console.log('✅ TABLAS CREADAS CON EXITO');
  } catch(e) {
    console.error('❌ Error:', e.message);
  } finally {
    pool.end();
  }
}
run();
