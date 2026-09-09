const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'pedidos_app_orders'::regclass").then(r => { console.log(r.rows); pool.end(); });
