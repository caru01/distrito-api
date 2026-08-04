const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  try {
    const { rows } = await pool.query(`
      SELECT id, customer_name, customer_phone, address, barrio, delivery_type,
             payment_method, total, status, source, notes, cart_json,
             voucher_reference, created_at, updated_at, delivered_at,
             delivery_user_id, delivery_status, delivery_fee, delivery_reference,
             delivery_latitude, delivery_longitude, delivery_place_id,
             delivery_location_adjusted, delivery_apartment, delivery_tower, delivery_floor,
             change_required, delivery_accepted_at, picked_up_at, on_the_way_at,
             delivery_completed_at, delivery_distance_km, delivery_duration_seconds
      FROM pedidos_app_orders
      ORDER BY created_at DESC
      LIMIT 1
    `);
    console.log('Success!', rows[0]);
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    pool.end();
  }
}

main();
