const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const contactIds = [785, 774, 1239, 820, 818, 1501, 880];

async function forceSend() {
  const client = await pool.connect();
  try {
    // Temporarily open the window to 08:00
    await client.query("UPDATE pedidos_app_settings SET crm_campaign_start_time = '08:00:00'");
    
    // Wake up the jobs immediately
    await client.query(`
      UPDATE pedidos_app_crm_message_jobs 
      SET status = 'PENDING', available_at = NOW()
      WHERE campaign_recipient_id IN (
        SELECT id FROM pedidos_app_crm_campaign_recipients WHERE campaign_id=47 AND contact_id = ANY($1::int[])
      )
    `, [contactIds]);

    console.log("Esperando 20 segundos para procesar...");
    await new Promise(r => setTimeout(r, 20000));
    
    // Restore the window to 09:00
    await client.query("UPDATE pedidos_app_settings SET crm_campaign_start_time = '09:00:00'");

    // Wait another 15 seconds for webhooks
    console.log("Esperando 15 segundos para webhooks...");
    await new Promise(r => setTimeout(r, 15000));

    // Audit
    const results = await client.query(`
      SELECT 
        c.id as contact_id,
        c.normalized_phone,
        c.bsuid,
        m.provider_message_id,
        m.status as message_status,
        m.error_code,
        m.error_message,
        j.status as job_status,
        r.status as recipient_status,
        j.last_error_code
      FROM pedidos_app_crm_campaign_recipients r
      JOIN pedidos_app_crm_contacts c ON c.id = r.contact_id
      JOIN pedidos_app_crm_messages m ON m.id = r.message_id
      JOIN pedidos_app_crm_message_jobs j ON j.campaign_recipient_id = r.id
      WHERE r.campaign_id = 47 AND c.id = ANY($1::int[])
    `, [contactIds]);
    
    console.log(JSON.stringify(results.rows, null, 2));

    const provIds = results.rows.map(x=>x.provider_message_id).filter(Boolean);
    if (provIds.length > 0) {
      const wh = await client.query(`
        SELECT 
          payload->'whatsappMessage'->>'id' as prov_id, 
          payload->'whatsappMessage'->>'status' as status, 
          payload->'whatsappMessage'->>'errorCode' as error_code,
          payload->'whatsappMessage'->>'errorMessage' as error_message 
        FROM pedidos_app_crm_webhook_events 
        WHERE payload->'whatsappMessage'->>'id' = ANY($1::text[])
        ORDER BY created_at DESC
      `, [provIds]);
      console.log('Webhooks:', wh.rows);
    }
  } finally {
    client.release();
    pool.end();
  }
}
forceSend();
