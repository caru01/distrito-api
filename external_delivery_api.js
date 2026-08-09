const crypto = require('crypto');

const PROVIDER_TYPES = new Set(['external_manual', 'external_api']);

function cleanText(value, maxLength = 500) {
  const text = String(value || '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function nonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function etaMinutes(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 1440 ? parsed : null;
}

async function recordEvent(client, order, eventType, actor, notes, metadata = {}) {
  await client.query(`
    INSERT INTO pedidos_app_delivery_events
      (order_id, event_type, provider_type, delivery_user_id, company_id,
       actor_user_id, actor_name, driver_name, driver_phone, vehicle_id,
       external_cost, notes, metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
  `, [
    order.id, eventType, order.delivery_provider_type, order.delivery_user_id,
    order.external_delivery_company_id, actor?.id || null, actor?.username || null,
    order.external_driver_name, order.external_driver_phone, order.external_vehicle_id,
    order.external_delivery_cost, notes || null, JSON.stringify(metadata),
  ]);
  await client.query(`
    INSERT INTO pedidos_app_audit_logs
      (user_id, username_attempted, module, action, details, request_data)
    VALUES ($1,$2,'Domicilios externos',$3,$4,$5::jsonb)
  `, [
    actor?.id || null, actor?.username || null, eventType,
    `Pedido #${order.id}: ${notes || eventType}`,
    JSON.stringify({
      orderId: order.id,
      providerType: order.delivery_provider_type,
      companyId: order.external_delivery_company_id,
      deliveryUserId: order.delivery_user_id,
      externalDriver: order.external_driver_name,
      externalCost: Number(order.external_delivery_cost || 0),
      ...metadata,
    }),
  ]);
  const eventId = crypto.randomUUID();
  await client.query(`
    INSERT INTO pedidos_app_domain_events
      (event_id, aggregate_type, aggregate_id, event_type, payload)
    VALUES ($1,'order',$2,$3,$4::jsonb)
  `, [eventId, String(order.id), `delivery_${eventType}`, JSON.stringify({
    eventId,
    orderId: order.id,
    orderStatus: order.status,
    deliveryStatus: order.delivery_status,
    providerType: order.delivery_provider_type,
    version: Number(order.version || 0),
  })]);
}

module.exports = function registerExternalDeliveryApi(app, dependencies) {
  const { pool, authenticateToken, requirePermission } = dependencies;
  const canView = [authenticateToken, requirePermission('Domicilios', 'ver')];
  const canManage = [authenticateToken, requirePermission('Domicilios', 'asignar')];

  app.get('/api/pedidos/admin/delivery-companies', ...canView, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT company.*,
               COUNT(order_data.id) FILTER (WHERE order_data.status <> 'Cancelado')::int AS deliveries_count,
               COUNT(order_data.id) FILTER (WHERE order_data.delivery_status = 'Entregado')::int AS completed_count,
               COUNT(order_data.id) FILTER (
                 WHERE order_data.status <> 'Cancelado' AND order_data.delivery_status <> 'Entregado'
               )::int AS pending_count,
               COALESCE(SUM(order_data.external_delivery_cost) FILTER (
                 WHERE order_data.delivery_status = 'Entregado'
               ), 0)::bigint AS paid_total,
               COALESCE(AVG(order_data.delivery_duration_seconds) FILTER (
                 WHERE order_data.delivery_status = 'Entregado'
               ), 0)::int AS average_duration_seconds
        FROM pedidos_app_delivery_companies company
        LEFT JOIN pedidos_app_orders order_data
          ON order_data.external_delivery_company_id = company.id
        GROUP BY company.id
        ORDER BY company.status, company.name
      `);
      res.json({ status: 'ok', companies: rows });
    } catch (error) {
      console.error('Error consultando empresas de domicilios:', error);
      res.status(500).json({ error: 'No fue posible cargar las empresas de domicilios' });
    }
  });

  app.get('/api/pedidos/admin/delivery-companies/:id', ...canView, async (req, res) => {
    try {
      const companyId = Number(req.params.id);
      const [companyResult, ordersResult] = await Promise.all([
        pool.query('SELECT * FROM pedidos_app_delivery_companies WHERE id = $1', [companyId]),
        pool.query(`
          SELECT id, customer_name, status, delivery_status, delivery_fee,
                 external_delivery_cost,
                 (delivery_fee - external_delivery_cost) AS logistics_margin,
                 external_driver_name, external_assigned_at, external_handed_off_at,
                 external_delivery_confirmed_at, created_at
          FROM pedidos_app_orders
          WHERE external_delivery_company_id = $1
          ORDER BY created_at DESC LIMIT 100
        `, [companyId]),
      ]);
      if (!companyResult.rowCount) return res.status(404).json({ error: 'Empresa no encontrada' });
      res.json({ status: 'ok', company: companyResult.rows[0], orders: ordersResult.rows });
    } catch (error) {
      res.status(500).json({ error: 'No fue posible cargar el historial de la empresa' });
    }
  });

  app.post('/api/pedidos/admin/delivery-companies', ...canManage, async (req, res) => {
    const name = cleanText(req.body.name, 120);
    const phone = cleanText(req.body.phone, 30);
    if (!name || !phone) return res.status(400).json({ error: 'Nombre y teléfono son obligatorios' });
    const eta = etaMinutes(req.body.estimatedDeliveryMinutes ?? req.body.estimated_delivery_minutes);
    try {
      const { rows } = await pool.query(`
        INSERT INTO pedidos_app_delivery_companies
          (name, phone, status, observations, default_fee, estimated_delivery_minutes, integration_type, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
      `, [
        name, phone, req.body.status === 'Inactiva' ? 'Inactiva' : 'Activa',
        cleanText(req.body.observations, 3000) || '', nonNegativeInteger(req.body.defaultFee ?? req.body.default_fee), eta,
        req.body.integrationType === 'api' || req.body.integration_type === 'api' ? 'api' : 'manual', req.user.id,
      ]);
      res.status(201).json({ status: 'ok', company: rows[0] });
    } catch (error) {
      res.status(error.code === '23505' ? 409 : 500).json({
        error: error.code === '23505' ? 'Ya existe una empresa con ese nombre' : 'No fue posible crear la empresa',
      });
    }
  });

  app.put('/api/pedidos/admin/delivery-companies/:id', ...canManage, async (req, res) => {
    const name = cleanText(req.body.name, 120);
    const phone = cleanText(req.body.phone, 30);
    if (!name || !phone) return res.status(400).json({ error: 'Nombre y teléfono son obligatorios' });
    try {
      const { rows } = await pool.query(`
        UPDATE pedidos_app_delivery_companies SET
          name=$1, phone=$2, status=$3, observations=$4, default_fee=$5,
          estimated_delivery_minutes=$6, integration_type=$7, updated_at=NOW()
        WHERE id=$8 RETURNING *
      `, [
        name, phone, req.body.status === 'Inactiva' ? 'Inactiva' : 'Activa', cleanText(req.body.observations, 3000) || '',
        nonNegativeInteger(req.body.defaultFee ?? req.body.default_fee),
        etaMinutes(req.body.estimatedDeliveryMinutes ?? req.body.estimated_delivery_minutes),
        req.body.integrationType === 'api' || req.body.integration_type === 'api' ? 'api' : 'manual', Number(req.params.id),
      ]);
      if (!rows.length) return res.status(404).json({ error: 'Empresa no encontrada' });
      res.json({ status: 'ok', company: rows[0] });
    } catch (error) {
      res.status(error.code === '23505' ? 409 : 500).json({
        error: error.code === '23505' ? 'Ya existe una empresa con ese nombre' : 'No fue posible actualizar la empresa',
      });
    }
  });

  app.get('/api/pedidos/admin/delivery/orders/:id/events', ...canView, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT event.*, company.name AS company_name,
               TRIM(CONCAT(driver.name, ' ', driver.last_name)) AS own_driver_name
        FROM pedidos_app_delivery_events event
        LEFT JOIN pedidos_app_delivery_companies company ON company.id = event.company_id
        LEFT JOIN pedidos_app_users driver ON driver.id = event.delivery_user_id
        WHERE event.order_id = $1 ORDER BY event.created_at ASC
      `, [Number(req.params.id)]);
      res.json({ status: 'ok', events: rows });
    } catch (error) {
      res.status(500).json({ error: 'No fue posible cargar la trazabilidad logística' });
    }
  });

  app.post('/api/pedidos/admin/delivery/orders/:id/assign-external', ...canManage, async (req, res) => {
    const orderId = Number(req.params.id);
    const companyId = Number(req.body.companyId);
    if (!Number.isInteger(orderId) || !Number.isInteger(companyId)) {
      return res.status(400).json({ error: 'Selecciona una empresa de domicilios válida' });
    }
    const client = await pool.connect();
    let order;
    let previousUserId;
    try {
      await client.query('BEGIN');
      const companyResult = await client.query(`
        SELECT * FROM pedidos_app_delivery_companies
        WHERE id = $1 AND status = 'Activa' FOR UPDATE
      `, [companyId]);
      if (!companyResult.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'La empresa seleccionada no está activa' });
      }
      const currentResult = await client.query('SELECT * FROM pedidos_app_orders WHERE id=$1 FOR UPDATE', [orderId]);
      const current = currentResult.rows[0];
      if (!current || String(current.delivery_type || '').toLowerCase() !== 'domicilio') {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Pedido de domicilio no encontrado' });
      }
      if (!['Listo', 'Asignado externo'].includes(current.status)
          || !['Pendiente', 'Asignado externo'].includes(current.delivery_status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'El pedido ya salió del restaurante y no puede reasignarse' });
      }
      previousUserId = current.delivery_user_id;
      const providerType = companyResult.rows[0].integration_type === 'api' ? 'external_api' : 'external_manual';
      const cost = nonNegativeInteger(req.body.externalCost, Number(companyResult.rows[0].default_fee || 0));
      const eta = etaMinutes(req.body.etaMinutes) || companyResult.rows[0].estimated_delivery_minutes;
      const updated = await client.query(`
        UPDATE pedidos_app_orders SET
          status='Asignado externo', delivery_status='Asignado externo',
          delivery_provider_type=$1, delivery_user_id=NULL,
          external_delivery_company_id=$2, external_driver_name=$3,
          external_driver_phone=$4, external_vehicle_id=$5,
          external_delivery_cost=$6, external_delivery_notes=$7,
          external_eta_minutes=$8, external_provider_reference=$9,
          external_assigned_at=NOW(), external_handed_off_at=NULL,
          external_delivery_confirmed_at=NULL, external_delivery_confirmed_by=NULL,
          external_delivery_confirmed_by_name=NULL, external_delivery_confirmation_notes=NULL,
          delivery_accepted_at=NULL, picked_up_at=NULL, on_the_way_at=NULL,
          version=version+1, updated_at=NOW()
        WHERE id=$10 RETURNING *
      `, [
        providerType, companyId, cleanText(req.body.driverName, 160), cleanText(req.body.driverPhone, 30),
        cleanText(req.body.vehicleId, 80), cost, cleanText(req.body.notes, 3000), eta,
        cleanText(req.body.providerReference, 160), orderId,
      ]);
      order = updated.rows[0];
      const eventType = previousUserId || current.external_delivery_company_id ? 'reassigned' : 'assigned_external';
      await recordEvent(client, order, eventType, req.user, 'Entrega asignada a operador logístico externo', {
        previousDeliveryUserId: previousUserId,
        previousCompanyId: current.external_delivery_company_id,
      });
      if (previousUserId) {
        await client.query(`
          UPDATE pedidos_app_delivery_profiles SET
            availability_status = CASE WHEN EXISTS (
              SELECT 1 FROM pedidos_app_orders active_order
              WHERE active_order.delivery_user_id=$1
                AND active_order.delivery_status IN ('Pendiente','Aceptado','Recogido','En camino')
            ) THEN 'Ocupado' ELSE 'Libre' END,
            updated_at=NOW()
          WHERE user_id=$1
        `, [previousUserId]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error asignando operador externo:', error);
      return res.status(500).json({ error: 'No fue posible asignar la empresa externa' });
    } finally {
      client.release();
    }
    res.json({ status: 'ok', order });
  });

  app.post('/api/pedidos/admin/delivery/orders/:id/external-handoff', ...canManage, async (req, res) => {
    await transitionExternalOrder(req, res, {
      from: 'Asignado externo', to: 'Entregado al operador externo', eventType: 'handed_to_external',
      timestampColumn: 'external_handed_off_at', message: 'Pedido entregado físicamente al operador logístico',
    });
  });

  app.post('/api/pedidos/admin/delivery/orders/:id/external-start', ...canManage, async (req, res) => {
    await transitionExternalOrder(req, res, {
      from: 'Entregado al operador externo', to: 'En camino', eventType: 'external_started',
      timestampColumn: 'on_the_way_at', message: 'Operador logístico confirmado en camino',
    });
  });

  async function transitionExternalOrder(req, res, transition) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        UPDATE pedidos_app_orders SET
          status=$1, delivery_status=$1, ${transition.timestampColumn}=COALESCE(${transition.timestampColumn}, NOW()),
          version=version+1, updated_at=NOW()
        WHERE id=$2 AND delivery_provider_type IN ('external_manual','external_api')
          AND delivery_status=$3
        RETURNING *
      `, [transition.to, Number(req.params.id), transition.from]);
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `El pedido debe estar en estado “${transition.from}”` });
      }
      await recordEvent(client, rows[0], transition.eventType, req.user, transition.message);
      await client.query('COMMIT');
      return res.json({ status: 'ok', order: rows[0] });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error cambiando estado de entrega externa:', error);
      return res.status(500).json({ error: 'No fue posible actualizar la entrega externa' });
    } finally {
      client.release();
    }
  }

  app.post('/api/pedidos/admin/delivery/orders/:id/external-complete', ...canManage, async (req, res) => {
    if (req.body.confirmReceived !== true) {
      return res.status(400).json({ error: 'Debes confirmar que el cliente recibió el pedido' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const confirmedAt = req.body.confirmedAt ? new Date(req.body.confirmedAt) : new Date();
      if (!Number.isFinite(confirmedAt.getTime()) || confirmedAt.getTime() > Date.now() + 60_000) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'La fecha de confirmación no es válida' });
      }
      const { rows } = await client.query(`
        UPDATE pedidos_app_orders SET
          status='Entregado', delivery_status='Entregado',
          external_delivery_confirmed_at=$1, external_delivery_confirmed_by=$2,
          external_delivery_confirmed_by_name=$3, external_delivery_confirmation_notes=$4,
          delivery_completed_at=$1, delivered_at=COALESCE(delivered_at,$1),
          completed_at=COALESCE(completed_at,$1),
          delivery_duration_seconds=GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz-created_at))::integer),
          version=version+1, updated_at=NOW()
        WHERE id=$5 AND delivery_provider_type IN ('external_manual','external_api')
          AND delivery_status='En camino'
        RETURNING *
      `, [
        confirmedAt.toISOString(), req.user.id, cleanText(req.body.confirmedBy, 160) || req.user.username,
        cleanText(req.body.notes, 3000), Number(req.params.id),
      ]);
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'El pedido externo debe estar en camino antes de finalizarse' });
      }
      await recordEvent(client, rows[0], 'delivered', req.user, 'Entrega externa confirmada manualmente', {
        confirmedAt: confirmedAt.toISOString(), confirmedBy: rows[0].external_delivery_confirmed_by_name,
      });
      await client.query('COMMIT');
      res.json({ status: 'ok', order: rows[0] });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error confirmando entrega externa:', error);
      res.status(500).json({ error: 'No fue posible confirmar la entrega externa' });
    } finally {
      client.release();
    }
  });
};
