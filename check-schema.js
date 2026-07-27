const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_pClfKMJxI0a7@ep-round-lake-at22joot-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});
async function run() {
  try {
    const res = await pool.query("SELECT column_default, data_type FROM information_schema.columns WHERE table_name = 'pedidos_app_products' AND column_name = 'id'");
    console.log(JSON.stringify(res.rows, null, 2));
  } finally {
    pool.end();
  }
}
run();
