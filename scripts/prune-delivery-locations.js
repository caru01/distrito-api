const { createPool } = require('../src/db');

const requestedDays = Number.parseInt(process.env.DELIVERY_LOCATION_RETENTION_DAYS || '90', 10);
const retentionDays = Number.isInteger(requestedDays) ? Math.max(requestedDays, 30) : 90;
const requestedWebhookDays = Number.parseInt(process.env.CRM_WEBHOOK_RETENTION_DAYS || '90', 10);
const webhookRetentionDays = Number.isInteger(requestedWebhookDays) ? Math.max(requestedWebhookDays, 30) : 90;
const requestedJobDays = Number.parseInt(process.env.CRM_JOB_RETENTION_DAYS || '30', 10);
const jobRetentionDays = Number.isInteger(requestedJobDays) ? Math.max(requestedJobDays, 7) : 30;
const batchSize = 5000;

async function prune() {
  const pool = createPool({ max: 1 });
  let deleted = 0;
  try {
    do {
      const result = await pool.query(`
        WITH candidates AS (
          SELECT id
          FROM pedidos_app_driver_location_points
          WHERE captured_at < NOW() - make_interval(days => $1)
          ORDER BY captured_at
          LIMIT $2
        )
        DELETE FROM pedidos_app_driver_location_points location
        USING candidates
        WHERE location.id = candidates.id
      `, [retentionDays, batchSize]);
      deleted = result.rowCount;
      console.log(`Puntos GPS normalizados eliminados en el lote: ${deleted}`);
    } while (deleted === batchSize);
    do {
      const result = await pool.query(`
        WITH candidates AS (
          SELECT location.id
          FROM pedidos_app_delivery_locations location
          JOIN pedidos_app_orders order_data ON order_data.id = location.order_id
          WHERE location.recorded_at < NOW() - make_interval(days => $1)
            AND order_data.delivery_status IN ('Entregado', 'Cancelado')
          ORDER BY location.recorded_at
          LIMIT $2
        )
        DELETE FROM pedidos_app_delivery_locations location
        USING candidates
        WHERE location.id = candidates.id
      `, [retentionDays, batchSize]);
      deleted = result.rowCount;
      console.log(`Ubicaciones eliminadas en el lote: ${deleted}`);
    } while (deleted === batchSize);
    await pool.query(`DELETE FROM pedidos_app_delivery_idempotency WHERE created_at < NOW() - INTERVAL '7 days'`);
    await pool.query(`
      DELETE FROM pedidos_app_domain_events
      WHERE aggregate_type='realtime' AND published_at IS NOT NULL
        AND occurred_at < NOW() - INTERVAL '1 day'
    `);
    await pool.query(`DELETE FROM pedidos_app_domain_events WHERE published_at IS NOT NULL AND occurred_at < NOW() - INTERVAL '30 days'`);
    const webhookEvents = await pool.query(`
      DELETE FROM pedidos_app_crm_webhook_events
      WHERE received_at < NOW() - make_interval(days => $1)
    `, [webhookRetentionDays]);
    const messageJobs = await pool.query(`
      DELETE FROM pedidos_app_crm_message_jobs
      WHERE status IN ('COMPLETED','CANCELLED')
        AND updated_at < NOW() - make_interval(days => $1)
    `, [jobRetentionDays]);
    const automationRuns = await pool.query(`
      DELETE FROM pedidos_app_crm_automation_runs
      WHERE status IN ('COMPLETED','CANCELLED')
        AND created_at < NOW() - INTERVAL '180 days'
    `);
    await pool.query('ANALYZE pedidos_app_driver_location_points');
    await pool.query('ANALYZE pedidos_app_delivery_locations');
    await pool.query('ANALYZE pedidos_app_delivery_idempotency');
    await pool.query('ANALYZE pedidos_app_domain_events');
    await pool.query('ANALYZE pedidos_app_crm_webhook_events');
    await pool.query('ANALYZE pedidos_app_crm_message_jobs');
    await pool.query('ANALYZE pedidos_app_crm_automation_runs');
    console.log(`Retención CRM: ${webhookEvents.rowCount} webhooks, ${messageJobs.rowCount} trabajos y ${automationRuns.rowCount} ejecuciones eliminados.`);
    console.log(`Retención delivery completada (${retentionDays} días).`);
  } finally {
    await pool.end();
  }
}

prune().catch((error) => {
  console.error('Error limpiando ubicaciones delivery:', error.message);
  process.exitCode = 1;
});
