const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const contactIds = [785, 774, 1239, 820, 818, 1501, 880];

async function run() {
  while(true) {
    const res = await pool.query(`SELECT COUNT(*) as pending FROM pedidos_app_crm_message_jobs j JOIN pedidos_app_crm_campaign_recipients r ON r.id = j.campaign_recipient_id WHERE r.campaign_id = 47 AND r.contact_id = ANY($1::int[]) AND j.status != 'COMPLETED'`, [contactIds]);
    if (res.rows[0].pending === '0') break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  
  // Wait another 15s to allow webhooks to arrive
  await new Promise(resolve => setTimeout(resolve, 15000));

  const results = await pool.query(`
    SELECT 
      c.id as contact_id,
      c.normalized_phone,
      c.bsuid,
      m.provider_message_id,
      m.status as message_status,
      m.error_code,
      m.error_message,
      j.status as job_status,
      r.status as recipient_status
    FROM pedidos_app_crm_campaign_recipients r
    JOIN pedidos_app_crm_contacts c ON c.id = r.contact_id
    JOIN pedidos_app_crm_messages m ON m.id = r.message_id
    JOIN pedidos_app_crm_message_jobs j ON j.campaign_recipient_id = r.id
    WHERE r.campaign_id = 47 AND c.id = ANY($1::int[])
  `, [contactIds]);
  console.log(JSON.stringify(results.rows, null, 2));

  // get latest webhook for these messages just in case
  const provIds = results.rows.map(x=>x.provider_message_id).filter(Boolean);
  if (provIds.length > 0) {
     const wh = await pool.query(`
       SELECT payload->'whatsappMessage'->>'id' as prov_id, payload->'whatsappMessage'->>'status' as status, payload->'whatsappMessage'->>'errorCode' as error_code 
       FROM pedidos_app_crm_webhook_events 
       WHERE payload->'whatsappMessage'->>'id' = ANY($1::text[])
     `, [provIds]);
     console.log('Webhooks:', wh.rows);
  }
  pool.end();
}
run();
