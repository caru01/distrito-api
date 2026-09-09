const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("SELECT prosrc FROM pg_proc WHERE proname = 'pedidos_app_crm_refresh_contact'").then(r => { console.log(r.rows); pool.end(); });
