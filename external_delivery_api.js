const crypto = require('crypto');
const bcrypt = require('bcryptjs');

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

  const requireAnyPermission = (...perms) => async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Acceso denegado' });
    if (['Super Administrador', 'Administrador'].includes(req.user.role || req.user.role_name)) return next();
    try {
      const conditions = perms.map((_, i) => `(p.module = $${i * 2 + 2} AND p.action = $${i * 2 + 3})`).join(' OR ');
      const params = [req.user.role_id];
      perms.forEach(p => { params.push(p[0], p[1]); });
      const { rows } = await pool.query(`
        SELECT rp.* FROM pedidos_app_role_permissions rp
        JOIN pedidos_app_permissions p ON rp.permission_id = p.id
        WHERE rp.role_id = $1 AND (${conditions})
      `, params);
      if (rows.length === 0) return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
      next();
    } catch (e) {
      console.error('Error verifying permissions:', e);
      res.status(500).json({ error: 'Error interno verificando permisos' });
    }
  };

  const canView = [authenticateToken, requireAnyPermission(['Empresas Domicilios', 'ver'], ['Domicilios', 'ver'])];
  const canManage = [authenticateToken, requireAnyPermission(['Empresas Domicilios', 'editar'], ['Empresas Domicilios', 'crear'], ['Domicilios', 'asignar'])];
  const canManageDrivers = [authenticateToken, requireAnyPermission(['Empresas Domicilios', 'mensajeros'], ['Empresas Domicilios', 'editar'], ['Domicilios', 'asignar'])];

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
               ), 0)::int AS average_duration_seconds,
               COALESCE((
                 SELECT COUNT(*)::int FROM pedidos_app_delivery_company_drivers d
                 WHERE d.company_id = company.id
               ), 0) AS drivers_count,
               COALESCE((
                 SELECT json_agg(
                   json_build_object(
                     'id', d.id,
                     'name', d.name,
                     'phone', d.phone,
                     'vehicle_type', d.vehicle_type,
                     'vehicle_plate', d.vehicle_plate,
                     'document_id', d.document_id,
                     'status', d.status,
                     'user_id', d.user_id,
                     'has_app_account', (d.user_id IS NOT NULL)
                   ) ORDER BY d.name ASC
                 ) FILTER (WHERE d.status = 'Activo')
                 FROM pedidos_app_delivery_company_drivers d
                 WHERE d.company_id = company.id
               ), '[]'::json) AS active_drivers
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
      const [companyResult, ordersResult, driversResult] = await Promise.all([
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
        pool.query(`
          SELECT * FROM pedidos_app_delivery_company_drivers
          WHERE company_id = $1
          ORDER BY (status = 'Activo') DESC, name ASC
        `, [companyId]),
      ]);
      if (!companyResult.rowCount) return res.status(404).json({ error: 'Empresa no encontrada' });
      res.json({ status: 'ok', company: companyResult.rows[0], orders: ordersResult.rows, drivers: driversResult.rows });
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

  // ================= MENSAJEROS DE EMPRESAS EXTERNAS =================
  app.get('/api/pedidos/admin/delivery-companies/:id/drivers', ...canView, async (req, res) => {
    try {
      const companyId = Number(req.params.id);
      const { rows } = await pool.query(`
        SELECT d.*,
               u.username AS app_username,
               u.status AS user_status,
               (u.id IS NOT NULL) AS has_app_account,
               profile.shift_active,
               profile.current_latitude,
               profile.current_longitude,
               profile.last_location_at,
               profile.last_seen_at,
               profile.tracking_mode,
               CASE
                 WHEN u.id IS NULL THEN 'Sin cuenta'
                 WHEN profile.shift_active
                   AND profile.last_seen_at >= NOW() - make_interval(secs => COALESCE(settings.presence_timeout_seconds, 90))
                   THEN CASE WHEN COALESCE(active_order.active_order_count, 0) > 0 THEN 'Ocupado' ELSE 'Libre' END
                 ELSE 'Desconectado'
               END AS live_status,
               COALESCE((
                 SELECT json_agg(
                   json_build_object(
                     'id', o.id,
                     'status', o.delivery_status,
                     'customer_name', o.customer_name,
                     'address', o.address,
                     'total', o.total,
                     'created_at', o.created_at
                   ) ORDER BY o.created_at ASC
                 )
                 FROM pedidos_app_orders o
                 WHERE (o.external_driver_id = d.id OR (u.id IS NOT NULL AND o.delivery_user_id = u.id))
                   AND o.status <> 'Cancelado'
                   AND o.delivery_status IN ('Pendiente', 'Aceptado', 'Recogido', 'En camino')
               ), '[]'::json) AS active_orders_list,
               COUNT(o.id) FILTER (WHERE o.delivery_status = 'Entregado')::int AS completed_deliveries,
               COUNT(o.id) FILTER (WHERE o.status <> 'Cancelado' AND o.delivery_status <> 'Entregado')::int AS active_deliveries
        FROM pedidos_app_delivery_company_drivers d
        LEFT JOIN pedidos_app_users u ON u.id = d.user_id
        LEFT JOIN pedidos_app_delivery_profiles profile ON profile.user_id = u.id
        LEFT JOIN pedidos_app_settings settings ON settings.id = 1
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS active_order_count
          FROM pedidos_app_orders ord
          WHERE (ord.external_driver_id = d.id OR (u.id IS NOT NULL AND ord.delivery_user_id = u.id))
            AND ord.status <> 'Cancelado'
            AND ord.delivery_status IN ('Pendiente', 'Aceptado', 'Recogido', 'En camino')
        ) active_order ON TRUE
        LEFT JOIN pedidos_app_orders o ON o.external_driver_id = d.id OR (o.external_delivery_company_id = d.company_id AND LOWER(TRIM(o.external_driver_name)) = LOWER(TRIM(d.name)))
        WHERE d.company_id = $1
        GROUP BY d.id, u.id, u.username, u.status, profile.shift_active, profile.current_latitude, profile.current_longitude,
                 profile.last_location_at, profile.last_seen_at, profile.tracking_mode, settings.presence_timeout_seconds,
                 active_order.active_order_count
        ORDER BY (d.status = 'Activo') DESC, d.name ASC
      `, [companyId]);
      res.json({ status: 'ok', drivers: rows });
    } catch (error) {
      console.error('Error fetching company drivers:', error);
      res.status(500).json({ error: 'No fue posible consultar los mensajeros de la empresa' });
    }
  });

  app.post('/api/pedidos/admin/delivery-companies/:id/drivers', ...canManageDrivers, async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = Number(req.params.id);
      const name = cleanText(req.body.name, 120);
      const phone = cleanText(req.body.phone, 30);
      if (!name || !phone) return res.status(400).json({ error: 'Nombre y teléfono del mensajero son obligatorios' });

      const vehicleType = ['Moto', 'Bicicleta', 'Carro', 'A pie', 'Otro'].includes(req.body.vehicle_type || req.body.vehicleType)
        ? (req.body.vehicle_type || req.body.vehicleType)
        : 'Moto';
      const vehiclePlate = cleanText(req.body.vehicle_plate || req.body.vehiclePlate, 30);
      const documentId = cleanText(req.body.document_id || req.body.documentId, 50);
      const status = req.body.status === 'Inactivo' ? 'Inactivo' : 'Activo';
      const notes = cleanText(req.body.notes, 1000) || '';

      const enableAppAccount = Boolean(req.body.enable_app_account || req.body.enableAppAccount);
      let userId = null;

      await client.query('BEGIN');

      if (enableAppAccount) {
        const username = cleanText(req.body.app_username || req.body.appUsername) || phone.replace(/\D/g, '');
        const password = String(req.body.app_password || req.body.appPassword || '').trim();
        if (!username) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'El nombre de usuario para la app es obligatorio' });
        }
        if (!password || password.length < 4) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'La contraseña para la app debe tener mínimo 4 caracteres' });
        }

        const existingUser = await client.query('SELECT id FROM pedidos_app_users WHERE LOWER(username) = LOWER($1)', [username]);
        if (existingUser.rowCount > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `El nombre de usuario "${username}" ya está registrado en el sistema` });
        }

        const roleRes = await client.query("SELECT id FROM pedidos_app_roles WHERE name = 'Domiciliario' LIMIT 1");
        const roleId = roleRes.rows[0]?.id || 31;
        const hashedPassword = await bcrypt.hash(password, 10);

        const userRes = await client.query(`
          INSERT INTO pedidos_app_users
            (username, password_hash, phone, role_id, name, last_name, document, status, external_company_id, must_change_password)
          VALUES ($1, $2, $3, $4, $5, '', $6, $7, $8, FALSE)
          RETURNING id
        `, [username, hashedPassword, phone, roleId, name, documentId, status, companyId]);
        userId = userRes.rows[0].id;

        await client.query(`
          INSERT INTO pedidos_app_delivery_profiles
            (user_id, vehicle_name, vehicle_type, plate, max_active_orders, availability_status)
          VALUES ($1, $2, $3, $4, 5, 'Desconectado')
          ON CONFLICT (user_id) DO UPDATE SET
            vehicle_name = EXCLUDED.vehicle_name,
            vehicle_type = EXCLUDED.vehicle_type,
            plate = EXCLUDED.plate,
            updated_at = NOW()
        `, [userId, `${vehicleType} ${vehiclePlate || ''}`.trim(), vehicleType, vehiclePlate]);
      }

      const { rows } = await client.query(`
        INSERT INTO pedidos_app_delivery_company_drivers
          (company_id, name, phone, vehicle_type, vehicle_plate, document_id, status, notes, user_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [companyId, name, phone, vehicleType, vehiclePlate, documentId, status, notes, userId]);

      if (userId) {
        await client.query('UPDATE pedidos_app_users SET external_driver_id = $1 WHERE id = $2', [rows[0].id, userId]);
      }

      await client.query('COMMIT');
      res.status(201).json({ status: 'ok', driver: rows[0] });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error creating company driver:', error);
      res.status(500).json({ error: error.message || 'No fue posible registrar el mensajero' });
    } finally {
      client.release();
    }
  });

  app.put('/api/pedidos/admin/delivery-companies/:companyId/drivers/:driverId', ...canManageDrivers, async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = Number(req.params.companyId);
      const driverId = Number(req.params.driverId);
      const name = cleanText(req.body.name, 120);
      const phone = cleanText(req.body.phone, 30);
      if (!name || !phone) return res.status(400).json({ error: 'Nombre y teléfono del mensajero son obligatorios' });

      const vehicleType = ['Moto', 'Bicicleta', 'Carro', 'A pie', 'Otro'].includes(req.body.vehicle_type || req.body.vehicleType)
        ? (req.body.vehicle_type || req.body.vehicleType)
        : 'Moto';
      const vehiclePlate = cleanText(req.body.vehicle_plate || req.body.vehiclePlate, 30);
      const documentId = cleanText(req.body.document_id || req.body.documentId, 50);
      const status = req.body.status === 'Inactivo' ? 'Inactivo' : 'Activo';
      const notes = cleanText(req.body.notes, 1000) || '';

      const enableAppAccount = Boolean(req.body.enable_app_account || req.body.enableAppAccount);
      const appUsername = cleanText(req.body.app_username || req.body.appUsername);
      const appPassword = String(req.body.app_password || req.body.appPassword || '').trim();

      await client.query('BEGIN');

      const curRes = await client.query('SELECT * FROM pedidos_app_delivery_company_drivers WHERE id = $1 AND company_id = $2 FOR UPDATE', [driverId, companyId]);
      if (!curRes.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Mensajero no encontrado' });
      }
      const currentDriver = curRes.rows[0];
      let userId = currentDriver.user_id;

      if (enableAppAccount) {
        if (userId) {
          if (appUsername) {
            const conflict = await client.query('SELECT id FROM pedidos_app_users WHERE LOWER(username) = LOWER($1) AND id <> $2', [appUsername, userId]);
            if (conflict.rowCount > 0) {
              await client.query('ROLLBACK');
              return res.status(409).json({ error: `El usuario "${appUsername}" ya está en uso por otra cuenta` });
            }
            await client.query('UPDATE pedidos_app_users SET username = $1 WHERE id = $2', [appUsername, userId]);
          }
          if (appPassword) {
            if (appPassword.length < 4) {
              await client.query('ROLLBACK');
              return res.status(400).json({ error: 'La nueva contraseña debe tener mínimo 4 caracteres' });
            }
            const newHash = await bcrypt.hash(appPassword, 10);
            await client.query('UPDATE pedidos_app_users SET password_hash = $1 WHERE id = $2', [newHash, userId]);
          }
          await client.query(`
            UPDATE pedidos_app_users
            SET name = $1, phone = $2, document = $3, status = $4, external_company_id = $5, external_driver_id = $6
            WHERE id = $7
          `, [name, phone, documentId, status, companyId, driverId, userId]);

          await client.query(`
            INSERT INTO pedidos_app_delivery_profiles
              (user_id, vehicle_name, vehicle_type, plate, max_active_orders)
            VALUES ($1, $2, $3, $4, 5)
            ON CONFLICT (user_id) DO UPDATE SET
              vehicle_name = EXCLUDED.vehicle_name,
              vehicle_type = EXCLUDED.vehicle_type,
              plate = EXCLUDED.plate,
              updated_at = NOW()
          `, [userId, `${vehicleType} ${vehiclePlate || ''}`.trim(), vehicleType, vehiclePlate]);
        } else {
          const username = appUsername || phone.replace(/\D/g, '');
          if (!username) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'El nombre de usuario para la app es obligatorio' });
          }
          if (!appPassword || appPassword.length < 4) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'La contraseña para la app debe tener mínimo 4 caracteres' });
          }
          const existingUser = await client.query('SELECT id FROM pedidos_app_users WHERE LOWER(username) = LOWER($1)', [username]);
          if (existingUser.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: `El nombre de usuario "${username}" ya está registrado en el sistema` });
          }
          const roleRes = await client.query("SELECT id FROM pedidos_app_roles WHERE name = 'Domiciliario' LIMIT 1");
          const roleId = roleRes.rows[0]?.id || 31;
          const hashedPassword = await bcrypt.hash(appPassword, 10);

          const userRes = await client.query(`
            INSERT INTO pedidos_app_users
              (username, password_hash, phone, role_id, name, last_name, document, status, external_company_id, external_driver_id, must_change_password)
            VALUES ($1, $2, $3, $4, $5, '', $6, $7, $8, $9, FALSE)
            RETURNING id
          `, [username, hashedPassword, phone, roleId, name, documentId, status, companyId, driverId]);
          userId = userRes.rows[0].id;

          await client.query(`
            INSERT INTO pedidos_app_delivery_profiles
              (user_id, vehicle_name, vehicle_type, plate, max_active_orders, availability_status)
            VALUES ($1, $2, $3, $4, 5, 'Desconectado')
            ON CONFLICT (user_id) DO UPDATE SET
              vehicle_name = EXCLUDED.vehicle_name,
              vehicle_type = EXCLUDED.vehicle_type,
              plate = EXCLUDED.plate,
              updated_at = NOW()
          `, [userId, `${vehicleType} ${vehiclePlate || ''}`.trim(), vehicleType, vehiclePlate]);
        }
      } else if (userId && req.body.enable_app_account === false) {
        await client.query("UPDATE pedidos_app_users SET status = 'Inactivo' WHERE id = $1", [userId]);
      }

      const { rows } = await client.query(`
        UPDATE pedidos_app_delivery_company_drivers SET
          name = $1, phone = $2, vehicle_type = $3, vehicle_plate = $4,
          document_id = $5, status = $6, notes = $7, user_id = $8, updated_at = NOW()
        WHERE id = $9 AND company_id = $10
        RETURNING *
      `, [name, phone, vehicleType, vehiclePlate, documentId, status, notes, userId, driverId, companyId]);

      await client.query('COMMIT');
      res.json({ status: 'ok', driver: rows[0] });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error updating company driver:', error);
      res.status(500).json({ error: error.message || 'No fue posible actualizar el mensajero' });
    } finally {
      client.release();
    }
  });

  app.delete('/api/pedidos/admin/delivery-companies/:companyId/drivers/:driverId', ...canManageDrivers, async (req, res) => {
    try {
      const companyId = Number(req.params.companyId);
      const driverId = Number(req.params.driverId);
      const cur = await pool.query('SELECT user_id FROM pedidos_app_delivery_company_drivers WHERE id = $1 AND company_id = $2', [driverId, companyId]);
      if (cur.rows[0]?.user_id) {
        await pool.query("UPDATE pedidos_app_users SET status = 'Inactivo' WHERE id = $1", [cur.rows[0].user_id]);
      }
      const { rowCount } = await pool.query(`
        DELETE FROM pedidos_app_delivery_company_drivers WHERE id = $1 AND company_id = $2
      `, [driverId, companyId]);
      if (!rowCount) return res.status(404).json({ error: 'Mensajero no encontrado' });
      res.json({ status: 'ok', message: 'Mensajero eliminado' });
    } catch (error) {
      console.error('Error deleting company driver:', error);
      res.status(500).json({ error: 'No fue posible eliminar el mensajero' });
    }
  });

  app.get('/api/pedidos/admin/delivery-companies/:id/orders', ...canView, async (req, res) => {
    try {
      const companyId = Number(req.params.id);
      const { status, driverId, limit = 50 } = req.query;

      let filterSql = 'WHERE o.external_delivery_company_id = $1';
      const params = [companyId];

      if (status) {
        params.push(status);
        filterSql += ` AND o.delivery_status = $${params.length}`;
      }
      if (driverId) {
        params.push(Number(driverId));
        filterSql += ` AND (o.external_driver_id = $${params.length} OR o.delivery_user_id = (SELECT user_id FROM pedidos_app_delivery_company_drivers WHERE id = $${params.length}))`;
      }

      params.push(Math.min(100, Math.max(1, Number(limit) || 50)));

      const { rows } = await pool.query(`
        SELECT o.id, o.customer_name, o.customer_phone, o.address,
               o.status, o.delivery_status, o.total, o.payment_method,
               o.delivery_fee, o.external_delivery_cost,
               (COALESCE(o.delivery_fee, 0) - COALESCE(o.external_delivery_cost, 0)) AS logistics_margin,
               o.external_driver_id, o.external_driver_name, o.external_driver_phone,
               o.external_vehicle_id, o.delivery_user_id,
               o.created_at, o.external_assigned_at, o.external_handed_off_at,
               o.delivered_at, o.delivery_completed_at, o.external_delivery_confirmed_at,
               o.delivery_duration_seconds,
               d.name AS registered_driver_name,
               d.phone AS registered_driver_phone
        FROM pedidos_app_orders o
        LEFT JOIN pedidos_app_delivery_company_drivers d ON d.id = o.external_driver_id
        ${filterSql}
        ORDER BY o.created_at DESC
        LIMIT $${params.length}
      `, params);

      res.json({ status: 'ok', orders: rows });
    } catch (error) {
      console.error('Error consultando pedidos de la empresa:', error);
      res.status(500).json({ error: 'No fue posible cargar los pedidos de la empresa' });
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
      const externalDriverId = req.body.driverId || req.body.externalDriverId ? Number(req.body.driverId || req.body.externalDriverId) : null;
      let assignedDeliveryUserId = null;
      if (externalDriverId) {
        const dRow = await client.query('SELECT user_id FROM pedidos_app_delivery_company_drivers WHERE id=$1', [externalDriverId]);
        assignedDeliveryUserId = dRow.rows[0]?.user_id || null;
      }
      const updated = await client.query(`
        UPDATE pedidos_app_orders SET
          status='Asignado externo', delivery_status='Asignado externo',
          delivery_provider_type=$1, delivery_user_id=$12,
          external_delivery_company_id=$2, external_driver_name=$3,
          external_driver_phone=$4, external_vehicle_id=$5,
          external_delivery_cost=$6, external_delivery_notes=$7,
          external_eta_minutes=$8, external_provider_reference=$9,
          external_driver_id=$10,
          external_assigned_at=NOW(), external_handed_off_at=NULL,
          external_delivery_confirmed_at=NULL, external_delivery_confirmed_by=NULL,
          external_delivery_confirmed_by_name=NULL, external_delivery_confirmation_notes=NULL,
          delivery_accepted_at=NULL, picked_up_at=NULL, on_the_way_at=NULL,
          version=version+1, updated_at=NOW()
        WHERE id=$11 RETURNING *
      `, [
        providerType, companyId, cleanText(req.body.driverName, 160), cleanText(req.body.driverPhone, 30),
        cleanText(req.body.vehicleId, 80), cost, cleanText(req.body.notes, 3000), eta,
        cleanText(req.body.providerReference, 160), externalDriverId, orderId, assignedDeliveryUserId
      ]);
      order = updated.rows[0];
      const eventType = previousUserId || current.external_delivery_company_id ? 'reassigned' : 'assigned_external';
      await recordEvent(client, order, eventType, req.user, 'Entrega asignada a operador logístico externo', {
        previousDeliveryUserId: previousUserId,
        previousCompanyId: current.external_delivery_company_id,
        assignedDeliveryUserId,
      });
      if (previousUserId && previousUserId !== assignedDeliveryUserId) {
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
      if (assignedDeliveryUserId) {
        await client.query(`
          UPDATE pedidos_app_delivery_profiles SET
            availability_status = 'Ocupado',
            updated_at=NOW()
          WHERE user_id=$1
        `, [assignedDeliveryUserId]);
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
          external_delivery_confirmed_at=$1::timestamptz, external_delivery_confirmed_by=$2,
          external_delivery_confirmed_by_name=$3, external_delivery_confirmation_notes=$4,
          delivery_completed_at=$1::timestamptz, delivered_at=COALESCE(delivered_at, $1::timestamp),
          completed_at=COALESCE(completed_at, $1::timestamp),
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
      res.status(500).json({ error: error.message || 'No fue posible confirmar la entrega externa' });
    } finally {
      client.release();
    }
  });
};
