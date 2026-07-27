require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_pClfKMJxI0a7@ep-round-lake-at22joot-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    console.log('Agregando nuevas columnas a pedidos_app_settings...');
    
    const queries = [
      // 1. Empresa
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS restaurant_name VARCHAR(255) DEFAULT 'Distrito BG';",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS phone VARCHAR(50) DEFAULT '';",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS email VARCHAR(255) DEFAULT '';",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS address TEXT DEFAULT '';",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS schedule VARCHAR(255) DEFAULT '';",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS logo TEXT DEFAULT '';",
      
      // 2. Pedidos y Domicilios
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS prep_time VARCHAR(50) DEFAULT '15-20 min';",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS min_order INTEGER DEFAULT 0;",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS delivery_cost INTEGER DEFAULT 0;",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS max_distance VARCHAR(50) DEFAULT '5 km';",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS delivery_schedule VARCHAR(255) DEFAULT '';",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS default_order_type VARCHAR(50) DEFAULT 'Domicilio';",
      
      // 3. Pagos
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS payment_efectivo BOOLEAN DEFAULT true;",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS payment_nequi BOOLEAN DEFAULT true;",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS payment_daviplata BOOLEAN DEFAULT true;",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS payment_tarjeta BOOLEAN DEFAULT true;",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS payment_transferencia BOOLEAN DEFAULT false;",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS payment_pse BOOLEAN DEFAULT false;",
      
      // 4. Redes Sociales
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS instagram VARCHAR(255) DEFAULT '';",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS facebook VARCHAR(255) DEFAULT '';",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS tiktok VARCHAR(255) DEFAULT '';",
      
      // 5. Mensaje de Bienvenida
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS welcome_message TEXT DEFAULT 'Bienvenido a Distrito BG.';",
      
      // 6. Sistema
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS currency VARCHAR(50) DEFAULT 'COP';",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS timezone VARCHAR(100) DEFAULT 'America/Bogota';",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS language VARCHAR(50) DEFAULT 'es';",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS date_format VARCHAR(50) DEFAULT 'DD/MM/YYYY';",
      "ALTER TABLE pedidos_app_settings ADD COLUMN IF NOT EXISTS time_format VARCHAR(50) DEFAULT '12h';"
    ];

    for (let query of queries) {
      await pool.query(query);
    }

    // Asegurar que exista al menos una fila con id 1
    const { rows } = await pool.query('SELECT * FROM pedidos_app_settings WHERE id = 1');
    if (rows.length === 0) {
      await pool.query('INSERT INTO pedidos_app_settings (id) VALUES (1)');
      console.log('✅ Fila de configuración inicial creada (id=1).');
    }

    console.log('✅ TABLA pedidos_app_settings ACTUALIZADA CON EXITO');
  } catch(e) {
    console.error('❌ Error:', e.message);
  } finally {
    pool.end();
  }
}
run();
