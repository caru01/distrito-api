require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    // Preview: cuántos se van a actualizar
    const preview = await client.query(
      'SELECT COUNT(*) AS total FROM pedidos_app_crm_contacts ' +
      "WHERE deleted_at IS NULL AND source = 'WHATSAPP' AND marketing_opt_in IS NOT TRUE AND no_contact IS NOT TRUE"
    );
    console.log('Contactos WHATSAPP a actualizar:', preview.rows[0].total);

    // Ejecutar update
    const result = await client.query(
      'UPDATE pedidos_app_crm_contacts ' +
      "SET marketing_opt_in = TRUE, updated_at = NOW() " +
      "WHERE deleted_at IS NULL AND source = 'WHATSAPP' AND marketing_opt_in IS NOT TRUE AND no_contact IS NOT TRUE " +
      'RETURNING id'
    );
    console.log('Contactos actualizados:', result.rowCount);

    // Verificar resultado final
    const check = await client.query(
      'SELECT COUNT(*) FILTER (WHERE marketing_opt_in IS TRUE) AS elegibles, COUNT(*) AS total ' +
      'FROM pedidos_app_crm_contacts WHERE deleted_at IS NULL'
    );
    console.log('Estado final -> Elegibles:', check.rows[0].elegibles, '/ Total:', check.rows[0].total);

  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(e => { console.error('ERROR:', e.message); pool.end(); });
