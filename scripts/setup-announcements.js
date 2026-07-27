require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.VITE_NEON_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function setupAnnouncements() {
  try {
    console.log('Creando tabla de anuncios...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_app_announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        image_url TEXT NOT NULL,
        is_active BOOLEAN DEFAULT false,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Insert a default announcement if table is empty
    const { rowCount } = await pool.query('SELECT * FROM pedidos_app_announcements');
    if (rowCount === 0) {
      console.log('Insertando anuncio por defecto...');
      await pool.query(`
        INSERT INTO pedidos_app_announcements (title, image_url, is_active)
        VALUES ('¡Gran Promoción Distrito!', 'https://images.unsplash.com/photo-1550547660-d9450f859349?auto=format&fit=crop&q=80&w=800', false)
      `);
    }

    console.log('Tabla pedidos_app_announcements lista.');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    pool.end();
  }
}

setupAnnouncements();
