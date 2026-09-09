const { Pool } = require('pg');
require('dotenv').config();

const API_URL = 'https://distrito-api-tns1.onrender.com';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function controlledTests() {
  const client = await pool.connect();
  
  try {
    const r1 = await client.query("INSERT INTO pedidos_app_crm_contacts (display_name, bsuid, source, status) VALUES ('TEST API BSUID', 'CO.CTRL_TEST_BSUID', 'TEST', 'NUEVO_CONTACTO') RETURNING id");
    const idBsuid = r1.rows[0].id;
    console.log('Creado BSUID:', idBsuid);

    console.log('Ejecutando POST con telefono...');
    const req1 = await fetch(API_URL + '/api/pedidos/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: { name: 'TEST API PHONE', phone: '3991111111', deliveryType: 'recogida', paymentMethod: 'efectivo' },
        cart: [{ id: 1, name: 'Burger', price: 100, quantity: 1 }], total: 100
      })
    });
    const res1 = await req1.json();
    console.log('Prueba 1 OK:', res1.orderId || res1);

    console.log('Ejecutando POST solo BSUID...');
    const req2 = await fetch(API_URL + '/api/pedidos/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: { name: 'TEST API BSUID', phone: '', crm_contact_id: idBsuid, deliveryType: 'recogida', paymentMethod: 'efectivo' },
        cart: [{ id: 1, name: 'Burger', price: 100, quantity: 1 }], total: 100
      })
    });
    const res2 = await req2.json();
    console.log('Prueba 2 OK:', res2.orderId || res2);

    console.log('Ejecutando POST BSUID -> Telefono...');
    const req3 = await fetch(API_URL + '/api/pedidos/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: { name: 'TEST API BSUID', phone: '3992222222', crm_contact_id: idBsuid, deliveryType: 'recogida', paymentMethod: 'efectivo' },
        cart: [{ id: 1, name: 'Burger', price: 100, quantity: 1 }], total: 100
      })
    });
    const res3 = await req3.json();
    console.log('Prueba 3 OK:', res3.orderId || res3);
    
    console.log('\nAuditando contactos...');
    const auditPhone1 = await client.query("SELECT * FROM pedidos_app_crm_contacts WHERE normalized_phone = '+573991111111'");
    console.log('Contacto Telefono 1 id:', auditPhone1.rows[0] ? auditPhone1.rows[0].id : null);

    const auditBsuid = await client.query("SELECT * FROM pedidos_app_crm_contacts WHERE id = ", [idBsuid]);
    console.log('Contacto BSUID final phone:', auditBsuid.rows[0].normalized_phone, 'bsuid:', auditBsuid.rows[0].bsuid);

  } catch (err) {
    console.error('Error in tests:', err);
  } finally {
    client.release();
    pool.end();
  }
}
controlledTests();
