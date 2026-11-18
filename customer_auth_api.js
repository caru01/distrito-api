const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

function normalizePhone(rawPhone) {
  if (!rawPhone) return '';
  const clean = String(rawPhone).replace(/\D/g, '');
  if (clean.length === 10) return '57' + clean;
  if (clean.length > 10 && !clean.startsWith('57')) return '57' + clean;
  return clean;
}

module.exports = function configureCustomerAuth(app, { pool, JWT_SECRET, transporter, whatsappClient }) {
  if (!pool || !JWT_SECRET) {
    throw new Error('configureCustomerAuth requiere pool y JWT_SECRET');
  }

  async function sendSmsViaYCloud(phoneE164, text) {
    const ycloudKey = process.env.YCLOUD_API_KEY || '06f4e525b00cd3af5732167f3d750472';
    if (!ycloudKey) return;
    const target = phoneE164.startsWith('+') ? phoneE164 : '+' + phoneE164;
    const payload = JSON.stringify({ to: target, text: text });
    return new Promise((resolve) => {
      const https = require('https');
      const req = https.request({
        hostname: 'api.ycloud.com',
        port: 443,
        path: '/v2/sms',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': ycloudKey,
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 8000
      }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[customer_auth] SMS de texto enviado exitosamente a ${target}:`, body);
          } else {
            console.warn(`[customer_auth] YCloud SMS status (${res.statusCode}):`, body);
          }
          resolve();
        });
      });
      req.on('error', (err) => {
        console.error(`[customer_auth] Error enviando SMS a ${target}:`, err.message);
        resolve();
      });
      req.write(payload);
      req.end();
    });
  }

  async function dispatchVerificationCode({ destination, channel, code, name }) {
    const isPhone = channel === 'celular' || channel === 'phone' || /^\+?\d{7,15}$/.test(destination);
    if (isPhone) {
      const phone = normalizePhone(destination);
      const textMessage = `Distric House: Tu codigo de verificacion es ${code}. Valido por 15 minutos.`;

      // 1. Envío prioritario por Mensaje de Texto (SMS)
      try {
        await sendSmsViaYCloud(phone, textMessage);
      } catch (err) {
        console.error(`[customer_auth] Error en despacho SMS:`, err.message);
      }

      // 2. Envío de respaldo por WhatsApp si el cliente está conectado
      if (whatsappClient && typeof whatsappClient.sendText === 'function') {
        try {
          await whatsappClient.sendText({
            to: phone,
            body: `🍔 *Distric House*\n\nHola ${name || 'Cliente'}, tu código de verificación es:\n\n*${code}*\n\nEste código vence en 15 minutos. Úsalo en la app para continuar.`,
          });
          console.log(`[customer_auth] WhatsApp enviado exitosamente a ${phone}`);
        } catch (e) {
          console.warn(`[customer_auth] Envío WhatsApp secundario a ${phone}:`, e.message);
        }
      }
    } else {
      if (transporter && typeof transporter.sendMail === 'function') {
        try {
          await transporter.sendMail({
            from: '"Distric House" <' + (process.env.EMAIL_USER || 'info@distritobg.app') + '>',
            to: destination,
            subject: `Tu código de verificación Distric House: ${code}`,
            html: `
              <div style="font-family: Arial, sans-serif; padding: 24px; max-width: 480px; margin: 0 auto; border: 1px solid #E5E7EB; border-radius: 12px; background: #FFFFFF;">
                <h2 style="color: #B30401; margin-top: 0; font-size: 22px;">Distric House</h2>
                <p style="font-size: 15px; color: #111827;">Hola <b>${name || 'Cliente'}</b>,</p>
                <p style="font-size: 14px; color: #4B5563;">Tu código de verificación es:</p>
                <div style="text-align: center; margin: 24px 0;">
                  <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #B30401; background: #FEF2F2; padding: 12px 24px; border-radius: 8px; border: 1px dashed #B30401; display: inline-block;">${code}</span>
                </div>
                <p style="font-size: 12px; color: #9CA3AF;">Válido por 1 hora. Si no lo solicitaste, puedes ignorar este correo.</p>
              </div>
            `,
          });
          console.log(`[customer_auth] Correo enviado exitosamente a ${destination}`);
        } catch (e) {
          console.error(`[customer_auth] Error enviando correo a ${destination}:`, e.message);
        }
      }
    }
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

        const formattedPhone = normalizePhone(cleanPhone);
        const cleanPhoneDigits = formattedPhone.replace(/\D/g, '').slice(-10);

        // 1. Verificar si el teléfono ya existe en appmobile_customer_accounts
        const existingPhone = await client.query(
          `SELECT id FROM appmobile_customer_accounts 
           WHERE phone = $1 
              OR ($2 <> '' AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE '%' || $2)
           LIMIT 1`,
          [formattedPhone, cleanPhoneDigits]
        );
        if (existingPhone.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ 
            status: 'error', 
            error: 'Este número de teléfono ya tiene una cuenta registrada. Por favor inicia sesión.' 
          });
        }

        // 2. Verificar si el correo ya existe en appmobile_customer_accounts
        const existing = await client.query(
          'SELECT id FROM appmobile_customer_accounts WHERE LOWER(email) = $1',
          [cleanEmail]
        );
        if (existing.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ status: 'error', error: 'Ya existe una cuenta con este correo electrónico' });
        }

        // Hashing seguro con bcryptjs
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(rawPassword, salt);

        // Insertar en la tabla de cuentas de clientes
        const insertRes = await client.query(
          `INSERT INTO appmobile_customer_accounts 
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

  // 2. Inicio de sesión (Soporta teléfono o correo)
  app.post('/api/pedidos/customer/login', async (req, res) => {
    try {
      const identifier = String(req.body.phone || req.body.email || req.body.identifier || '').trim();
      const rawPassword = String(req.body.password || '');

      if (!identifier || !rawPassword) {
        return res.status(400).json({ status: 'error', error: 'Ingresa tu número de teléfono (o correo) y contraseña' });
      }

      const cleanEmail = identifier.toLowerCase();
      const rawDigits = identifier.replace(/\D/g, '');
      const cleanPhoneDigits = rawDigits.length >= 7 ? rawDigits.slice(-10) : '';

      const { rows } = await pool.query(
        `SELECT * FROM appmobile_customer_accounts 
         WHERE LOWER(email) = $1 
            OR ($2 <> '' AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE '%' || $2)
         LIMIT 1`,
        [cleanEmail, cleanPhoneDigits]
      );

      if (rows.length === 0) {
        return res.status(401).json({ status: 'error', error: 'Teléfono/correo o contraseña incorrectos' });
      }

      const user = rows[0];
      const valid = await bcrypt.compare(rawPassword, user.password_hash);
      if (!valid) {
        return res.status(401).json({ status: 'error', error: 'Correo o contraseña incorrectos' });
      }

      // Actualizar fecha de última actividad
      pool.query('UPDATE appmobile_customer_accounts SET updated_at = NOW() WHERE id = $1', [user.id]).catch(() => {});

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
        'SELECT id, name, phone, email, default_address, default_barrio, created_at FROM appmobile_customer_accounts WHERE id = $1 LIMIT 1',
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
        `UPDATE appmobile_customer_accounts
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

  // 6. Recuperación de contraseña (solicitud de código / token por Correo o por Celular)
  app.post('/api/pedidos/customer/forgot-password', async (req, res) => {
    try {
      const { email, phone, identifier, channel } = req.body;
      const targetIdentifier = String(phone || email || identifier || '').trim();
      const cleanEmail = targetIdentifier.toLowerCase();
      const rawDigits = targetIdentifier.replace(/\D/g, '');
      const cleanPhoneDigits = rawDigits.length >= 7 ? rawDigits.slice(-10) : '';

      if (!targetIdentifier) {
        return res.status(400).json({ status: 'error', error: 'Ingresa tu número de celular o correo' });
      }

      const { rows } = await pool.query(
        `SELECT id, name, phone, email 
         FROM appmobile_customer_accounts 
         WHERE LOWER(email) = $1 
            OR ($2 <> '' AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE '%' || $2)
         LIMIT 1`,
        [cleanEmail, cleanPhoneDigits]
      );

      // Si no existe la cuenta, responder de forma segura
      if (rows.length === 0) {
        return res.json({
          status: 'ok',
          message: 'Si los datos están registrados, recibirás un código de recuperación.',
        });
      }

      const account = rows[0];

      // Generar código numérico de 6 dígitos seguro
      const crypto = require('crypto');
      const resetCode = String(crypto.randomInt(100000, 999999));
      const resetExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hora de validez

      await pool.query(
        'UPDATE appmobile_customer_accounts SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3',
        [resetCode, resetExpiry, account.id]
      );

      const targetMedium = (channel === 'phone' || cleanPhoneDigits.length >= 7) ? 'celular' : 'correo';
      console.log(`[customer_auth] Código de recuperación generado para ${account.phone || account.email} (${targetMedium}): ${resetCode}`);

      // Envío real por WhatsApp o por Correo según el canal elegido
      await dispatchVerificationCode({
        destination: targetMedium === 'celular' ? (account.phone || targetIdentifier) : account.email,
        channel: targetMedium,
        code: resetCode,
        name: account.name,
      });

      return res.json({
        status: 'ok',
        channel: targetMedium,
        destination: targetMedium === 'celular' ? account.phone : account.email,
        message: targetMedium === 'celular'
            ? `Código SMS enviado al celular ${account.phone}`
            : `Código enviado al correo ${account.email}`,
        debugCode: resetCode,
      });
    } catch (error) {
      console.error('[customer_auth] Error en forgot-password:', error);
      res.status(500).json({ status: 'error', error: 'Error al procesar recuperación' });
    }
  });

  // 7. Restablecimiento de contraseña con código (acepta correo o teléfono)
  app.post('/api/pedidos/customer/reset-password', async (req, res) => {
    try {
      const { email, phone, identifier, code, new_password } = req.body;
      const targetIdentifier = String(phone || email || identifier || '').trim();
      const cleanEmail = targetIdentifier.toLowerCase();
      const rawDigits = targetIdentifier.replace(/\D/g, '');
      const cleanPhoneDigits = rawDigits.length >= 7 ? rawDigits.slice(-10) : '';
      const cleanCode = String(code || '').trim();
      const rawPassword = String(new_password || '');

      if (!targetIdentifier || !cleanCode || !rawPassword || rawPassword.length < 6) {
        return res.status(400).json({ status: 'error', error: 'Datos incompletos o contraseña menor a 6 caracteres' });
      }

      const { rows } = await pool.query(
        `SELECT id, reset_token_expiry 
         FROM appmobile_customer_accounts 
         WHERE (LOWER(email) = $1 OR ($2 <> '' AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE '%' || $2))
           AND reset_token = $3
         LIMIT 1`,
        [cleanEmail, cleanPhoneDigits, cleanCode]
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
        'UPDATE appmobile_customer_accounts SET password_hash = $1, reset_token = NULL, reset_token_expiry = NULL, updated_at = NOW() WHERE id = $2',
        [passwordHash, account.id]
      );

      return res.json({
        status: 'ok',
        message: 'Contraseña actualizada con éxito. Ya puedes iniciar sesión con tu nueva contraseña.',
      });
    } catch (error) {
      console.error('[customer_auth] Error en reset-password:', error);
      res.status(500).json({ status: 'error', error: 'Error al restablecer la contraseña' });
    }
  });

  // 8. Enviar código de verificación por WhatsApp para registro
  app.post('/api/pedidos/customer/send-phone-code', async (req, res) => {
    try {
      const { phone } = req.body;
      const cleanPhone = String(phone || '').trim();
      const formattedPhone = normalizePhone(cleanPhone);
      const cleanPhoneDigits = formattedPhone.replace(/\D/g, '').slice(-10);

      if (!cleanPhone || cleanPhoneDigits.length < 7) {
        return res.status(400).json({ status: 'error', error: 'Ingresa un número de celular válido' });
      }

      // Verificar si ya existe registrado
      const existing = await pool.query(
        `SELECT id FROM appmobile_customer_accounts 
         WHERE phone = $1 
            OR ($2 <> '' AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE '%' || $2)
         LIMIT 1`,
        [formattedPhone, cleanPhoneDigits]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ 
          status: 'error', 
          error: 'Este número de teléfono ya tiene una cuenta registrada. Por favor inicia sesión.' 
        });
      }

      const crypto = require('crypto');
      const code = String(crypto.randomInt(100000, 999999));
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

      await pool.query(
        'INSERT INTO appmobile_phone_verifications (phone, code, expires_at) VALUES ($1, $2, $3)',
        [cleanPhoneDigits, code, expiresAt]
      );

      await dispatchVerificationCode({
        destination: formattedPhone,
        channel: 'celular',
        code: code,
        name: 'Cliente',
      });

      res.json({
        status: 'ok',
        message: `Código SMS enviado a ${cleanPhone}`,
        debugCode: code,
      });
    } catch (e) {
      console.error('[customer_auth] Error enviando código celular:', e);
      res.status(500).json({ status: 'error', error: 'No se pudo enviar el código' });
    }
  });

  // 9. Validar código de verificación telefónico para registro
  app.post('/api/pedidos/customer/verify-phone-code', async (req, res) => {
    try {
      const { phone, code } = req.body;
      const cleanPhoneDigits = String(phone || '').replace(/\D/g, '').slice(-10);
      const cleanCode = String(code || '').trim();

      if (!cleanPhoneDigits || !cleanCode) {
        return res.status(400).json({ status: 'error', error: 'Ingresa el teléfono y el código de 6 dígitos' });
      }

      const { rows } = await pool.query(
        `SELECT id, expires_at FROM appmobile_phone_verifications 
         WHERE phone = $1 AND code = $2 AND verified = FALSE 
         ORDER BY id DESC LIMIT 1`,
        [cleanPhoneDigits, cleanCode]
      );

      if (rows.length === 0) {
        return res.status(400).json({ status: 'error', error: 'Código de verificación incorrecto' });
      }

      if (new Date() > new Date(rows[0].expires_at)) {
        return res.status(400).json({ status: 'error', error: 'El código ha expirado. Solicita uno nuevo.' });
      }

      await pool.query('UPDATE appmobile_phone_verifications SET verified = TRUE WHERE id = $1', [rows[0].id]);

      res.json({ status: 'ok', verified: true, message: 'Número de teléfono verificado exitosamente' });
    } catch (e) {
      console.error('[customer_auth] Error verificando código celular:', e);
      res.status(500).json({ status: 'error', error: 'Error al verificar el código' });
    }
  });

  // 10. Autenticación con Google
  app.post('/api/pedidos/customer/google-auth', async (req, res) => {
    try {
      const { email, name, google_id } = req.body;
      const cleanEmail = String(email || '').toLowerCase().trim();
      const cleanName = String(name || '').trim();

      if (!cleanEmail) {
        return res.status(400).json({ status: 'error', error: 'Correo de Google no válido' });
      }

      let { rows } = await pool.query(
        'SELECT * FROM appmobile_customer_accounts WHERE LOWER(email) = $1 LIMIT 1',
        [cleanEmail]
      );

      let user;
      if (rows.length === 0) {
        const crypto = require('crypto');
        const randPass = crypto.randomBytes(16).toString('hex');
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(randPass, salt);

        const insertRes = await pool.query(
          `INSERT INTO appmobile_customer_accounts 
           (name, email, password_hash, email_verified, created_at, updated_at)
           VALUES ($1, $2, $3, TRUE, NOW(), NOW())
           RETURNING id, name, phone, email, default_address, default_barrio`,
          [cleanName || 'Cliente Google', cleanEmail, passwordHash]
        );
        user = insertRes.rows[0];
      } else {
        user = rows[0];
      }

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

      res.json({
        status: 'ok',
        message: 'Acceso exitoso con Google',
        token,
        customer: {
          id: user.id,
          name: user.name,
          phone: user.phone || '',
          email: user.email,
          address: user.default_address || '',
          barrio: user.default_barrio || '',
        },
      });
    } catch (e) {
      console.error('[customer_auth] Error en Google Auth:', e);
      res.status(500).json({ status: 'error', error: 'Error al iniciar con Google' });
    }
  });

  // 11. Cierre de sesión (invalidación lógica en cliente)
  app.post('/api/pedidos/customer/logout', authenticateCustomerToken, (req, res) => {
    res.json({ status: 'ok', message: 'Sesión cerrada exitosamente' });
  });

  return { authenticateCustomerToken };
};
