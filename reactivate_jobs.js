const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function reactivateJobs() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    console.log('--- PASO 1: VALIDACION ---');
    // Fetch target job IDs based on strict constraints
    const targetsRes = await client.query(`
      SELECT j.id 
      FROM pedidos_app_crm_message_jobs j
      JOIN pedidos_app_crm_campaign_recipients r ON r.id = j.campaign_recipient_id
      JOIN pedidos_app_crm_messages m ON m.id = j.message_id
      WHERE r.campaign_id = 47
        AND r.status = 'QUEUED'
        AND j.status = 'FAILED'
        AND m.provider_message_id IS NULL
        AND r.provider_message_id IS NULL
    `);
    const targetJobIds = targetsRes.rows.map(row => row.id);
    console.log('Jobs objetivo encontrados:', targetJobIds.length);
    
    if (targetJobIds.length !== 109) {
      throw new Error(`ABORTANDO: La cantidad de jobs no es 109, es ${targetJobIds.length}`);
    }

    console.log('\n--- PASO 2: REACTIVACION ---');
    const updateRes = await client.query(`
      UPDATE pedidos_app_crm_message_jobs 
      SET status = 'PENDING', updated_at = NOW()
      WHERE id = ANY($1::int[])
      RETURNING id
    `, [targetJobIds]);
    
    console.log('Jobs actualizados a PENDING:', updateRes.rows.length);
    if (updateRes.rows.length !== 109) {
      throw new Error(`ABORTANDO: Se actualizaron ${updateRes.rows.length} jobs en vez de 109`);
    }

    console.log('\n--- PASO 3: VALIDACION POST-UPDATE ---');
    const jobsDist = await client.query(`
      SELECT j.status, COUNT(*) as count
      FROM pedidos_app_crm_message_jobs j
      JOIN pedidos_app_crm_campaign_recipients r ON r.id = j.campaign_recipient_id
      WHERE r.campaign_id = 47
      GROUP BY j.status
    `);
    console.log('Jobs (Campaña 47):', jobsDist.rows);

    const recDist = await client.query(`
      SELECT status, COUNT(*) as count
      FROM pedidos_app_crm_campaign_recipients
      WHERE campaign_id = 47
      GROUP BY status
    `);
    console.log('Destinatarios (Campaña 47):', recDist.rows);

    await client.query('COMMIT');
    console.log('\n¡Update de jobs exitoso!');
    
    // Esperar a que el worker procese algunos
    console.log('\nEsperando 15 segundos para que el worker empiece a procesar...');
    await new Promise(r => setTimeout(r, 15000));
    
    console.log('\n--- AUDITORIA DE SEGUIMIENTO ---');
    const jobsTrack = await client.query(`
      SELECT j.status, COUNT(*) as count
      FROM pedidos_app_crm_message_jobs j
      JOIN pedidos_app_crm_campaign_recipients r ON r.id = j.campaign_recipient_id
      WHERE r.campaign_id = 47
      GROUP BY j.status
    `);
    console.log('Jobs (Seguimiento):', jobsTrack.rows);

    const recTrack = await client.query(`
      SELECT status, COUNT(*) as count
      FROM pedidos_app_crm_campaign_recipients
      WHERE campaign_id = 47
      GROUP BY status
    `);
    console.log('Destinatarios (Seguimiento):', recTrack.rows);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR:', err.message);
  } finally {
    client.release();
    pool.end();
  }
}

reactivateJobs();
