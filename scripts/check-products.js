require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query('SELECT title, status FROM pedidos_app_products LIMIT 5').then(res => { console.log(res.rows); process.exit(0); });
