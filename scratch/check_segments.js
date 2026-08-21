require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const total = await pool.query('SELECT COUNT(*) FROM pedidos_app_crm_contacts WHERE deleted_at IS NULL');
  console.log('Total contactos CRM:', total.rows[0].count);

  const optIn = await pool.query(
    'SELECT COUNT(*) AS total,' +
    ' COUNT(*) FILTER (WHERE marketing_opt_in IS TRUE) AS opt_in_true,' +
    ' COUNT(*) FILTER (WHERE marketing_opt_in IS FALSE) AS opt_in_false,' +
    ' COUNT(*) FILTER (WHERE marketing_opt_in IS NULL) AS opt_in_null,' +
    ' COUNT(*) FILTER (WHERE marketing_opt_out IS TRUE) AS opt_out,' +
    ' COUNT(*) FILTER (WHERE no_contact IS TRUE) AS no_contact' +
    ' FROM pedidos_app_crm_contacts WHERE deleted_at IS NULL'
  );
  console.log('Consent breakdown:', JSON.stringify(optIn.rows[0]));

  const sources = await pool.query(
    'SELECT source, COUNT(*) AS c FROM pedidos_app_crm_contacts WHERE deleted_at IS NULL GROUP BY source ORDER BY c DESC'
  );
  console.log('Por fuente:', sources.rows.map(r => r.source + ':' + r.c).join(', '));

  const sample = await pool.query(
    'SELECT id, source, status, marketing_opt_in, orders_count FROM pedidos_app_crm_contacts WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 5'
  );
  console.log('Muestra reciente:');
  sample.rows.forEach(r => console.log(' ', JSON.stringify(r)));

  await pool.end();
}
main().catch(e => { console.error(e.message); pool.end(); });
