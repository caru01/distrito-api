const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

const API_URL = 'https://distrito-api-tns1.onrender.com';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function controlledTests() {
  const client = await pool.connect();
  
  try {
    // 1. Crear Contacto BSUID
    const r1 = await client.query("INSERT INTO pedidos_app_crm_contacts (display_name, bsuid, source, status) VALUES ('TEST API BSUID', 'CO.CTRL_TEST_BSUID', 'TEST', 'NUEVO_CONTACTO') RETURNING id");
    const idBsuid = r1.rows[0].id;
    console.log('Creado BSUID:', idBsuid);

    // Prueba 1: Contacto con telefono
    console.log('Ejecutando POST con telefono...');
    const res1 = await axios.post(API_URL + '/api/pedidos/checkout', {
      customer: {
        name: 'TEST API PHONE',
        phone: '3991111111',
        deliveryType: 'recogida',
        paymentMethod: 'efectivo'
      },
      cart: [{ id: 1, name: 'Burger', price: 100, quantity: 1 }],
      total: 100
    });
    console.log('Prueba 1 OK:', res1.data.orderId);

    // Prueba 2: Contacto solo BSUID
    console.log('Ejecutando POST solo BSUID...');
    const res2 = await axios.post(API_URL + '/api/pedidos/checkout', {
      customer: {
        name: 'TEST API BSUID',
        phone: null,
        crm_contact_id: idBsuid,
        deliveryType: 'recogida',
        paymentMethod: 'efectivo'
      },
      cart: [{ id: 1, name: 'Burger', price: 100, quantity: 1 }],
      total: 100
    });
    console.log('Prueba 2 OK:', res2.data.orderId);

    // Prueba 3: BSUID -> posteriormente telefono
    console.log('Ejecutando POST BSUID -> Telefono...');
    const res3 = await axios.post(API_URL + '/api/pedidos/checkout', {
      customer: {
        name: 'TEST API BSUID',
        phone: '3992222222',
        crm_contact_id: idBsuid,
        deliveryType: 'recogida',
        paymentMethod: 'efectivo'
      },
      cart: [{ id: 1, name: 'Burger', price: 100, quantity: 1 }],
      total: 100
    });
    console.log('Prueba 3 OK:', res3.data.orderId);

    // Validar notificaciones 
    // Not needed since notify-whatsapp is called manually in admin, but checkout might trigger other webhooks.
    
    // Check DB changes
    console.log('\nAuditando contactos...');
    const auditPhone1 = await client.query("SELECT * FROM pedidos_app_crm_contacts WHERE normalized_phone = '+573991111111'");
    console.log('Contacto Telefono 1:', auditPhone1.rows.length, auditPhone1.rows[0].id);

    const auditBsuid = await client.query("SELECT * FROM pedidos_app_crm_contacts WHERE id = ", [idBsuid]);
    console.log('Contacto BSUID final:', auditBsuid.rows[0].normalized_phone, auditBsuid.rows[0].bsuid);

  } catch (err) {
    console.error('Error in tests:', err.response ? err.response.data : err.message);
  } finally {
    client.release();
    pool.end();
  }
}
controlledTests();
