/**
 * ai_api.js - Router modular para Bony AI Assistant (Distric House)
 */

const rateLimit = require('express-rate-limit');
const { geminiService } = require('./services/geminiService');

// Rate limiting específico para AI (evita saturación y cuotas)
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 20, // 20 peticiones por minuto por IP
  message: { error: 'Has alcanzado el límite de consultas por minuto a Bony. Espera un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = function(app, { pool, authenticateToken, requirePermission }) {
  if (!app) return;

  // 1. CHAT CON BONY
  app.post('/api/pedidos/admin/ai/chat', authenticateToken, aiLimiter, async (req, res) => {
    try {
      const { message, conversationId, history } = req.body;
      const user = req.user;

      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({ error: 'El mensaje es obligatorio' });
      }

      if (message.length > 1200) {
        return res.status(400).json({ error: 'El mensaje no puede exceder 1200 caracteres' });
      }

      let activeConvId = conversationId;

      // 1. Validar estado y propiedad de la conversación si ya existe
      if (activeConvId) {
        try {
          const checkRes = await pool.query(`
            SELECT id, user_id, COALESCE(status, 'ACTIVE') as status, deleted_at
            FROM pedidos_app_ai_conversations
            WHERE id = $1 AND deleted_at IS NULL
          `, [activeConvId]);

          if (checkRes.rows.length > 0) {
            const existingConv = checkRes.rows[0];
            // Validar propiedad: solo el creador o Super Administrador
            if (existingConv.user_id && existingConv.user_id !== user?.id && user?.role !== 'Super Administrador') {
              return res.status(403).json({ 
                error: 'No tienes permiso para interactuar en esta conversación', 
                code: 'FORBIDDEN' 
              });
            }
            // Validar estado: impedir nuevos mensajes en conversaciones finalizadas
            if (existingConv.status === 'COMPLETED') {
              return res.status(409).json({ 
                error: 'Esta conversación ha sido finalizada y es de solo lectura. Por favor, inicia una nueva conversación para continuar.', 
                code: 'CONVERSATION_COMPLETED' 
              });
            }
          }
        } catch (checkErr) {
          console.warn('Nota: Verificación de estado de conversación en DB:', checkErr.message);
        }
      }

      // 2. Guardar o crear conversación si existe la tabla
      try {
        if (!activeConvId) {
          const title = message.trim().substring(0, 50) + (message.length > 50 ? '…' : '');
          const convRes = await pool.query(`
            INSERT INTO pedidos_app_ai_conversations (user_id, title, status, created_at, updated_at)
            VALUES ($1, $2, 'ACTIVE', NOW(), NOW())
            RETURNING id, status
          `, [user?.id || null, title]);
          activeConvId = convRes.rows[0]?.id;
        }

        if (activeConvId) {
          await pool.query(`
            INSERT INTO pedidos_app_ai_messages (conversation_id, role, content, created_at)
            VALUES ($1, 'user', $2, NOW())
          `, [activeConvId, message.trim()]);
        }
      } catch (dbErr) {
        // Fallback no bloqueante si las tablas aún no se han migrado
        console.warn('Nota: Historial en DB no disponible:', dbErr.message);
      }

      // 2. Invocar servicio Gemini
      const result = await geminiService.chat({
        message,
        history,
        context: { pool, user }
      });

      // 3. Guardar respuesta del asistente
      try {
        if (activeConvId) {
          await pool.query(`
            INSERT INTO pedidos_app_ai_messages (conversation_id, role, content, tool_calls, tokens_estimated, created_at)
            VALUES ($1, 'assistant', $2, $3, $4, NOW())
          `, [
            activeConvId,
            result.response,
            JSON.stringify(result.executedActions || []),
            result.tokens || 0
          ]);

          await pool.query(`
            UPDATE pedidos_app_ai_conversations SET updated_at = NOW() WHERE id = $1
          `, [activeConvId]);
        }
      } catch (dbErr) {}

      return res.json({
        status: 'ok',
        conversationId: activeConvId,
        reply: result.response,
        response: result.response,
        toolCalls: result.executedActions || [],
        executedActions: result.executedActions || [],
        model: result.model
      });

    } catch (err) {
      const statusCode = err.statusCode || (err.code === 'MISSING_API_KEY' ? 503 : 500);
      return res.status(statusCode).json({
        error: err.message || 'Error al procesar la solicitud con Bony',
        code: err.code || 'AI_ERROR'
      });
    }
  });

  // 2. OBTENER RESUMEN EJECUTIVO (KPIs RÁPIDOS)
  app.get('/api/pedidos/admin/ai/overview', authenticateToken, async (req, res) => {
    try {
      // Consultas deterministas ultra-rápidas para la cabecera de Bony
      const salesToday = await pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status IN ('Entregado', 'Completado')) as pedidos_hoy,
          COALESCE(SUM(total - COALESCE(delivery_fee, 0)) FILTER (WHERE status IN ('Entregado', 'Completado')), 0) as venta_comida_hoy
        FROM pedidos_app_orders
        WHERE created_at >= CURRENT_DATE
      `);

      const criticalStock = await pool.query(`
        SELECT COUNT(*) as insumos_criticos
        FROM pedidos_app_inventory
        WHERE stock <= min_stock
      `);

      const activeOrders = await pool.query(`
        SELECT COUNT(*) as en_cocina
        FROM pedidos_app_orders
        WHERE status IN ('Nuevo', 'En preparación', 'Listo')
      `);

      res.json({
        status: 'ok',
        overview: {
          pedidos_entregados_hoy: Number(salesToday.rows[0]?.pedidos_hoy || 0),
          venta_comida_hoy: Number(salesToday.rows[0]?.venta_comida_hoy || 0),
          insumos_en_alerta: Number(criticalStock.rows[0]?.insumos_criticos || 0),
          pedidos_activos_cocina: Number(activeOrders.rows[0]?.en_cocina || 0)
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 3. ALERTAS OPERATIVAS INTELIGENTES
  app.get('/api/pedidos/admin/ai/alerts', authenticateToken, async (req, res) => {
    try {
      const alerts = [];

      // A. Insumos agotados o por debajo del mínimo
      const stockRes = await pool.query(`
        SELECT name, stock, min_stock, unit
        FROM pedidos_app_inventory
        WHERE stock <= min_stock
        ORDER BY stock ASC
        LIMIT 5
      `);
      for (const row of stockRes.rows) {
        alerts.push({
          type: 'INVENTORY_CRITICAL',
          severity: Number(row.stock) <= 0 ? 'critical' : 'warning',
          title: `Stock bajo en ${row.name}`,
          message: `Quedan ${row.stock} ${row.unit} (Mínimo: ${row.min_stock}). Se recomienda reponer pronto.`
        });
      }

      // B. Pedidos con espera prolongada (>35 min en cocina)
      const delayRes = await pool.query(`
        SELECT id, customer_name, EXTRACT(EPOCH FROM (NOW() - created_at))/60 as minutos
        FROM pedidos_app_orders
        WHERE status IN ('Nuevo', 'En preparación')
          AND created_at <= NOW() - INTERVAL '35 minutes'
        LIMIT 3
      `);
      for (const row of delayRes.rows) {
        alerts.push({
          type: 'KITCHEN_DELAY',
          severity: 'warning',
          title: `Demora en Pedido #${row.id}`,
          message: `El pedido de ${row.customer_name} lleva ${Math.round(row.minutos)} min en preparación.`
        });
      }

      res.json({
        status: 'ok',
        alerts
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 4. HISTORIAL DE CONVERSACIONES
  app.get('/api/pedidos/admin/ai/conversations', authenticateToken, async (req, res) => {
    try {
      const userId = req.user?.id;
      const { rows } = await pool.query(`
        SELECT 
          id, title, summary, 
          COALESCE(status, 'ACTIVE') as status, 
          created_at, updated_at, completed_at
        FROM pedidos_app_ai_conversations
        WHERE deleted_at IS NULL AND (user_id = $1 OR user_id IS NULL)
        ORDER BY updated_at DESC
        LIMIT 40
      `, [userId]).catch(() => ({ rows: [] }));

      res.json({ status: 'ok', conversations: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 5. CREAR CONVERSACIÓN EXPLÍCITA NUEVA
  app.post('/api/pedidos/admin/ai/conversations', authenticateToken, async (req, res) => {
    try {
      const userId = req.user?.id;
      const title = (req.body?.title || 'Nueva conversación').trim().substring(0, 80);

      const convRes = await pool.query(`
        INSERT INTO pedidos_app_ai_conversations (user_id, title, status, created_at, updated_at)
        VALUES ($1, $2, 'ACTIVE', NOW(), NOW())
        RETURNING id, title, status, created_at, updated_at
      `, [userId || null, title]).catch(() => ({ rows: [{ id: Date.now(), title, status: 'ACTIVE' }] }));

      res.status(201).json({ status: 'ok', conversation: convRes.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 6. OBTENER MENSAJES DE UNA CONVERSACIÓN
  app.get('/api/pedidos/admin/ai/conversations/:id', authenticateToken, async (req, res) => {
    try {
      const convId = req.params.id;
      const userId = req.user?.id;

      const conv = await pool.query(`
        SELECT 
          id, title, user_id, 
          COALESCE(status, 'ACTIVE') as status, 
          created_at, updated_at, completed_at
        FROM pedidos_app_ai_conversations
        WHERE id = $1 AND deleted_at IS NULL
      `, [convId]).catch(() => ({ rows: [] }));

      if (conv.rows.length === 0) {
        return res.status(404).json({ error: 'Conversación no encontrada' });
      }

      // Control de acceso: solo el creador o Super Administrador
      if (conv.rows[0].user_id && conv.rows[0].user_id !== userId && req.user?.role !== 'Super Administrador') {
        return res.status(403).json({ error: 'No tienes permiso para ver esta conversación' });
      }

      const messages = await pool.query(`
        SELECT id, role, content, tool_calls, created_at
        FROM pedidos_app_ai_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC
      `, [convId]).catch(() => ({ rows: [] }));

      res.json({ status: 'ok', conversation: conv.rows[0], messages: messages.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 7. FINALIZAR CONVERSACIÓN DE FORMA SEGURA
  app.post('/api/pedidos/admin/ai/conversations/:id/complete', authenticateToken, async (req, res) => {
    try {
      const convId = req.params.id;
      const userId = req.user?.id;
      const userRole = req.user?.role;

      // 1. Verificar existencia y pertenencia
      const convCheck = await pool.query(`
        SELECT id, user_id, title, COALESCE(status, 'ACTIVE') as status, completed_at
        FROM pedidos_app_ai_conversations
        WHERE id = $1 AND deleted_at IS NULL
      `, [convId]).catch(() => ({ rows: [] }));

      if (convCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Conversación no encontrada', code: 'NOT_FOUND' });
      }

      const targetConv = convCheck.rows[0];

      // Verificar autorización (aislamiento entre usuarios)
      if (targetConv.user_id && targetConv.user_id !== userId && userRole !== 'Super Administrador') {
        return res.status(403).json({ error: 'No tienes permiso para finalizar esta conversación', code: 'FORBIDDEN' });
      }

      // 2. Idempotencia: si ya estaba completada, responder éxito directamente
      if (targetConv.status === 'COMPLETED') {
        return res.json({
          status: 'ok',
          message: 'La conversación ya había sido finalizada previamente',
          conversation: targetConv
        });
      }

      // 3. Actualizar estado atómicamente a COMPLETED
      const updateRes = await pool.query(`
        UPDATE pedidos_app_ai_conversations
        SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND (user_id = $2 OR $3 = 'Super Administrador')
        RETURNING id, title, status, created_at, updated_at, completed_at
      `, [convId, userId, userRole || '']).catch(() => ({ rows: [{ ...targetConv, status: 'COMPLETED', completed_at: new Date().toISOString() }] }));

      res.json({
        status: 'ok',
        message: 'Conversación finalizada exitosamente',
        conversation: updateRes.rows[0]
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 8. ELIMINAR CONVERSACIÓN
  app.delete('/api/pedidos/admin/ai/conversations/:id', authenticateToken, async (req, res) => {
    try {
      const convId = req.params.id;
      const userId = req.user?.id;

      await pool.query(`
        UPDATE pedidos_app_ai_conversations
        SET deleted_at = NOW()
        WHERE id = $1 AND (user_id = $2 OR $3 = 'Super Administrador')
      `, [convId, userId, req.user?.role || '']).catch(() => {});

      res.json({ status: 'ok', message: 'Conversación eliminada' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 7. LISTAR ACCIONES PROPUESTAS (PENDIENTES DE APROBACIÓN)
  app.get('/api/pedidos/admin/ai/actions', authenticateToken, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, tool_name, action_type, parameters, status, created_at
        FROM pedidos_app_ai_actions
        WHERE status = 'pending_confirmation'
        ORDER BY created_at DESC
        LIMIT 20
      `).catch(() => ({ rows: [] }));

      res.json({ status: 'ok', actions: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 8. APROBAR Y EJECUTAR ACCIÓN
  app.post('/api/pedidos/admin/ai/actions/:id/approve', authenticateToken, async (req, res) => {
    const actionId = req.params.id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(`
        SELECT * FROM pedidos_app_ai_actions
        WHERE id = $1 FOR UPDATE
      `, [actionId]);

      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Propuesta de acción no encontrada' });
      }

      const action = rows[0];
      if (action.status !== 'pending_confirmation') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `La acción ya fue procesada (estado actual: ${action.status})` });
      }

      // Marcar en ejecución
      await client.query(`
        UPDATE pedidos_app_ai_actions
        SET status = 'executing', confirmed_by = $1, confirmed_at = NOW()
        WHERE id = $2
      `, [req.user?.id || null, actionId]);

      let executionResult = { success: true, message: 'Acción aprobada y ejecutada exitosamente' };

      // Si es compra de insumos, registrar en gastos
      const params = action.parameters || {};
      if (action.action_type === 'PURCHASE_PROPOSAL' && params.details?.insumos) {
        // Registrar en pedidos_app_expenses
        const totalAmount = params.details.totalEstimado || 0;
        await client.query(`
          INSERT INTO pedidos_app_expenses (category, description, amount, expense_date, created_at, payment_method)
          VALUES ('Otros Gastos Operativos', $1, $2, CURRENT_DATE, NOW(), 'Efectivo')
        `, [`Compra sugerida por Bony: ${params.title || 'Insumos'}`, totalAmount]);
      }

      // Marcar completada
      await client.query(`
        UPDATE pedidos_app_ai_actions
        SET status = 'completed', result = $1, updated_at = NOW()
        WHERE id = $2
      `, [JSON.stringify(executionResult), actionId]);

      // Auditoría
      await client.query(`
        INSERT INTO pedidos_app_audit_logs (user_id, module, action, details, created_at)
        VALUES ($1, 'ai_assistant', 'APPROVE_ACTION', $2, NOW())
      `, [req.user?.id || null, `Aprobada acción ${actionId} (${action.action_type})`]).catch(() => {});

      await client.query('COMMIT');
      res.json({ status: 'ok', result: executionResult });

    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // 9. CANCELAR ACCIÓN PROPUESTA
  app.post('/api/pedidos/admin/ai/actions/:id/cancel', authenticateToken, async (req, res) => {
    try {
      await pool.query(`
        UPDATE pedidos_app_ai_actions
        SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND status = 'pending_confirmation'
      `, [req.params.id]);

      res.json({ status: 'ok', message: 'Acción cancelada' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 10. LISTAR AUTOMATIZACIONES
  app.get('/api/pedidos/admin/ai/automations', authenticateToken, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT * FROM pedidos_app_ai_automations
        ORDER BY id ASC
      `).catch(() => ({ rows: [] }));

      // Si no hay automatizaciones creadas aún, devolvemos las plantillas sugeridas del sistema
      if (rows.length === 0) {
        return res.json({
          status: 'ok',
          automations: [
            {
              id: 1,
              name: 'Alerta Diaria de Stock Crítico',
              automation_type: 'stock_alerts',
              frequency: 'daily',
              cron_expression: '0 10 * * *',
              is_active: true,
              parameters: { threshold: 'min_stock' }
            },
            {
              id: 2,
              name: 'Resumen Matutino de Ventas y Márgenes',
              automation_type: 'sales_summary',
              frequency: 'daily',
              cron_expression: '0 8 * * *',
              is_active: true,
              parameters: { includeCogs: true }
            },
            {
              id: 3,
              name: 'Detección de Retrasos en Cocina',
              automation_type: 'pending_orders_alert',
              frequency: 'hourly',
              cron_expression: '*/30 * * * *',
              is_active: false,
              parameters: { maxWaitMinutes: 30 }
            }
          ]
        });
      }

      res.json({ status: 'ok', automations: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 11. EJECUTAR AUTOMATIZACIÓN MANUALMENTE
  app.post('/api/pedidos/admin/ai/automations/:id/run', authenticateToken, async (req, res) => {
    try {
      const autoId = req.params.id;
      // Ejecución determinista del reporte de la automatización
      let resultSummary = '';
      if (autoId === '1' || autoId === 1) {
        const crit = await pool.query(`SELECT COUNT(*) as c FROM pedidos_app_inventory WHERE stock <= min_stock`);
        resultSummary = `Auditoría ejecutada: ${crit.rows[0]?.c || 0} insumos requieren reposición.`;
      } else {
        const sales = await pool.query(`
          SELECT COUNT(*) as c, COALESCE(SUM(total), 0) as s 
          FROM pedidos_app_orders 
          WHERE created_at >= NOW() - INTERVAL '24 hours' AND status IN ('Entregado', 'Completado')
        `);
        resultSummary = `Resumen 24h: ${sales.rows[0]?.c || 0} pedidos entregados ($${Number(sales.rows[0]?.s || 0).toLocaleString()} COP).`;
      }

      res.json({
        status: 'ok',
        run: {
          automation_id: autoId,
          status: 'success',
          result_summary: resultSummary,
          executed_at: new Date().toISOString()
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
