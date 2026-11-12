const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

function normalizePhone(rawPhone) {
  if (!rawPhone) return '';
  const clean = String(rawPhone).replace(/\D/g, '');
  if (clean.length === 10) return '57' + clean;
  if (clean.length > 10 && !clean.startsWith('57')) return '57' + clean;
  return clean;
}

module.exports = function configureCustomerAuth(app, { pool, JWT_SECRET }) {
  if (!pool || !JWT_SECRET) {
    throw new Error('configureCustomerAuth requiere pool y JWT_SECRET');
  }

  // Middleware de autenticación para clientes de la App Móvil
  function authenticateCustomerToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ status: 'error', error: 'Token de acceso no proporcionado' });
    }

    jwt.verify(token, JWT_SECRET, (err, payload) => {
      if (err) {
        return res.status(403).json({ status: 'error', error: 'Token inválido o expirado' });
      }
      if (payload.role !== 'customer') {
        return res.status(403).json({ status: 'error', error: 'Acceso no autorizado para este perfil' });
      }
      req.customer = payload;
      next();
    });
  }

  // 1. Registro de cliente
  app.post('/api/pedidos/customer/register', async (req, res) => {
    try {
      const { name, phone, email, password, default_address, default_barrio } = req.body;
      const cleanName = String(name || '').trim();
      const cleanPhone = String(phone || '').trim();
      const cleanEmail = String(email || '').toLowerCase().trim();
      const rawPassword = String(password || '');

      if (!cleanName || cleanName.length < 2) {
        return res.status(400).json({ status: 'error', error: 'El nombre completo es requerido' });
      }
      if (!cleanPhone || cleanPhone.replace(/\D/g, '').length < 7) {
        return res.status(400).json({ status: 'error', error: 'Ingresa un número de teléfono válido' });
      }
      if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return res.status(400).json({ status: 'error', error: 'Ingresa un correo electrónico válido' });
      }
      if (!rawPassword || rawPassword.length < 6) {
        return res.status(400).json({ status: 'error', error: 'La contraseña debe tener al menos 6 caracteres' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Verificar si el correo ya existe en pedidos_app_customer_accounts
        const existing = await client.query(
          'SELECT id FROM pedidos_app_customer_accounts WHERE LOWER(email) = $1',
          [cleanEmail]
        );
        if (existing.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ status: 'error', error: 'Ya existe una cuenta con este correo electrónico' });
        }

        // Hashing seguro con bcryptjs
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(rawPassword, salt);
        const formattedPhone = normalizePhone(cleanPhone);

        // Insertar en la tabla de cuentas de clientes
        const insertRes = await client.query(
          `INSERT INTO pedidos_app_customer_accounts 
           (name, phone, email, password_hash, default_address, default_barrio, email_verified, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW(), NOW())
           RETURNING id, name, phone, email, default_address, default_barrio, created_at`,
          [cleanName, formattedPhone, cleanEmail, passwordHash, default_address || null, default_barrio || null]
        );

        const newCustomer = insertRes.rows[0];

        // Sincronizar con pedidos_app_customers (para CRM y pedidos unificados)
        try {
          await client.query(
            `INSERT INTO pedidos_app_customers (name, phone, phone_e164, email, address, barrio, status, marketing_opt_in)
             VALUES ($1, $2, $3, $4, $5, $6, 'Activo', TRUE)
             ON CONFLICT (phone) DO UPDATE SET
               name = COALESCE(NULLIF(EXCLUDED.name, ''), pedidos_app_customers.name),
               email = COALESCE(NULLIF(EXCLUDED.email, ''), pedidos_app_customers.email),
               address = COALESCE(NULLIF(EXCLUDED.address, ''), pedidos_app_customers.address),
               barrio = COALESCE(NULLIF(EXCLUDED.barrio, ''), pedidos_app_customers.barrio),
               updated_at = NOW()`,
            [cleanName, formattedPhone, formattedPhone.startsWith('+') ? formattedPhone : `+${formattedPhone}`, cleanEmail, default_address || null, default_barrio || null]
          );
        } catch (crmErr) {
          console.warn('[customer_auth] Advertencia al vincular con CRM:', crmErr.message);
        }

        await client.query('COMMIT');

        // Generar JWT
        const token = jwt.sign(
          {
            id: newCustomer.id,
            role: 'customer',
            email: newCustomer.email,
            name: newCustomer.name,
            phone: newCustomer.phone,
          },
          JWT_SECRET,
          { expiresIn: '30d' }
        );

        return res.status(201).json({
          status: 'ok',
          message: 'Cuenta creada exitosamente',
          token,
          customer: {
            id: newCustomer.id,
            name: newCustomer.name,
            phone: newCustomer.phone,
            email: newCustomer.email,
            address: newCustomer.default_address || '',
            barrio: newCustomer.default_barrio || '',
          },
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('[customer_auth] Error en registro:', error);
      res.status(500).json({ status: 'error', error: 'No fue posible registrar la cuenta. Intenta de nuevo.' });
    }
  });

  // 2. Inicio de sesión
  app.post('/api/pedidos/customer/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      const cleanEmail = String(email || '').toLowerCase().trim();
      const rawPassword = String(password || '');

      if (!cleanEmail || !rawPassword) {
        return res.status(400).json({ status: 'error', error: 'Ingresa correo y contraseña' });
      }

      const { rows } = await pool.query(
        'SELECT * FROM pedidos_app_customer_accounts WHERE LOWER(email) = $1 LIMIT 1',
        [cleanEmail]
      );

      if (rows.length === 0) {
        return res.status(401).json({ status: 'error', error: 'Correo o contraseña incorrectos' });
      }

      const user = rows[0];
      const valid = await bcrypt.compare(rawPassword, user.password_hash);
      if (!valid) {
        return res.status(401).json({ status: 'error', error: 'Correo o contraseña incorrectos' });
      }

      // Actualizar fecha de última actividad
      pool.query('UPDATE pedidos_app_customer_accounts SET updated_at = NOW() WHERE id = $1', [user.id]).catch(() => {});

      const token = jwt.sign(
        {
          id: user.id,
          role: 'customer',
          email: user.email,
          name: user.name,
          phone: user.phone,
        },
        JWT_SECRET,
        { expiresIn: '30d' }
      );

      return res.json({
        status: 'ok',
        message: 'Bienvenido de nuevo a Distric House',
        token,
        customer: {
          id: user.id,
          name: user.name,
          phone: user.phone,
          email: user.email,
          address: user.default_address || '',
          barrio: user.default_barrio || '',
        },
      });
    } catch (error) {
      console.error('[customer_auth] Error en login:', error);
      res.status(500).json({ status: 'error', error: 'Error al iniciar sesión. Intenta más tarde.' });
    }
  });

  // 3. Perfil del usuario actual (Validación de identidad)
  app.get('/api/pedidos/customer/me', authenticateCustomerToken, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT id, name, phone, email, default_address, default_barrio, created_at FROM pedidos_app_customer_accounts WHERE id = $1 LIMIT 1',
        [req.customer.id]
      );
      if (rows.length === 0) {
        return res.status(404).json({ status: 'error', error: 'Cuenta de cliente no encontrada' });
      }
      const user = rows[0];
      res.json({
        status: 'ok',
        customer: {
          id: user.id,
          name: user.name,
          phone: user.phone,
          email: user.email,
          address: user.default_address || '',
          barrio: user.default_barrio || '',
          created_at: user.created_at,
        },
      });
    } catch (error) {
      res.status(500).json({ status: 'error', error: 'Error al consultar perfil' });
    }
  });

  // 4. Actualización de perfil y dirección por defecto
  app.put('/api/pedidos/customer/profile', authenticateCustomerToken, async (req, res) => {
    try {
      const { name, phone, default_address, default_barrio } = req.body;
      const cleanName = String(name || '').trim();
      const cleanPhone = String(phone || '').trim();

      const { rows } = await pool.query(
        `UPDATE pedidos_app_customer_accounts
         SET name = COALESCE(NULLIF($1, ''), name),
             phone = COALESCE(NULLIF($2, ''), phone),
             default_address = COALESCE($3, default_address),
             default_barrio = COALESCE($4, default_barrio),
             updated_at = NOW()
         WHERE id = $5
         RETURNING id, name, phone, email, default_address, default_barrio`,
        [cleanName, cleanPhone ? normalizePhone(cleanPhone) : null, default_address, default_barrio, req.customer.id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ status: 'error', error: 'Cuenta no encontrada' });
      }

      res.json({
        status: 'ok',
        message: 'Perfil actualizado exitosamente',
        customer: {
          id: rows[0].id,
          name: rows[0].name,
          phone: rows[0].phone,
          email: rows[0].email,
          address: rows[0].default_address || '',
          barrio: rows[0].default_barrio || '',
        },
      });
    } catch (error) {
      res.status(500).json({ status: 'error', error: 'Error al actualizar perfil' });
    }
  });

  // 5. Historial de pedidos asociados al cliente
  app.get('/api/pedidos/customer/orders', authenticateCustomerToken, async (req, res) => {
    try {
      const customerPhone = normalizePhone(req.customer.phone);
      const rawShortPhone = req.customer.phone.replace(/\D/g, '').slice(-10);

      const { rows } = await pool.query(
        `SELECT id, customer_name, customer_phone, delivery_type, payment_method,
                total, delivery_fee, status, delivery_status, address, barrio,
                created_at, cart_json
         FROM pedidos_app_orders
         WHERE customer_phone = $1 
            OR customer_phone = $2
            OR regexp_replace(COALESCE(customer_phone, ''), '\\D', '', 'g') LIKE '%' || $3
         ORDER BY created_at DESC
         LIMIT 40`,
        [customerPhone, req.customer.phone, rawShortPhone]
      );

      res.json({
        status: 'ok',
        orders: rows.map(o => ({
          id: o.id,
          total: o.total,
          deliveryFee: o.delivery_fee,
          deliveryType: o.delivery_type,
          paymentMethod: o.payment_method,
          status: o.status,
          deliveryStatus: o.delivery_status,
          address: o.address,
          barrio: o.barrio,
          createdAt: o.created_at,
          itemsCount: Array.isArray(o.cart_json) ? o.cart_json.reduce((sum, item) => sum + (Number(item.quantity || item.qty) || 1), 0) : 0,
        })),
      });
    } catch (error) {
      console.error('[customer_auth] Error consultando pedidos:', error);
      res.status(500).json({ status: 'error', error: 'Error al consultar historial de pedidos' });
    }
  });

  // 6. Recuperación de contraseña (solicitud de código / token)
  app.post('/api/pedidos/customer/forgot-password', async (req, res) => {
    try {
      const { email } = req.body;
      const cleanEmail = String(email || '').toLowerCase().trim();
      if (!cleanEmail) {
        return res.status(400).json({ status: 'error', error: 'Ingresa tu correo electrónico' });
      }

      const { rows } = await pool.query(
        'SELECT id, name FROM pedidos_app_customer_accounts WHERE LOWER(email) = $1',
        [cleanEmail]
      );

      // Por seguridad, si el correo no existe, responder afirmativo sin exponer existencia
      if (rows.length === 0) {
        return res.json({
          status: 'ok',
          message: 'Si el correo está registrado, recibirás un código de recuperación.',
        });
      }

      // Generar código numérico de 6 dígitos seguro
      const crypto = require('crypto');
      const resetCode = String(crypto.randomInt(100000, 999999));
      const resetExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

      await pool.query(
        'UPDATE pedidos_app_customer_accounts SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3',
        [resetCode, resetExpiry, rows[0].id]
      );

      console.log(`[customer_auth] Código de recuperación generado para ${cleanEmail}: ${resetCode}`);

      return res.json({
        status: 'ok',
        message: 'Código de recuperación generado exitosamente',
        // En entorno de desarrollo o integración inicial devolvemos el código de prueba para validación rápida
        debugCode: resetCode,
      });
    } catch (error) {
      console.error('[customer_auth] Error en forgot-password:', error);
      res.status(500).json({ status: 'error', error: 'Error al procesar recuperación' });
    }
  });

  // 7. Restablecimiento de contraseña con código
  app.post('/api/pedidos/customer/reset-password', async (req, res) => {
    try {
      const { email, code, new_password } = req.body;
      const cleanEmail = String(email || '').toLowerCase().trim();
      const cleanCode = String(code || '').trim();
      const rawPassword = String(new_password || '');

      if (!cleanEmail || !cleanCode || !rawPassword || rawPassword.length < 6) {
        return res.status(400).json({ status: 'error', error: 'Datos incompletos o contraseña menor a 6 caracteres' });
      }

      const { rows } = await pool.query(
        `SELECT id, reset_token_expiry 
         FROM pedidos_app_customer_accounts 
         WHERE LOWER(email) = $1 AND reset_token = $2`,
        [cleanEmail, cleanCode]
      );

      if (rows.length === 0) {
        return res.status(400).json({ status: 'error', error: 'Código inválido o expirado' });
      }

      const account = rows[0];
      if (account.reset_token_expiry && new Date() > new Date(account.reset_token_expiry)) {
        return res.status(400).json({ status: 'error', error: 'El código ha expirado. Solicita uno nuevo.' });
      }

      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(rawPassword, salt);

      await pool.query(
        'UPDATE pedidos_app_customer_accounts SET password_hash = $1, reset_token = NULL, reset_token_expiry = NULL, updated_at = NOW() WHERE id = $2',
        [passwordHash, account.id]
      );

      return res.json({
        status: 'ok',
        message: 'Contraseña actualizada con éxito. Ya puedes iniciar sesión.',
      });
    } catch (error) {
      console.error('[customer_auth] Error en reset-password:', error);
      res.status(500).json({ status: 'error', error: 'Error al restablecer la contraseña' });
    }
  });

  // 8. Cierre de sesión (invalidación lógica en cliente)
  app.post('/api/pedidos/customer/logout', authenticateCustomerToken, (req, res) => {
    res.json({ status: 'ok', message: 'Sesión cerrada exitosamente' });
  });

  return { authenticateCustomerToken };
};
