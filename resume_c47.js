const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function resumeCampaign() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Resume Campaign
    console.log('--- REANUDANDO CAMPAÑA ---');
    const updateRes = await client.query(`
      UPDATE pedidos_app_crm_campaigns 
      SET status = 'RUNNING', completed_at = NULL, updated_at = NOW()
      WHERE id = 47
      RETURNING status
    `);
    
    console.log('Campaña actualizada a:', updateRes.rows[0].status);
    
    await client.query('COMMIT');
    console.log('\nEsperando 20 segundos a que el worker procese los PENDING y RETRY...');
    await new Promise(r => setTimeout(r, 20000));
    
    console.log('\n--- AUDITORIA SOLO LECTURA ---');
    const camp = await pool.query("SELECT status FROM pedidos_app_crm_campaigns WHERE id = 47");
    console.log('Estado de campaña:', camp.rows[0].status);

    const jobs = await pool.query(`
      SELECT j.status, COUNT(*) as count
      FROM pedidos_app_crm_message_jobs j
      JOIN pedidos_app_crm_campaign_recipients r ON r.id = j.campaign_recipient_id
      WHERE r.campaign_id = 47
      GROUP BY j.status
    `);
    console.log('Jobs (Campaña 47):', jobs.rows);

    const recs = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM pedidos_app_crm_campaign_recipients
      WHERE campaign_id = 47
      GROUP BY status
    `);
    console.log('Destinatarios (Campaña 47):', recs.rows);
    
    const errors = await pool.query(`
      SELECT error_code, error_message, count(*) as count 
      FROM pedidos_app_crm_message_jobs 
      WHERE status = 'FAILED' 
        AND created_at >= NOW() - INTERVAL '1 hour'
      GROUP BY error_code, error_message
    `);
    console.log('Nuevos errores (ultima hora):', errors.rows);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR:', err.message);
  } finally {
    client.release();
    pool.end();
  }
}

resumeCampaign();
