const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function verify() {
  const f1 = await pool.query("SELECT proname FROM pg_proc WHERE proname = 'pedidos_app_crm_merge_contacts'");
  console.log('merge_contacts exists:', f1.rows.length > 0);

  const t1 = await pool.query("SELECT tgname FROM pg_trigger WHERE tgname = 'trg_crm_order_before'");
  console.log('trg_crm_order_before exists:', t1.rows.length > 0);

  const c1 = await pool.query("SELECT conname FROM pg_constraint WHERE conname = 'crm_contacts_identity_check'");
  console.log('crm_contacts_identity_check exists:', c1.rows.length > 0);

  // Checks no unexpected modifications recently (last 1 minute)
  // Assuming updated_at would reflect modifications
  const modsContacts = await pool.query("SELECT count(*) FROM pedidos_app_crm_contacts WHERE updated_at > NOW() - INTERVAL '1 minute'");
  console.log('Contacts modified in last minute:', modsContacts.rows[0].count);

  const modsOrders = await pool.query("SELECT count(*) FROM pedidos_app_orders WHERE created_at > NOW() - INTERVAL '1 minute' OR status != status");
  console.log('Orders modified in last minute (just simple check):', modsOrders.rows[0].count);

  const modsCamps = await pool.query("SELECT count(*) FROM pedidos_app_crm_campaigns WHERE updated_at > NOW() - INTERVAL '1 minute'");
  console.log('Campaigns modified in last minute:', modsCamps.rows[0].count);

  await pool.end();
}
verify().catch(console.error);
