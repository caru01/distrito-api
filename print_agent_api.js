'use strict';

/**
 * Distric House Print Agent — API central.
 *
 * El ERP crea trabajos con el HTML exacto que genera printService.js (generateSingleComandaHTML).
 * El agente local (Windows) se conecta SIEMPRE de forma saliente por HTTPS, se autentica con un
 * token de dispositivo y recoge, imprime y confirma cada destino (impresora) por separado.
 *
 * Este módulo nunca modifica pedidos, pagos ni inventario.
 */

const rateLimit = require('express-rate-limit');
const domain = require('./src/print-agent-domain');

const SWEEP_INTERVAL_MS = 30_000;
const AGENT_POLL_INTERVAL_MS = 2_000;

module.exports = function registerPrintAgentApi(app, { pool, authenticateToken, requirePermission }) {
  const canConfigure = requirePermission('Impresoras', 'configurar');

  const agentLimiter = rateLimit({
    windowMs: 60_000,
    limit: 400,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes del agente de impresión.' },
  });

  const jobsLimiter = rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes de impresión. Intenta de nuevo en un momento.' },
  });

  // ─────────────────────────── utilidades ───────────────────────────

  async function getPrintSettings(client) {
    const { rows } = await client.query(`
      SELECT printer_mode, printer_primary_name, printer_secondary_name, printer_paper_width,
             print_agent_id, print_job_expiry_minutes, restaurant_name
      FROM pedidos_app_settings WHERE id = 1
    `);
    return rows[0] || {
      printer_mode: 'browser', printer_primary_name: null, printer_secondary_name: null,
      printer_paper_width: 58, print_agent_id: null, print_job_expiry_minutes: 15, restaurant_name: 'Distric House',
    };
  }

  async function getAgent(client, agentId) {
    if (!agentId) return null;
    const { rows } = await client.query('SELECT * FROM pedidos_app_print_agents WHERE id = $1', [agentId]);
    return rows[0] || null;
  }

  function publicAgent(agent, now = new Date()) {
    if (!agent) return null;
    const printers = domain.normalizeReportedPrinters(agent.printers_json).map((printer) => ({
      ...printer,
      ...domain.printerAvailability(printer),
    }));
    return {
      id: agent.id,
      name: agent.name,
      token_prefix: agent.token_prefix,
      hostname: agent.hostname,
      agent_version: agent.agent_version,
      created_at: agent.created_at,
      last_seen_at: agent.last_seen_at,
      printers_reported_at: agent.printers_reported_at,
      revoked_at: agent.revoked_at,
      online: domain.isAgentOnline(agent, now),
      printers,
    };
  }

  function publicSettings(settings) {
    return {
      printer_mode: settings.printer_mode,
      printer_primary_name: settings.printer_primary_name,
      printer_secondary_name: settings.printer_secondary_name,
      printer_paper_width: Number(settings.printer_paper_width) || 58,
      print_agent_id: settings.print_agent_id,
      print_job_expiry_minutes: Number(settings.print_job_expiry_minutes) || 15,
    };
  }

  async function logEvent(client, { jobId, targetId = null, type, from = null, to = null, actorType, actorId = null, message = null, metadata = {} }) {
    await client.query(`
      INSERT INTO pedidos_app_print_job_events
        (job_id, target_id, event_type, status_from, status_to, actor_type, actor_id, message, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    `, [jobId, targetId, type, from, to, actorType, actorId == null ? null : String(actorId), message, JSON.stringify(metadata || {})]);
  }

  function userName(user) {
    return [user?.name, user?.last_name].filter(Boolean).join(' ') || user?.username || null;
  }

  function sendError(res, error, fallback) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(JSON.stringify({ level: 'error', component: 'print-agent', message: error.message }));
    res.status(status).json({ error: status >= 500 ? fallback : error.message, ...(error.details ? { details: error.details } : {}) });
  }

  function httpError(statusCode, message, details) {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (details) error.details = details;
    return error;
  }

  async function withTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Marca como vencidos los destinos sin imprimir y como fallidos los que agotaron reintentos. */
  async function sweepStaleTargets(client) {
    const expired = await client.query(`
      UPDATE pedidos_app_print_job_targets t
      SET status = 'expired', lease_until = NULL, finished_at = NOW(), updated_at = NOW(),
          error_code = 'EXPIRED',
          error_message = 'La comanda superó el tiempo máximo de espera y no se imprimió automáticamente. Disponible para reimpresión manual.'
      FROM pedidos_app_print_jobs j
      WHERE t.job_id = j.id
        AND j.expires_at <= NOW()
        AND (t.status = 'pending' OR (t.status = 'claimed' AND t.lease_until < NOW()))
      RETURNING t.id, t.job_id
    `);
    for (const row of expired.rows) {
      await logEvent(client, { jobId: row.job_id, targetId: row.id, type: 'expired', to: 'expired', actorType: 'system', message: 'Comanda vencida sin imprimir.' });
    }
    const exhausted = await client.query(`
      UPDATE pedidos_app_print_job_targets
      SET status = 'failed', lease_until = NULL, finished_at = NOW(), updated_at = NOW(),
          error_code = 'MAX_ATTEMPTS',
          error_message = 'El agente no confirmó el resultado después de varios intentos.'
      WHERE status = 'claimed' AND lease_until < NOW() AND attempts >= $1
      RETURNING id, job_id
    `, [domain.MAX_CLAIM_ATTEMPTS]);
    for (const row of exhausted.rows) {
      await logEvent(client, { jobId: row.job_id, targetId: row.id, type: 'failed', from: 'claimed', to: 'failed', actorType: 'system', message: 'Reintentos agotados sin confirmación del agente.' });
    }
    return { expired: expired.rowCount, exhausted: exhausted.rowCount };
  }

  async function loadJob(client, jobId, { withEvents = false } = {}) {
    const { rows } = await client.query(`
      SELECT id, idempotency_key, order_id, kind, reprint_of_job_id, delivery_mode, html_sha256,
             paper_width, agent_id, requested_by_user_id, requested_by_name, created_at, expires_at
      FROM pedidos_app_print_jobs WHERE id = $1
    `, [jobId]);
    if (!rows.length) return null;
    const job = rows[0];
    const targets = await client.query(`
      SELECT id, printer_role, printer_name, status, attempts, windows_job_id, error_code, error_message,
             created_at, updated_at, claimed_at, spooled_at, finished_at
      FROM pedidos_app_print_job_targets WHERE job_id = $1 ORDER BY id
    `, [jobId]);
    job.targets = targets.rows;
    if (withEvents) {
      const events = await client.query(`
        SELECT id, target_id, event_type, status_from, status_to, actor_type, actor_id, message, metadata, created_at
        FROM pedidos_app_print_job_events WHERE job_id = $1 ORDER BY id
      `, [jobId]);
      job.events = events.rows;
    }
    return job;
  }

  /**
   * Crea un trabajo y sus destinos según el modo vigente.
   * - browser          → un destino 'browser' ya resuelto (el ERP imprime como siempre).
   * - agente en línea  → destinos pendientes por impresora.
   * - agente caído     → respaldo: destino 'browser' marcado handled_by_browser, para que el agente
   *                      nunca lo imprima al reconectarse (sin duplicados).
   */
  async function createJob(client, { idempotencyKey, orderId, kind, reprintOf, html, paperWidth, roles, user, forceAgentId, testPrinterName, expiryMinutes }) {
    const existing = await client.query('SELECT id FROM pedidos_app_print_jobs WHERE idempotency_key = $1', [idempotencyKey]);
    if (existing.rows.length) {
      const job = await loadJob(client, existing.rows[0].id);
      return { job, duplicate: true, printInBrowser: false, warning: null };
    }

    const settings = await getPrintSettings(client);
    const agentId = forceAgentId || settings.print_agent_id;
    const agent = await getAgent(client, agentId);
    const agentOnline = domain.isAgentOnline(agent);

    let deliveryMode;
    let targets;
    let warning = null;

    if (kind === 'test') {
      if (!agent || agent.revoked_at) throw httpError(409, 'No hay un Print Agent vinculado para probar la impresora.');
      if (!agentOnline) throw httpError(409, 'El Print Agent no está en línea. Ábrelo en el computador de las impresoras.');
      deliveryMode = 'agent';
      targets = [{ printer_role: roles?.[0] === 'secondary' ? 'secondary' : 'primary', printer_name: testPrinterName }];
    } else if (settings.printer_mode === 'browser') {
      deliveryMode = 'browser';
      targets = domain.resolveTargets(settings);
    } else if (!agent || agent.revoked_at || !agentOnline) {
      deliveryMode = 'browser_fallback';
      targets = [{ printer_role: 'browser', printer_name: 'Navegador (respaldo)' }];
      warning = 'El Print Agent está desconectado. La comanda se imprimirá desde este navegador como respaldo.';
    } else {
      deliveryMode = 'agent';
      targets = domain.resolveTargets(settings, { roles });
      if (!targets.length) throw httpError(409, 'No hay impresoras configuradas para este modo de impresión.');
    }

    const minutes = expiryMinutes || Number(settings.print_job_expiry_minutes) || 15;
    const width = domain.PAPER_WIDTHS.has(Number(paperWidth)) ? Number(paperWidth) : (Number(settings.printer_paper_width) || 58);

    const { rows } = await client.query(`
      INSERT INTO pedidos_app_print_jobs
        (idempotency_key, order_id, kind, reprint_of_job_id, delivery_mode, html, html_sha256, paper_width,
         agent_id, requested_by_user_id, requested_by_name, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW() + make_interval(mins => $12))
      RETURNING id
    `, [idempotencyKey, orderId || null, kind, reprintOf || null, deliveryMode, html, domain.sha256(html), width,
      deliveryMode === 'agent' ? agent.id : null, user?.id || null, userName(user), minutes]);
    const jobId = rows[0].id;

    await logEvent(client, {
      jobId, type: kind === 'reprint' ? 'reprint_requested' : (kind === 'test' ? 'test_requested' : 'created'),
      actorType: 'user', actorId: user?.id, message: warning,
      metadata: { delivery_mode: deliveryMode, order_id: orderId || null, reprint_of_job_id: reprintOf || null },
    });

    for (const target of targets) {
      const status = deliveryMode === 'agent' ? 'pending' : 'handled_by_browser';
      const inserted = await client.query(`
        INSERT INTO pedidos_app_print_job_targets (job_id, printer_role, printer_name, status, finished_at)
        VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'handled_by_browser' THEN NOW() ELSE NULL END)
        RETURNING id
      `, [jobId, target.printer_role, target.printer_name, status]);
      await logEvent(client, {
        jobId, targetId: inserted.rows[0].id, type: 'target_created', to: status, actorType: 'user', actorId: user?.id,
        message: status === 'handled_by_browser' ? 'Impresión gestionada por el navegador.' : `En espera del agente para "${target.printer_name}".`,
      });
    }

    const job = await loadJob(client, jobId);
    return { job, duplicate: false, printInBrowser: deliveryMode !== 'agent', warning };
  }

  function validateHtml(html) {
    if (typeof html !== 'string' || !html.trim()) throw httpError(400, 'El contenido del ticket es obligatorio.');
    if (Buffer.byteLength(html, 'utf8') > domain.MAX_HTML_BYTES) throw httpError(413, 'El ticket supera el tamaño máximo permitido.');
  }

  // ─────────────────────────── autenticación del agente ───────────────────────────

  async function authenticateAgent(req, res, next) {
    try {
      const header = String(req.headers.authorization || '');
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!domain.looksLikeAgentToken(token)) return res.status(401).json({ error: 'Token del agente inválido.' });
      const { rows } = await pool.query(
        'SELECT * FROM pedidos_app_print_agents WHERE token_hash = $1 AND revoked_at IS NULL',
        [domain.hashToken(token)],
      );
      if (!rows.length) return res.status(401).json({ error: 'El agente fue revocado o el token no es válido.', code: 'AGENT_REVOKED' });
      req.printAgent = rows[0];
      next();
    } catch (error) {
      sendError(res, error, 'No fue posible validar el agente.');
    }
  }

  // ─────────────────────────── endpoints del agente ───────────────────────────

  app.post('/api/pedidos/agent/heartbeat', agentLimiter, authenticateAgent, async (req, res) => {
    try {
      const printers = domain.normalizeReportedPrinters(req.body?.printers);
      const hasPrinters = Array.isArray(req.body?.printers);
      const { rows } = await pool.query(`
        UPDATE pedidos_app_print_agents
        SET last_seen_at = NOW(), last_ip = $2, hostname = COALESCE($3, hostname), agent_version = COALESCE($4, agent_version),
            printers_json = CASE WHEN $5 THEN $6::jsonb ELSE printers_json END,
            printers_reported_at = CASE WHEN $5 THEN NOW() ELSE printers_reported_at END
        WHERE id = $1
        RETURNING *
      `, [req.printAgent.id, domain.cleanText(req.ip, 100), domain.cleanText(req.body?.hostname, 120),
        domain.cleanText(req.body?.agent_version, 40), hasPrinters, JSON.stringify(printers)]);
      const settings = await getPrintSettings(pool);
      res.json({
        status: 'ok',
        agent: { id: rows[0].id, name: rows[0].name },
        active: settings.print_agent_id === rows[0].id,
        config: publicSettings(settings),
        poll_interval_ms: AGENT_POLL_INTERVAL_MS,
        server_time: new Date().toISOString(),
      });
    } catch (error) {
      sendError(res, error, 'No fue posible registrar el estado del agente.');
    }
  });

  app.post('/api/pedidos/agent/jobs/claim', agentLimiter, authenticateAgent, async (req, res) => {
    const limit = Math.min(Math.max(Number(req.body?.limit) || 10, 1), 20);
    try {
      const claimed = await withTransaction(async (client) => {
        await client.query('UPDATE pedidos_app_print_agents SET last_seen_at = NOW() WHERE id = $1', [req.printAgent.id]);
        await sweepStaleTargets(client);
        const { rows } = await client.query(`
          WITH candidates AS (
            SELECT t.id
            FROM pedidos_app_print_job_targets t
            JOIN pedidos_app_print_jobs j ON j.id = t.job_id
            WHERE j.agent_id = $1
              AND j.delivery_mode = 'agent'
              AND j.expires_at > NOW()
              AND (t.status = 'pending' OR (t.status = 'claimed' AND t.lease_until < NOW() AND t.attempts < $3))
            ORDER BY j.created_at, t.id
            LIMIT $2
            FOR UPDATE OF t SKIP LOCKED
          )
          UPDATE pedidos_app_print_job_targets t
          SET status = 'claimed', claim_token = gen_random_uuid(), claimed_by_agent_id = $1,
              lease_until = NOW() + make_interval(secs => $4), attempts = t.attempts + 1,
              claimed_at = NOW(), updated_at = NOW()
          FROM candidates c
          WHERE t.id = c.id
          RETURNING t.id, t.job_id, t.printer_role, t.printer_name, t.claim_token, t.attempts, t.lease_until
        `, [req.printAgent.id, limit, domain.MAX_CLAIM_ATTEMPTS, domain.CLAIM_LEASE_SECONDS]);

        const result = [];
        for (const target of rows) {
          const job = await client.query(
            'SELECT id, order_id, kind, html, html_sha256, paper_width, expires_at FROM pedidos_app_print_jobs WHERE id = $1',
            [target.job_id],
          );
          await logEvent(client, {
            jobId: target.job_id, targetId: target.id, type: 'claimed', to: 'claimed', actorType: 'agent', actorId: req.printAgent.id,
            message: `Intento ${target.attempts} en "${target.printer_name}".`,
          });
          result.push({
            target_id: Number(target.id),
            claim_token: target.claim_token,
            job_id: target.job_id,
            printer_role: target.printer_role,
            printer_name: target.printer_name,
            attempts: target.attempts,
            lease_until: target.lease_until,
            kind: job.rows[0].kind,
            order_id: job.rows[0].order_id,
            paper_width: job.rows[0].paper_width,
            html: job.rows[0].html,
            html_sha256: job.rows[0].html_sha256,
            expires_at: job.rows[0].expires_at,
          });
        }
        return result;
      });
      res.json({ status: 'ok', targets: claimed, server_time: new Date().toISOString() });
    } catch (error) {
      sendError(res, error, 'No fue posible entregar los trabajos de impresión.');
    }
  });

  app.post('/api/pedidos/agent/targets/:id/result', agentLimiter, authenticateAgent, async (req, res) => {
    const targetId = Number(req.params.id);
    const nextStatus = String(req.body?.status || '');
    const claimToken = String(req.body?.claim_token || '');
    if (!Number.isInteger(targetId) || targetId <= 0) return res.status(400).json({ error: 'Destino inválido.' });
    if (!['spooled', 'completed_by_driver', 'unverifiable', 'failed'].includes(nextStatus)) {
      return res.status(400).json({ error: 'Estado de impresión inválido.' });
    }
    try {
      const outcome = await withTransaction(async (client) => {
        const { rows } = await client.query(
          'SELECT * FROM pedidos_app_print_job_targets WHERE id = $1 AND claimed_by_agent_id = $2 FOR UPDATE',
          [targetId, req.printAgent.id],
        );
        if (!rows.length) throw httpError(404, 'El destino no existe o no pertenece a este agente.');
        const target = rows[0];
        if (!target.claim_token || target.claim_token !== claimToken) {
          throw httpError(409, 'El trabajo fue reasignado; este resultado ya no es válido.', { code: 'STALE_CLAIM' });
        }
        if (target.status === nextStatus) return { duplicate: true, status: target.status };
        if (!domain.canAgentTransition(target.status, nextStatus)) {
          throw httpError(409, `Transición no permitida: ${target.status} → ${nextStatus}.`, { code: 'INVALID_TRANSITION' });
        }
        const terminal = domain.isTerminal(nextStatus);
        await client.query(`
          UPDATE pedidos_app_print_job_targets
          SET status = $2, lease_until = NULL, updated_at = NOW(),
              windows_job_id = COALESCE($3, windows_job_id),
              error_code = $4, error_message = $5,
              spooled_at = CASE WHEN $2 IN ('spooled', 'completed_by_driver', 'unverifiable') THEN COALESCE(spooled_at, NOW()) ELSE spooled_at END,
              finished_at = CASE WHEN $6 THEN NOW() ELSE finished_at END
          WHERE id = $1
        `, [targetId, nextStatus, domain.cleanText(req.body?.windows_job_id, 60),
          nextStatus === 'failed' || nextStatus === 'unverifiable' ? domain.cleanText(req.body?.error_code, 60) : null,
          domain.cleanText(req.body?.error_message, 500), terminal]);
        await logEvent(client, {
          jobId: target.job_id, targetId, type: nextStatus, from: target.status, to: nextStatus,
          actorType: 'agent', actorId: req.printAgent.id, message: domain.cleanText(req.body?.error_message, 500),
          metadata: {
            windows_job_id: domain.cleanText(req.body?.windows_job_id, 60),
            error_code: domain.cleanText(req.body?.error_code, 60),
            details: typeof req.body?.details === 'object' && req.body.details ? JSON.parse(JSON.stringify(req.body.details).slice(0, 2000) || '{}') : undefined,
          },
        });
        return { duplicate: false, status: nextStatus };
      });
      res.json({ status: 'ok', target_status: outcome.status, duplicate: outcome.duplicate });
    } catch (error) {
      if (error instanceof SyntaxError) return res.status(400).json({ error: 'Detalles inválidos.' });
      sendError(res, error, 'No fue posible registrar el resultado de impresión.');
    }
  });

  // ─────────────────────────── endpoints del ERP ───────────────────────────

  app.get('/api/pedidos/admin/print-config', authenticateToken, async (req, res) => {
    try {
      const settings = await getPrintSettings(pool);
      const agent = await getAgent(pool, settings.print_agent_id);
      res.json({ status: 'ok', settings: publicSettings(settings), agent: publicAgent(agent) });
    } catch (error) {
      sendError(res, error, 'No fue posible consultar la configuración de impresión.');
    }
  });

  app.get('/api/pedidos/admin/print-agents', authenticateToken, canConfigure, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM pedidos_app_print_agents ORDER BY revoked_at NULLS FIRST, created_at DESC LIMIT 50');
      const settings = await getPrintSettings(pool);
      res.json({ status: 'ok', active_agent_id: settings.print_agent_id, agents: rows.map((agent) => publicAgent(agent)) });
    } catch (error) {
      sendError(res, error, 'No fue posible consultar los agentes de impresión.');
    }
  });

  app.post('/api/pedidos/admin/print-agents', authenticateToken, canConfigure, async (req, res) => {
    const name = domain.cleanText(req.body?.name, 80) || 'Caja Distric House';
    try {
      const token = domain.generateAgentToken();
      const agent = await withTransaction(async (client) => {
        const { rows } = await client.query(`
          INSERT INTO pedidos_app_print_agents (name, token_hash, token_prefix, created_by)
          VALUES ($1, $2, $3, $4) RETURNING *
        `, [name, domain.hashToken(token), token.slice(0, 12), req.user?.id || null]);
        await client.query('UPDATE pedidos_app_settings SET print_agent_id = COALESCE(print_agent_id, $1), updated_at = NOW() WHERE id = 1', [rows[0].id]);
        return rows[0];
      });
      // El token se entrega UNA sola vez. En la base de datos solo queda su hash.
      res.status(201).json({ status: 'ok', agent: publicAgent(agent), token });
    } catch (error) {
      sendError(res, error, 'No fue posible vincular el agente de impresión.');
    }
  });

  app.delete('/api/pedidos/admin/print-agents/:id', authenticateToken, canConfigure, async (req, res) => {
    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query(
          'UPDATE pedidos_app_print_agents SET revoked_at = NOW(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id',
          [req.params.id, req.user?.id || null],
        );
        if (!rows.length) throw httpError(404, 'El agente no existe o ya fue revocado.');
        // Si era el agente activo, se vuelve al modo navegador para no dejar comandas sin destino.
        const settingsUpdate = await client.query(`
          UPDATE pedidos_app_settings SET print_agent_id = NULL, printer_mode = 'browser', updated_at = NOW()
          WHERE id = 1 AND print_agent_id = $1 RETURNING id
        `, [req.params.id]);
        const pending = await client.query(`
          UPDATE pedidos_app_print_job_targets t
          SET status = 'expired', lease_until = NULL, finished_at = NOW(), updated_at = NOW(),
              error_code = 'AGENT_REVOKED', error_message = 'El agente fue revocado antes de imprimir.'
          FROM pedidos_app_print_jobs j
          WHERE t.job_id = j.id AND j.agent_id = $1 AND t.status IN ('pending', 'claimed')
          RETURNING t.id, t.job_id
        `, [req.params.id]);
        for (const row of pending.rows) {
          await logEvent(client, { jobId: row.job_id, targetId: row.id, type: 'expired', to: 'expired', actorType: 'user', actorId: req.user?.id, message: 'Agente revocado.' });
        }
        return { switched_to_browser: settingsUpdate.rowCount > 0, expired_targets: pending.rowCount };
      });
      res.json({ status: 'ok', ...result });
    } catch (error) {
      sendError(res, error, 'No fue posible revocar el agente.');
    }
  });

  app.put('/api/pedidos/admin/print-settings', authenticateToken, canConfigure, async (req, res) => {
    try {
      const current = await getPrintSettings(pool);
      const next = {
        printer_mode: req.body?.printer_mode ?? current.printer_mode,
        printer_primary_name: req.body?.printer_primary_name !== undefined ? domain.cleanText(req.body.printer_primary_name) : current.printer_primary_name,
        printer_secondary_name: req.body?.printer_secondary_name !== undefined ? domain.cleanText(req.body.printer_secondary_name) : current.printer_secondary_name,
        printer_paper_width: req.body?.printer_paper_width != null ? Number(req.body.printer_paper_width) : Number(current.printer_paper_width),
        print_agent_id: req.body?.print_agent_id !== undefined ? (req.body.print_agent_id || null) : current.print_agent_id,
        print_job_expiry_minutes: req.body?.print_job_expiry_minutes != null ? Number(req.body.print_job_expiry_minutes) : Number(current.print_job_expiry_minutes),
      };
      if (next.printer_mode !== 'agent_dual') next.printer_secondary_name = next.printer_mode === 'browser' ? next.printer_secondary_name : null;
      const agent = await getAgent(pool, next.print_agent_id);
      const errors = domain.validatePrinterSettings(next, agent);
      if (errors.length) return res.status(422).json({ error: errors[0], errors });
      const { rows } = await pool.query(`
        UPDATE pedidos_app_settings
        SET printer_mode = $1, printer_primary_name = $2, printer_secondary_name = $3, printer_paper_width = $4,
            print_agent_id = $5, print_job_expiry_minutes = $6, updated_at = NOW()
        WHERE id = 1
        RETURNING printer_mode, printer_primary_name, printer_secondary_name, printer_paper_width, print_agent_id, print_job_expiry_minutes
      `, [next.printer_mode, next.printer_primary_name, next.printer_secondary_name, next.printer_paper_width, next.print_agent_id, next.print_job_expiry_minutes]);
      res.json({ status: 'ok', settings: publicSettings(rows[0]), agent: publicAgent(agent) });
    } catch (error) {
      sendError(res, error, 'No fue posible guardar la configuración de impresión.');
    }
  });

  app.post('/api/pedidos/admin/print-jobs', jobsLimiter, authenticateToken, async (req, res) => {
    try {
      const idempotencyKey = String(req.body?.idempotency_key || '');
      if (!domain.isValidIdempotencyKey(idempotencyKey)) return res.status(400).json({ error: 'Identificador de impresión inválido.' });
      const html = req.body?.html;
      validateHtml(html);
      const orderId = Number(req.body?.order_id);
      if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'El pedido es obligatorio para imprimir la comanda.' });
      const isAuto = req.body?.auto === true;

      const result = await withTransaction(async (client) => {
        const order = await client.query('SELECT id FROM pedidos_app_orders WHERE id = $1', [orderId]);
        if (!order.rows.length) throw httpError(404, 'El pedido no existe.');
        // Serializa las impresiones de un mismo pedido (evita carreras entre pestañas y equipos).
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`print-order-${orderId}`]);

        const previous = await client.query(`
          SELECT id FROM pedidos_app_print_jobs
          WHERE order_id = $1 AND kind IN ('comanda', 'reprint')
          ORDER BY created_at DESC LIMIT 1
        `, [orderId]);

        // Auto-Print: si la comanda ya se imprimió (desde cualquier equipo), no se repite.
        if (isAuto && previous.rows.length) {
          const job = await loadJob(client, previous.rows[0].id);
          return { job, duplicate: true, skipped: true, printInBrowser: false, warning: null };
        }

        return createJob(client, {
          idempotencyKey,
          orderId,
          kind: previous.rows.length ? 'reprint' : 'comanda',
          reprintOf: previous.rows[0]?.id || null,
          html,
          paperWidth: req.body?.paper_width,
          user: req.user,
        });
      });

      res.status(result.duplicate ? 200 : 201).json({
        status: 'ok',
        job: result.job,
        duplicate: result.duplicate,
        skipped: Boolean(result.skipped),
        print_in_browser: result.printInBrowser,
        warning: result.warning,
      });
    } catch (error) {
      sendError(res, error, 'No fue posible crear el trabajo de impresión.');
    }
  });

  app.post('/api/pedidos/admin/print-jobs/test', jobsLimiter, authenticateToken, canConfigure, async (req, res) => {
    try {
      const idempotencyKey = String(req.body?.idempotency_key || '');
      if (!domain.isValidIdempotencyKey(idempotencyKey)) return res.status(400).json({ error: 'Identificador de impresión inválido.' });
      const role = req.body?.role === 'secondary' ? 'secondary' : 'primary';
      const printerName = domain.cleanText(req.body?.printer_name);
      if (!printerName) return res.status(400).json({ error: 'Selecciona la impresora que quieres probar.' });

      const result = await withTransaction(async (client) => {
        const settings = await getPrintSettings(client);
        const agentId = req.body?.agent_id || settings.print_agent_id;
        const agent = await getAgent(client, agentId);
        const printer = domain.normalizeReportedPrinters(agent?.printers_json).find((p) => p.name === printerName);
        if (!printer) throw httpError(422, `"${printerName}" no aparece entre las impresoras reportadas por el agente.`);
        const width = domain.PAPER_WIDTHS.has(Number(req.body?.paper_width)) ? Number(req.body.paper_width) : Number(settings.printer_paper_width) || 58;
        const html = domain.buildTestTicketHtml({ printerName, role, paperWidth: width, restaurantName: settings.restaurant_name || 'Distric House' });
        return createJob(client, {
          idempotencyKey, orderId: null, kind: 'test', html, paperWidth: width, roles: [role], user: req.user,
          forceAgentId: agentId, testPrinterName: printerName, expiryMinutes: domain.TEST_JOB_EXPIRY_MINUTES,
        });
      });
      res.status(result.duplicate ? 200 : 201).json({ status: 'ok', job: result.job, duplicate: result.duplicate, print_in_browser: false });
    } catch (error) {
      sendError(res, error, 'No fue posible enviar la prueba de impresión.');
    }
  });

  app.post('/api/pedidos/admin/print-jobs/:id/reprint', jobsLimiter, authenticateToken, async (req, res) => {
    try {
      const idempotencyKey = String(req.body?.idempotency_key || '');
      if (!domain.isValidIdempotencyKey(idempotencyKey)) return res.status(400).json({ error: 'Identificador de impresión inválido.' });
      const roles = Array.isArray(req.body?.roles) ? req.body.roles.filter((r) => domain.PRINTER_ROLES.has(r)) : null;

      const result = await withTransaction(async (client) => {
        const { rows } = await client.query('SELECT id, order_id, kind, html, paper_width FROM pedidos_app_print_jobs WHERE id = $1', [req.params.id]);
        if (!rows.length) throw httpError(404, 'El trabajo de impresión no existe.');
        const original = rows[0];
        if (original.kind === 'test') throw httpError(400, 'Las pruebas de impresión no se reimprimen; envía una prueba nueva.');
        if (original.order_id) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`print-order-${original.order_id}`]);
        // Se reutiliza el HTML original sin cambios: el ticket reimpreso es idéntico.
        const created = await createJob(client, {
          idempotencyKey, orderId: original.order_id, kind: 'reprint', reprintOf: original.id,
          html: original.html, paperWidth: original.paper_width, roles, user: req.user,
        });
        return { ...created, html: created.printInBrowser ? original.html : undefined };
      });
      res.status(result.duplicate ? 200 : 201).json({
        status: 'ok', job: result.job, duplicate: result.duplicate,
        print_in_browser: result.printInBrowser, warning: result.warning, html: result.html,
      });
    } catch (error) {
      sendError(res, error, 'No fue posible reimprimir la comanda.');
    }
  });

  // Respaldo manual: el agente no tomó el trabajo a tiempo y el usuario decide imprimir por navegador.
  // Solo se marcan los destinos que siguen pendientes, así el agente nunca los imprime después.
  app.post('/api/pedidos/admin/print-jobs/:id/browser-fallback', jobsLimiter, authenticateToken, async (req, res) => {
    try {
      const result = await withTransaction(async (client) => {
        const job = await client.query('SELECT id, html, kind FROM pedidos_app_print_jobs WHERE id = $1', [req.params.id]);
        if (!job.rows.length) throw httpError(404, 'El trabajo de impresión no existe.');
        const { rows } = await client.query(`
          UPDATE pedidos_app_print_job_targets
          SET status = 'handled_by_browser', lease_until = NULL, finished_at = NOW(), updated_at = NOW(),
              error_code = NULL, error_message = 'Impreso mediante respaldo del navegador.'
          WHERE job_id = $1 AND status = 'pending'
          RETURNING id
        `, [req.params.id]);
        for (const row of rows) {
          await logEvent(client, { jobId: req.params.id, targetId: row.id, type: 'browser_fallback', from: 'pending', to: 'handled_by_browser', actorType: 'user', actorId: req.user?.id });
        }
        return { marked: rows.length, html: rows.length ? job.rows[0].html : undefined, job: await loadJob(client, req.params.id) };
      });
      res.json({
        status: 'ok', job: result.job, print_in_browser: result.marked > 0, html: result.html,
        message: result.marked ? null : 'El agente ya tomó este trabajo; no se imprime de nuevo para evitar duplicados.',
      });
    } catch (error) {
      sendError(res, error, 'No fue posible activar el respaldo del navegador.');
    }
  });

  app.get('/api/pedidos/admin/print-jobs', authenticateToken, async (req, res) => {
    try {
      const params = [];
      const filters = [];
      if (req.query.order_id) {
        params.push(Number(req.query.order_id));
        filters.push(`j.order_id = $${params.length}`);
      }
      if (req.query.status) {
        params.push(String(req.query.status));
        filters.push(`EXISTS (SELECT 1 FROM pedidos_app_print_job_targets t WHERE t.job_id = j.id AND t.status = $${params.length})`);
      }
      params.push(Math.min(Math.max(Number(req.query.limit) || 50, 1), 200));
      const { rows } = await pool.query(`
        SELECT j.id, j.order_id, j.kind, j.reprint_of_job_id, j.delivery_mode, j.paper_width, j.requested_by_name,
               j.created_at, j.expires_at,
               COALESCE(json_agg(json_build_object(
                 'id', t.id, 'printer_role', t.printer_role, 'printer_name', t.printer_name, 'status', t.status,
                 'attempts', t.attempts, 'error_code', t.error_code, 'error_message', t.error_message,
                 'spooled_at', t.spooled_at, 'finished_at', t.finished_at
               ) ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '[]') AS targets
        FROM pedidos_app_print_jobs j
        LEFT JOIN pedidos_app_print_job_targets t ON t.job_id = j.id
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        GROUP BY j.id
        ORDER BY j.created_at DESC
        LIMIT $${params.length}
      `, params);
      res.json({ status: 'ok', jobs: rows });
    } catch (error) {
      sendError(res, error, 'No fue posible consultar la bitácora de impresión.');
    }
  });

  app.get('/api/pedidos/admin/print-jobs/:id', authenticateToken, async (req, res) => {
    try {
      const job = await loadJob(pool, req.params.id, { withEvents: true });
      if (!job) return res.status(404).json({ error: 'El trabajo de impresión no existe.' });
      res.json({ status: 'ok', job });
    } catch (error) {
      if (/invalid input syntax for type uuid/i.test(error.message)) return res.status(404).json({ error: 'El trabajo de impresión no existe.' });
      sendError(res, error, 'No fue posible consultar el trabajo de impresión.');
    }
  });

  // Barrido periódico: vence comandas sin imprimir aunque el agente esté desconectado.
  let sweeping = false;
  const sweepTimer = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await withTransaction((client) => sweepStaleTargets(client));
    } catch (error) {
      if (!/does not exist/i.test(error.message)) {
        console.error(JSON.stringify({ level: 'error', component: 'print-agent-sweeper', message: error.message }));
      }
    } finally {
      sweeping = false;
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  return { sweepStaleTargets: () => withTransaction((client) => sweepStaleTargets(client)), stop: () => clearInterval(sweepTimer) };
};
