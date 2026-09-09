const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function reactivateCampaign() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('--- PASO 1: VALIDACION ---');
    const s1 = await client.query('SELECT status, count(*) as count FROM pedidos_app_crm_campaign_recipients WHERE campaign_id = 47 GROUP BY status');
    console.log('Estados iniciales:', s1.rows);

    const targets = await client.query('SELECT r.id FROM pedidos_app_crm_campaign_recipients r LEFT JOIN pedidos_app_crm_messages m ON m.id = r.message_id WHERE r.campaign_id = 47 AND r.status = \'FAILED\' AND r.provider_message_id IS NULL AND (m.provider_message_id IS NULL OR r.message_id IS NULL)');
    const targetIds = targets.rows.map(r => r.id);
    console.log('Objetivos a reactivar (FAILED sin provider_message_id):', targetIds.length);

    const failed = await client.query('SELECT count(*) FROM pedidos_app_crm_campaign_recipients WHERE campaign_id = 47 AND status = \'FAILED\'');
    console.log('Otros FAILED (con provider_message_id):', failed.rows[0].count - targetIds.length);

    if (targetIds.length !== 109) throw new Error('Abortando, objetivos no son 109.');

    console.log('\n--- PASO 2: REACTIVACION ---');
    const upd = await client.query('UPDATE pedidos_app_crm_campaign_recipients SET status = \'QUEUED\', updated_at = NOW() WHERE id = ANY($1::int[]) RETURNING id', [targetIds]);
    console.log('Filas actualizadas:', upd.rows.length);
    if (upd.rows.length !== 109) throw new Error('Abortando, update no afecto 109 filas.');

    console.log('\n--- PASO 3: VALIDACION POST-UPDATE ---');
    const s2 = await client.query('SELECT status, count(*) as count FROM pedidos_app_crm_campaign_recipients WHERE campaign_id = 47 GROUP BY status');
    console.log('Estados finales:', s2.rows);

    const chk = await client.query('SELECT count(*) FROM pedidos_app_crm_campaign_recipients r LEFT JOIN pedidos_app_crm_messages m ON m.id = r.message_id WHERE r.campaign_id = 47 AND r.status = \'QUEUED\' AND (r.provider_message_id IS NOT NULL OR m.provider_message_id IS NOT NULL)');
    console.log('QUEUED con provider_message_id (debe ser 0):', chk.rows[0].count);

    const tot = await client.query('SELECT count(*) FROM pedidos_app_crm_campaign_recipients WHERE campaign_id = 47');
    console.log('Total destinatarios (debe ser 171):', tot.rows[0].count);

    await client.query('COMMIT');
    console.log('\nReactivacion lista!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR:', err.message);
  } finally {
    client.release();
    pool.end();
  }
}
reactivateCampaign();
