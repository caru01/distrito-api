const { createPool } = require('../src/db');
const pool = createPool();

async function run() {
  try {
    const { rows } = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    console.log(rows.map(r => r.table_name));
  } catch(e) {
    console.error('ERROR:', e.message);
  } finally {
    process.exit();
  }
}
run();
