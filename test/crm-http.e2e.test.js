const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const bcrypt = require('bcryptjs');
const { createPool } = require('../src/db');

const apiRoot = path.resolve(__dirname, '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForApi(baseUrl, child, getLogs) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`La API CRM E2E terminó antes de iniciar.\n${getLogs()}`);
    try {
      const response = await fetch(`${baseUrl}/api/pedidos/health`);
      if (response.ok) return;
    } catch {
      // La API todavía está abriendo el puerto o conectando PostgreSQL.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`La API CRM E2E no respondió a tiempo.\n${getLogs()}`);
}

async function waitUntil(check, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(message);
}

function sign(rawBody, secret) {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

async function postWebhook(baseUrl, body, secret, validSignature = true) {
  const raw = JSON.stringify(body);
  const response = await fetch(`${baseUrl}/api/pedidos/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-Proto': 'https',
      'X-Hub-Signature-256': validSignature ? sign(raw, secret) : 'sha256=invalid',
    },
    body: raw,
  });
  const data = await response.json();
  return { response, data, raw };
}

function webhookValue({ phoneNumberId, messages = [], statuses = [], profileName = 'Cliente CRM E2E', waId }) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba-e2e',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '570000000000', phone_number_id: phoneNumberId },
          ...(waId ? { contacts: [{ profile: { name: profileName }, wa_id: waId }] } : {}),
          messages,
          statuses,
        },
      }],
    }],
  };
}

test('E2E HTTP CRM: webhook firmado e idempotente, estados ordenados y acceso RBAC', { timeout: 60_000 }, async (t) => {
  const pool = createPool({ max: 5 });
  const suffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const password = `Crm-${crypto.randomBytes(8).toString('hex')}!`;
  const secret = `crm-secret-${suffix}`;
  const verifyToken = `crm-verify-${suffix}`;
  const phoneNumberId = `phone-${suffix}`;
  const phone = `3${String(Date.now()).slice(-9)}`;
  const waId = `57${phone}`;
  const inboundProviderId = `wamid.in.${suffix}`;
  const outboundProviderId = `wamid.out.${suffix}`;
  let child;
  let webhookBlocker;
  const userIds = [];
  const roleIds = [];
  let contactId;
  let conversationId;
  let segmentId;
  let templateId;
  let campaignId;
  let providerBefore;
  const webhookKeys = [];
  let logs = '';

  const releaseWebhookBlocker = async () => {
    if (!webhookBlocker) return;
    const client = webhookBlocker;
    webhookBlocker = null;
    await client.query('COMMIT').catch(() => client.query('ROLLBACK').catch(() => {}));
    client.release();
  };

  try {
    providerBefore = (await pool.query(`SELECT * FROM pedidos_app_crm_provider_state WHERE provider='WHATSAPP'`)).rows[0];
    const role = await pool.query(`SELECT id,name FROM pedidos_app_roles WHERE name='Super Administrador' LIMIT 1`);
    assert.ok(role.rows.length, 'Debe existir el rol Super Administrador');
    const passwordHash = await bcrypt.hash(password, 8);
    const insertedUser = await pool.query(`
      INSERT INTO pedidos_app_users(username,password_hash,role,role_id,status,name,max_active_sessions)
      VALUES($1,$2,$3,$4,'Activo','CRM E2E',3) RETURNING id,username
    `, [`crm-http-e2e-${suffix}`, passwordHash, role.rows[0].name, role.rows[0].id]);
    userIds.push(insertedUser.rows[0].id);
    const readOnlyRole = await pool.query(`INSERT INTO pedidos_app_roles(name,description) VALUES($1,'Rol temporal E2E') RETURNING id,name`, [`CRM lectura E2E ${suffix}`]);
    const noCrmRole = await pool.query(`INSERT INTO pedidos_app_roles(name,description) VALUES($1,'Rol temporal E2E') RETURNING id,name`, [`Sin CRM E2E ${suffix}`]);
    roleIds.push(readOnlyRole.rows[0].id,noCrmRole.rows[0].id);
    await pool.query(`
      INSERT INTO pedidos_app_role_permissions(role_id,permission_id)
      SELECT $1,id FROM pedidos_app_permissions WHERE module='CRM' AND action='ver'
    `,[readOnlyRole.rows[0].id]);
    const restrictedUsers = [];
    for(const roleRow of [readOnlyRole.rows[0],noCrmRole.rows[0]]){
      const inserted=await pool.query(`
        INSERT INTO pedidos_app_users(username,password_hash,role,role_id,status,name,max_active_sessions)
        VALUES($1,$2,$3,$4,'Activo','CRM permisos E2E',3) RETURNING id,username
      `,[`crm-permission-${roleRow.id}-${suffix}`,passwordHash,roleRow.name,roleRow.id]);
      restrictedUsers.push(inserted.rows[0]);
      userIds.push(inserted.rows[0].id);
    }

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.js'], {
      cwd: apiRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        WHATSAPP_ACCESS_TOKEN: 'e2e-token-never-sent',
        WHATSAPP_APP_SECRET: secret,
        WHATSAPP_VERIFY_TOKEN: verifyToken,
        WHATSAPP_PHONE_NUMBER_ID: phoneNumberId,
        WHATSAPP_BUSINESS_ACCOUNT_ID: `waba-${suffix}`,
        WHATSAPP_GRAPH_API_VERSION: 'v99.0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const appendLog = (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); };
    child.stdout.on('data', appendLog);
    child.stderr.on('data', appendLog);
    await waitForApi(baseUrl, child, () => logs);

    const challenge = `challenge-${suffix}`;
    const verify = await fetch(`${baseUrl}/api/pedidos/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=${encodeURIComponent(challenge)}`, {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(verify.status, 200);
    assert.equal(await verify.text(), challenge);
    const rejectedVerify = await fetch(`${baseUrl}/api/pedidos/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=incorrecto&hub.challenge=x`, {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(rejectedVerify.status, 403);
    const insecureVerify = await fetch(`${baseUrl}/api/pedidos/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=x`);
    assert.equal(insecureVerify.status, 426);

    const inboundBody = webhookValue({
      phoneNumberId,
      waId,
      messages: [{
        from: waId,
        id: inboundProviderId,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: 'Hola, quiero información del menú' },
      }],
    });
    const seededContact = await pool.query(`
      INSERT INTO pedidos_app_crm_contacts (normalized_phone,display_name,source,status)
      VALUES($1,'Contacto bloqueado para probar ACK','WHATSAPP','PROSPECTO')
      ON CONFLICT(normalized_phone) DO UPDATE SET display_name=EXCLUDED.display_name
      RETURNING id
    `, [`+${waId}`]);
    contactId = seededContact.rows[0].id;
    webhookBlocker = await pool.connect();
    await webhookBlocker.query('BEGIN');
    await webhookBlocker.query('SELECT id FROM pedidos_app_crm_contacts WHERE id=$1 FOR UPDATE', [contactId]);

    const badSignature = await postWebhook(baseUrl, inboundBody, secret, false);
    assert.equal(badSignature.response.status, 401);

    const safetyRelease = setTimeout(() => { void releaseWebhookBlocker(); }, 3_000);
    const acknowledgedAt = Date.now();
    const accepted = await postWebhook(baseUrl, inboundBody, secret);
    const acknowledgementMs = Date.now() - acknowledgedAt;
    clearTimeout(safetyRelease);
    webhookKeys.push(`whatsapp:${crypto.createHash('sha256').update(accepted.raw).digest('hex')}`);
    assert.equal(accepted.response.status, 200, `${JSON.stringify(accepted.data)}\n${logs}`);
    assert.equal(accepted.data.status, 'accepted');
    assert.equal(accepted.data.duplicate, false);
    assert.ok(acknowledgementMs < 1_500, `El ACK tardó ${acknowledgementMs} ms y quedó bloqueado por la lógica interna.`);
    t.diagnostic(`ACK HTTP 200 con procesamiento interno bloqueado: ${acknowledgementMs} ms`);
    const persistedBeforeProcessing = await pool.query(`
      SELECT processing_status FROM pedidos_app_crm_webhook_events WHERE event_key=$1
    `, [webhookKeys[0]]);
    assert.equal(persistedBeforeProcessing.rows[0]?.processing_status, 'RECEIVED');
    await releaseWebhookBlocker();

    const duplicate = await postWebhook(baseUrl, inboundBody, secret);
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.data.duplicate, true);

    const contact = await waitUntil(async () => {
      const result = await pool.query(`
        SELECT contact.id,conversation.id AS conversation_id,conversation.unread_count
        FROM pedidos_app_crm_contacts contact
        JOIN pedidos_app_crm_conversations conversation ON conversation.contact_id=contact.id
        WHERE contact.normalized_phone=$1
      `, [`+${waId}`]);
      return result.rows.length ? result : null;
    }, `El mensaje entrante no fue procesado.\n${logs}`);
    assert.equal(contact.rows.length, 1);
    contactId = contact.rows[0].id;
    conversationId = contact.rows[0].conversation_id;
    assert.equal(contact.rows[0].unread_count, 1);
    const inboundCount = await pool.query(`SELECT COUNT(*)::int AS total FROM pedidos_app_crm_messages WHERE provider_message_id=$1`, [inboundProviderId]);
    assert.equal(inboundCount.rows[0].total, 1);
    const webhookCount = await pool.query(`SELECT COUNT(*)::int AS total FROM pedidos_app_crm_webhook_events WHERE event_key=$1`, [webhookKeys[0]]);
    assert.equal(webhookCount.rows[0].total, 1);

    const outbound = await pool.query(`
      INSERT INTO pedidos_app_crm_messages
        (conversation_id,contact_id,provider_message_id,direction,message_type,text_body,status,sent_at)
      VALUES($1,$2,$3,'OUTBOUND','text','Respuesta E2E','SENT',NOW()) RETURNING id
    `, [conversationId, contactId, outboundProviderId]);

    for (const status of ['read', 'sent']) {
      const statusBody = webhookValue({
        phoneNumberId,
        statuses: [{ id: outboundProviderId, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: waId }],
      });
      const result = await postWebhook(baseUrl, statusBody, secret);
      webhookKeys.push(`whatsapp:${crypto.createHash('sha256').update(result.raw).digest('hex')}`);
      assert.equal(result.response.status, 200, `${JSON.stringify(result.data)}\n${logs}`);
      assert.equal(result.data.status, 'accepted');
    }
    const finalMessage = await waitUntil(async () => {
      const result = await pool.query(`SELECT status,read_at FROM pedidos_app_crm_messages WHERE id=$1`, [outbound.rows[0].id]);
      return result.rows[0]?.status === 'READ' ? result : null;
    }, `Los estados enviados por Meta no fueron procesados.\n${logs}`);
    assert.equal(finalMessage.rows[0].status, 'READ');
    assert.ok(finalMessage.rows[0].read_at);
    assert.match(logs, /"component":"whatsapp-webhook"/);
    assert.match(logs, /"event":"payload_received"/);

    const loginResponse = await fetch(`${baseUrl}/api/pedidos/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: insertedUser.rows[0].username, password, deviceId: `crm-e2e-${suffix}`, deviceName: 'CRM E2E' }),
    });
    assert.equal(loginResponse.status, 200);
    const login = await loginResponse.json();
    const dashboard = await fetch(`${baseUrl}/api/pedidos/admin/crm/dashboard`, { headers: { Authorization: `Bearer ${login.token}` } });
    assert.equal(dashboard.status, 200);
    const dashboardData = await dashboard.json();
    assert.equal(dashboardData.status, 'ok');
    assert.ok(Number(dashboardData.summary.contacts) >= 1);
    const contacts = await fetch(`${baseUrl}/api/pedidos/admin/crm/contacts?search=${encodeURIComponent(phone)}&limit=10`, { headers: { Authorization: `Bearer ${login.token}` } });
    assert.equal(contacts.status, 200);
    const contactsData = await contacts.json();
    assert.ok(contactsData.contacts.some((item) => Number(item.id) === Number(contactId)));
    const filteredExport = await fetch(`${baseUrl}/api/pedidos/admin/crm/export.csv?search=${encodeURIComponent(phone)}`, { headers: { Authorization: `Bearer ${login.token}` } });
    assert.equal(filteredExport.status, 200);
    assert.match(await filteredExport.text(), new RegExp(`\\+${waId}`));

    const consentResponse = await fetch(`${baseUrl}/api/pedidos/admin/crm/contacts/${contactId}/consent`, {
      method: 'POST', headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ granted: true, source: 'E2E_EXPLICIT' }),
    });
    assert.equal(consentResponse.status, 200);
    const segmentResponse = await fetch(`${baseUrl}/api/pedidos/admin/crm/segments`, {
      method: 'POST', headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Prospectos WhatsApp E2E ${suffix}`, segment_type: 'DYNAMIC',
        definition: { combinator: 'AND', rules: [
          { field: 'source', operator: 'eq', value: 'WHATSAPP' },
          { field: 'orders_count', operator: 'eq', value: 0 },
        ] },
      }),
    });
    assert.equal(segmentResponse.status, 201);
    segmentId = (await segmentResponse.json()).segment.id;
    const templateResponse = await fetch(`${baseUrl}/api/pedidos/admin/crm/templates`, {
      method: 'POST', headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `crm_e2e_${String(Date.now())}`, language: 'es_CO', category: 'MARKETING', components: [] }),
    });
    assert.equal(templateResponse.status, 201);
    templateId = (await templateResponse.json()).template.id;
    await pool.query(`UPDATE pedidos_app_crm_whatsapp_templates SET status='APPROVED',provider_template_id=$2 WHERE id=$1`, [templateId, `provider-${suffix}`]);
    const campaignResponse = await fetch(`${baseUrl}/api/pedidos/admin/crm/campaigns`, {
      method: 'POST', headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Campaña E2E ${suffix}`, code: `CRM_E2E_${Date.now()}`, objective: 'SALES',
        segment_id: segmentId, template_id: templateId,
        scheduled_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }),
    });
    assert.equal(campaignResponse.status, 201);
    campaignId = (await campaignResponse.json()).campaign.id;
    const previewResponse = await fetch(`${baseUrl}/api/pedidos/admin/crm/campaigns/${campaignId}/preview`, { headers: { Authorization: `Bearer ${login.token}` } });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.ok(preview.total >= 1);
    assert.equal(preview.eligible, 1);
    const launchResponse = await fetch(`${baseUrl}/api/pedidos/admin/crm/campaigns/${campaignId}/launch`, {
      method: 'POST', headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    const launch = await launchResponse.json();
    assert.equal(launchResponse.status, 202, `${JSON.stringify(launch)}\n${logs}`);
    assert.equal(launch.eligible, 1);
    assert.equal(launch.scheduled, true);
    const recipients = await pool.query(`SELECT status,exclusion_reason FROM pedidos_app_crm_campaign_recipients WHERE campaign_id=$1`, [campaignId]);
    assert.equal(recipients.rows.filter((row) => row.status === 'PENDING').length, 1);
    assert.ok(recipients.rows.filter((row) => row.status === 'EXCLUDED').every((row) => ['MARKETING_CONSENT_REQUIRED','CONTACT_OPTED_OUT','FREQUENCY_CAP'].includes(row.exclusion_reason)));
    const pauseResponse = await fetch(`${baseUrl}/api/pedidos/admin/crm/campaigns/${campaignId}/pause`, {
      method: 'POST', headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(pauseResponse.status, 200);

    async function loginRestricted(user, device) {
      const response=await fetch(`${baseUrl}/api/pedidos/admin/login`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:user.username,password,deviceId:device,deviceName:'CRM permisos E2E'}),
      });
      assert.equal(response.status,200);
      return (await response.json()).token;
    }
    const readOnlyToken=await loginRestricted(restrictedUsers[0],`crm-read-${suffix}`);
    const readOnlyDashboard=await fetch(`${baseUrl}/api/pedidos/admin/crm/dashboard`,{headers:{Authorization:`Bearer ${readOnlyToken}`}});
    assert.equal(readOnlyDashboard.status,200);
    const deniedExport=await fetch(`${baseUrl}/api/pedidos/admin/crm/export.csv`,{headers:{Authorization:`Bearer ${readOnlyToken}`}});
    assert.equal(deniedExport.status,403);
    const deniedLaunch=await fetch(`${baseUrl}/api/pedidos/admin/crm/campaigns/999999999/launch`,{method:'POST',headers:{Authorization:`Bearer ${readOnlyToken}`}});
    assert.equal(deniedLaunch.status,403);
    const noCrmToken=await loginRestricted(restrictedUsers[1],`crm-none-${suffix}`);
    const deniedDashboard=await fetch(`${baseUrl}/api/pedidos/admin/crm/dashboard`,{headers:{Authorization:`Bearer ${noCrmToken}`}});
    assert.equal(deniedDashboard.status,403);
  } finally {
    await releaseWebhookBlocker();
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    if (contactId) {
      await pool.query(`DELETE FROM pedidos_app_domain_events WHERE payload->>'contactId'=$1`, [String(contactId)]).catch(() => {});
      await pool.query(`DELETE FROM pedidos_app_crm_contacts WHERE id=$1`, [contactId]).catch(() => {});
    }
    if (campaignId) {
      await pool.query(`DELETE FROM pedidos_app_domain_events WHERE aggregate_type='crm_campaign' AND aggregate_id=$1`, [String(campaignId)]).catch(() => {});
      await pool.query(`DELETE FROM pedidos_app_crm_campaigns WHERE id=$1`, [campaignId]).catch(() => {});
    }
    if (segmentId) await pool.query(`DELETE FROM pedidos_app_crm_segments WHERE id=$1`, [segmentId]).catch(() => {});
    if (templateId) await pool.query(`DELETE FROM pedidos_app_crm_whatsapp_templates WHERE id=$1`, [templateId]).catch(() => {});
    if (webhookKeys.length) await pool.query(`DELETE FROM pedidos_app_crm_webhook_events WHERE event_key=ANY($1::text[])`, [webhookKeys]).catch(() => {});
    if (userIds.length) {
      await pool.query(`DELETE FROM pedidos_app_audit_logs WHERE user_id=ANY($1::int[])`, [userIds]).catch(() => {});
      await pool.query(`DELETE FROM pedidos_app_users WHERE id=ANY($1::int[])`, [userIds]).catch(() => {});
    }
    if (roleIds.length) await pool.query(`DELETE FROM pedidos_app_roles WHERE id=ANY($1::int[])`,[roleIds]).catch(()=>{});
    if (providerBefore) {
      await pool.query(`
        UPDATE pedidos_app_crm_provider_state SET
          configured=$2,webhook_connected=$3,number_connected=$4,display_phone_masked=$5,
          last_webhook_at=$6,last_inbound_at=$7,last_outbound_at=$8,last_error_code=$9,last_error_at=$10,updated_at=$11
        WHERE provider=$1
      `, [providerBefore.provider,providerBefore.configured,providerBefore.webhook_connected,providerBefore.number_connected,
        providerBefore.display_phone_masked,providerBefore.last_webhook_at,providerBefore.last_inbound_at,
        providerBefore.last_outbound_at,providerBefore.last_error_code,providerBefore.last_error_at,providerBefore.updated_at]).catch(() => {});
    }
    await pool.end();
  }
});
