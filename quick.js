const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function check() {
  const r = await pool.query("SELECT available_at, NOW() as current_time FROM pedidos_app_crm_message_jobs WHERE campaign_recipient_id IN (SELECT id FROM pedidos_app_crm_campaign_recipients WHERE campaign_id=47 AND contact_id IN (785, 774, 1239, 820, 818, 1501, 880)) LIMIT 1");
  console.log(r.rows);
  pool.end();
}
check();
