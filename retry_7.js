const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function retry7() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const contactIds = [785, 774, 1239, 820, 818, 1501, 880];
    
    // 1. Fetch recipient & message IDs
    const recs = await client.query(`
      SELECT r.id as recipient_id, r.message_id, j.id as job_id
      FROM pedidos_app_crm_campaign_recipients r
      JOIN pedidos_app_crm_message_jobs j ON j.campaign_recipient_id = r.id
      WHERE r.campaign_id = 47 AND r.contact_id = ANY($1::int[])
    `, [contactIds]);

    if (recs.rows.length !== 7) {
      throw new Error(`Expected 7 recipients, found ${recs.rows.length}`);
    }

    const messageIds = recs.rows.map(r => r.message_id);
    const jobIds = recs.rows.map(r => r.job_id);
    const recipientIds = recs.rows.map(r => r.recipient_id);

    console.log(`Reseteando ${messageIds.length} mensajes...`);
    await client.query(`
      UPDATE pedidos_app_crm_messages
      SET status = 'QUEUED',
          provider_message_id = NULL,
          error_code = NULL,
          error_message = NULL,
          failed_at = NULL,
          sent_at = NULL,
          delivered_at = NULL,
          read_at = NULL
      WHERE id = ANY($1::bigint[])
    `, [messageIds]);

    console.log(`Reseteando ${jobIds.length} jobs...`);
    await client.query(`
      UPDATE pedidos_app_crm_message_jobs
      SET status = 'PENDING',
          attempts = 0,
          last_error_code = NULL,
          last_error_message = NULL,
          completed_at = NULL,
          available_at = NOW(),
          updated_at = NOW()
      WHERE id = ANY($1::bigint[])
    `, [jobIds]);

    console.log(`Reseteando ${recipientIds.length} destinatarios...`);
    await client.query(`
      UPDATE pedidos_app_crm_campaign_recipients
      SET status = 'QUEUED',
          updated_at = NOW()
      WHERE id = ANY($1::bigint[])
    `, [recipientIds]);

    console.log(`Reanudando campaña 47...`);
    await client.query(`
      UPDATE pedidos_app_crm_campaigns
      SET status = 'RUNNING', completed_at = NULL, updated_at = NOW()
      WHERE id = 47
    `);

    await client.query('COMMIT');
    console.log('--- REINTENTO INICIADO ---');
    console.log('Esperando 15 segundos a que el worker despache los 7 mensajes...');
    await new Promise(r => setTimeout(r, 15000));
    
    console.log('\n--- AUDITORIA SOLO LECTURA POST-REINTENTO ---');
    
    // Check results
    const results = await client.query(`
      SELECT 
        c.id as contact_id,
        c.normalized_phone,
        c.bsuid,
        m.provider_message_id,
        m.status as message_status,
        m.error_code,
        j.status as job_status,
        r.status as recipient_status
      FROM pedidos_app_crm_campaign_recipients r
      JOIN pedidos_app_crm_contacts c ON c.id = r.contact_id
      JOIN pedidos_app_crm_messages m ON m.id = r.message_id
      JOIN pedidos_app_crm_message_jobs j ON j.campaign_recipient_id = r.id
      WHERE r.campaign_id = 47 AND c.id = ANY($1::int[])
    `, [contactIds]);
    
    console.log(JSON.stringify(results.rows, null, 2));

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR:', err.message);
  } finally {
    client.release();
    pool.end();
  }
}
retry7();
