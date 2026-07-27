require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function test() {
  try {
    console.log("Connecting to database...");
    const { rows } = await pool.query("SELECT * FROM pedidos_app_products");
    console.log("Products found:", rows.length);
    if (rows.length > 0) {
      console.log(rows[0]);
    } else {
      console.log("The table exists but is EMPTY!");
    }
  } catch (e) {
    console.error("Query Error:", e.message);
  } finally {
    pool.end();
  }
}

test();
