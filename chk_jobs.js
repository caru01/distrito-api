const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function checkJobs() {
  const contactIds = [785, 774, 1239, 820, 818, 1501, 880];
  const r = await pool.query(`
    SELECT c.id, c.normalized_phone, c.bsuid, j.payload 
    FROM pedidos_app_crm_campaign_recipients r 
    JOIN pedidos_app_crm_message_jobs j ON j.campaign_recipient_id = r.id
    JOIN pedidos_app_crm_contacts c ON c.id = r.contact_id
    WHERE r.campaign_id = 47 AND c.id = ANY($1::int[])
  `, [contactIds]);
  console.log(JSON.stringify(r.rows, null, 2));
  pool.end();
}
checkJobs();
