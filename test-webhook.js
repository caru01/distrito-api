require('dotenv').config();
const { createPool } = require('./src/db.js');
const { processWhatsAppWebhook, registerWhatsAppWebhook, processStoredWhatsAppWebhook } = require('./src/crm-service.js');
const crypto = require('node:crypto');

async function runTests() {
  const pool = createPool();
  try {
    console.log('--- Test 1: Meta Proxy Inbound ---');
    const metaInbound = {
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "testmeta" },
            contacts: [{ wa_id: "573001234567", profile: { name: "Juan Meta" } }],
            messages: [{
              from: "573001234567", id: "wamid.meta1", timestamp: String(Math.floor(Date.now()/1000)),
              type: "text", text: { body: "Hola Meta" }
            }]
          }
        }]
      }]
    };
    await processWhatsAppWebhook(pool, metaInbound, JSON.stringify(metaInbound));
    console.log('OK Meta Inbound');

    console.log('--- Test 2: Meta Proxy Status ---');
    const metaStatus = {
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          field: "messages",
          value: {
            statuses: [{ id: "wamid.meta1", status: "delivered", timestamp: String(Math.floor(Date.now()/1000)) }]
          }
        }]
      }]
    };
    await processWhatsAppWebhook(pool, metaStatus, JSON.stringify(metaStatus));
    console.log('OK Meta Status');

    console.log('--- Test 3: YCloud Native Inbound ---');
    const ycloudInbound = {
      type: "whatsapp.inbound_message.received",
      whatsappMessage: {
        id: "wamid.ycloud1", from: "whatsapp:573001234568", to: "whatsapp:testycloud",
        type: "text", text: { body: "Hola YCloud" }, createdAt: new Date().toISOString()
      },
      customerProfile: { name: "Pedro YCloud" }
    };
    await processWhatsAppWebhook(pool, ycloudInbound, JSON.stringify(ycloudInbound));
    console.log('OK YCloud Inbound');

    console.log('--- Test 4: YCloud Native Outbound (Unknown -> Create OUTBOUND) ---');
    const ycloudOutbound = {
      type: "whatsapp.message.updated",
      whatsappMessage: {
        id: "wamid.ycloudout1", from: "whatsapp:testycloud", to: "whatsapp:573001234569",
        type: "text", text: { body: "Respuesta desde YCloud Inbox" },
        status: "sent", sendAt: new Date().toISOString()
      }
    };
    await processWhatsAppWebhook(pool, ycloudOutbound, JSON.stringify(ycloudOutbound));
    console.log('OK YCloud Outbound Create');

    console.log('--- Test 5: YCloud Native Outbound Status Update ---');
    const ycloudOutboundDelivered = {
      type: "whatsapp.message.updated",
      whatsappMessage: {
        id: "wamid.ycloudout1", from: "whatsapp:testycloud", to: "whatsapp:573001234569",
        status: "delivered", deliverAt: new Date().toISOString()
      }
    };
    await processWhatsAppWebhook(pool, ycloudOutboundDelivered, JSON.stringify(ycloudOutboundDelivered));
    console.log('OK YCloud Outbound Update');
    
    console.log('Verificando resultados en DB...');
    const result = await pool.query("SELECT message_type, direction, status, text_body, content->'from' as from_field FROM pedidos_app_crm_messages WHERE provider_message_id IN ('wamid.meta1', 'wamid.ycloud1', 'wamid.ycloudout1') ORDER BY created_at ASC");
    console.log(JSON.stringify(result.rows, null, 2));

  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await pool.end();
  }
}
runTests();
