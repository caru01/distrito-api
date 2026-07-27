require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.VITE_NEON_URL,
  ssl: { rejectUnauthorized: false }
});

async function fixTimezones() {
  try {
    console.log('Fixing timezones in DB...');
    // orders
    await pool.query(`
      ALTER TABLE pedidos_app_orders 
      ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
    `);
    
    // Si queremos arreglar otras tablas también
    await pool.query(`
      ALTER TABLE pedidos_app_announcements 
      ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
    `).catch(e => console.log('announcements table might not have this col or already fixed'));

    console.log('Timezones fixed successfully.');
  } catch (error) {
    console.error('Error fixing timezones:', error);
  } finally {
    pool.end();
  }
}

fixTimezones();
