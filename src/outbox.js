const OUTBOX_CHANNEL = 'distrito_domain_events';

function createOutboxDispatcher({ pool, onEvent, pollIntervalMs = 750 }) {
  let listener = null;
  let timer = null;
  let stopped = true;
  let polling = false;
  let fanningOut = false;
  let lastSeenId = 0;

  async function fanOutNewEvents() {
    if (stopped || fanningOut) return;
    fanningOut = true;
    try {
      for (;;) {
        const { rows } = await pool.query(`
          SELECT id,event_id,aggregate_type,aggregate_id,event_type,payload,occurred_at
          FROM pedidos_app_domain_events
          WHERE id>$1
          ORDER BY id
          LIMIT 500
        `, [lastSeenId]);
        if (!rows.length) break;
        for (const row of rows) {
          try {
            await onEvent?.(row);
          } catch (error) {
            console.error(JSON.stringify({
              level: 'error', component: 'outbox-fanout', event_id: row.event_id,
              message: error.message,
            }));
          } finally {
            lastSeenId = Number(row.id);
          }
        }
        if (rows.length < 500) break;
      }
    } finally {
      fanningOut = false;
    }
  }

  async function poll() {
    if (stopped || polling) return;
    polling = true;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        SELECT id,event_id
        FROM pedidos_app_domain_events
        WHERE published_at IS NULL
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 50
      `);
      for (const row of rows) {
        await client.query(`
          UPDATE pedidos_app_domain_events
          SET published_at=NOW(),publish_attempts=publish_attempts+1,last_error=NULL
          WHERE id=$1
        `, [row.id]);
        await client.query('SELECT pg_notify($1,$2)', [OUTBOX_CHANNEL, String(row.event_id)]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(JSON.stringify({ level: 'error', component: 'outbox', message: error.message }));
    } finally {
      client.release();
      polling = false;
    }
    await fanOutNewEvents();
  }

  async function start() {
    if (!stopped) return;
    stopped = false;
    const cursor = await pool.query('SELECT COALESCE(MAX(id),0)::bigint AS id FROM pedidos_app_domain_events');
    lastSeenId = Number(cursor.rows[0]?.id || 0);
    listener = await pool.connect();
    listener.on('notification', (notification) => {
      if (notification.channel !== OUTBOX_CHANNEL) return;
      void fanOutNewEvents();
    });
    listener.on('error', (error) => {
      console.error(JSON.stringify({ level: 'error', component: 'outbox-listener', message: error.message }));
    });
    await listener.query(`LISTEN ${OUTBOX_CHANNEL}`);
    timer = setInterval(() => { void poll(); }, pollIntervalMs);
    timer.unref?.();
    await poll();
  }

  async function stop() {
    stopped = true;
    clearInterval(timer);
    timer = null;
    if (listener) {
      await listener.query(`UNLISTEN ${OUTBOX_CHANNEL}`).catch(() => {});
      listener.release();
      listener = null;
    }
  }

  return { start, stop, poll, fanOutNewEvents };
}

module.exports = { OUTBOX_CHANNEL, createOutboxDispatcher };
