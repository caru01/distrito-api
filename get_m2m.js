const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function checkCols() {
  const fk_tables = [
      'pedidos_app_crm_contact_customers', 'pedidos_app_crm_consents', 'pedidos_app_crm_contact_tags',
      'pedidos_app_crm_contact_interests', 'pedidos_app_crm_segment_members', 'pedidos_app_crm_campaign_recipients'
    ];
  for (const t of fk_tables) {
    const res = await pool.query(SELECT column_name FROM information_schema.columns WHERE table_name = , [t]);
    console.log(t, res.rows.map(r => r.column_name).join(', '));
  }
  await pool.end();
}
checkCols().catch(console.error);
