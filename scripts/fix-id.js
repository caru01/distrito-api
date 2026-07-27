const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_pClfKMJxI0a7@ep-round-lake-at22joot-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});
async function run() {
  try {
    console.log('Fixing UUID default for pedidos_app_products.id...');
    await pool.query('ALTER TABLE pedidos_app_products ALTER COLUMN id SET DEFAULT gen_random_uuid();');
    console.log('Fixed!');
  } catch(e) {
    console.error('Error:', e);
  } finally {
    pool.end();
  }
}
run();
