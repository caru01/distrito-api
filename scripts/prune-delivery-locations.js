const { createPool } = require('../src/db');

const requestedDays = Number.parseInt(process.env.DELIVERY_LOCATION_RETENTION_DAYS || '90', 10);
const retentionDays = Number.isInteger(requestedDays) ? Math.max(requestedDays, 30) : 90;
const batchSize = 5000;

async function prune() {
  const pool = createPool({ max: 1 });
  let deleted = 0;
  try {
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
    await pool.query('ANALYZE pedidos_app_delivery_locations');
    console.log(`Retención delivery completada (${retentionDays} días).`);
  } finally {
    await pool.end();
  }
}

prune().catch((error) => {
  console.error('Error limpiando ubicaciones delivery:', error.message);
  process.exitCode = 1;
});
