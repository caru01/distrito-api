require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.VITE_NEON_URL,
  ssl: { rejectUnauthorized: false }
});

async function setLocalTime() {
  try {
    console.log('Configurando la base de datos a hora de Colombia...');
    
    // 1. Cambiar la zona horaria por defecto de la base de datos a Colombia
    await pool.query(`ALTER DATABASE neondb SET timezone TO 'America/Bogota';`);
    
    // 2. Convertir TIMESTAMPTZ de vuelta a TIMESTAMP (sin zona horaria)
    // Usamos AT TIME ZONE 'America/Bogota' para que los registros UTC existentes
    // se transformen físicamente a la hora local de Colombia en el almacenamiento.
    await pool.query(`
      ALTER TABLE pedidos_app_orders 
      ALTER COLUMN created_at TYPE TIMESTAMP USING created_at AT TIME ZONE 'America/Bogota';
    `);

    try {
      await pool.query(`
        ALTER TABLE pedidos_app_announcements 
        ALTER COLUMN updated_at TYPE TIMESTAMP USING updated_at AT TIME ZONE 'America/Bogota';
      `);
    } catch (e) {
      console.log('announcements no actualizado (opcional)');
    }

    console.log('¡Base de datos actualizada a hora local!');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    pool.end();
  }
}

setLocalTime();
