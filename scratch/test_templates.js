require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createWhatsAppClient } = require('../src/whatsapp-cloud');

async function main() {
  const client = createWhatsAppClient();
  console.log('WhatsApp configurado?', client.isConfigured());
  
  if (!client.isConfigured()) {
    console.log('ERROR: WhatsApp NO está configurado. Verifica las variables de entorno.');
    return;
  }

  console.log('Consultando plantillas en Meta/YCloud...');
  try {
    const result = await client.listTemplates();
    console.log('Plantillas recibidas:', result.data ? result.data.length : 0);
    if (result.data && result.data.length > 0) {
      result.data.slice(0, 5).forEach(t => {
        console.log(' -', t.name, '|', t.language, '|', t.status);
      });
    } else {
      console.log('RESPUESTA COMPLETA:', JSON.stringify(result, null, 2));
    }
  } catch (e) {
    console.log('ERROR al consultar plantillas:', e.message);
    console.log('Código:', e.code);
    console.log('Detalle:', JSON.stringify(e.details));
  }
}
main();
