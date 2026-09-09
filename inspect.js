const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function inspect() {
  try {
    console.log("--- COLUMNS ---");
    const cols = await pool.query(`SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name = 'pedidos_app_crm_contacts'`);
    console.log(cols.rows);

    console.log("--- UNIQUE CONSTRAINTS (CONTACTS) ---");
    const uq = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'pedidos_app_crm_contacts' AND indexdef ILIKE '%UNIQUE%'`);
    console.log(uq.rows);

    console.log("--- STATUS VALUES ---");
    const check = await pool.query(`SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class t ON c.conrelid = t.oid WHERE t.relname = 'pedidos_app_crm_contacts' AND conname = 'crm_contacts_status_check'`);
    console.log(check.rows);

    console.log("--- TRIGGERS (CONTACTS) ---");
    const trgs = await pool.query(`SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'pedidos_app_crm_contacts'::regclass`);
    console.log(trgs.rows);

    console.log("--- DEPENDENT TABLES UNIQUE CONSTRAINTS ---");
    const fk_tables = [
      'pedidos_app_crm_contact_customers', 'pedidos_app_crm_consents', 'pedidos_app_crm_contact_tags',
      'pedidos_app_crm_contact_interests', 'pedidos_app_crm_notes', 'pedidos_app_crm_conversations',
      'pedidos_app_crm_messages', 'pedidos_app_crm_activities', 'pedidos_app_orders',
      'pedidos_app_crm_segment_members', 'pedidos_app_crm_campaign_recipients',
      'pedidos_app_crm_automation_runs', 'pedidos_app_crm_attributions'
    ];
    for (const tbl of fk_tables) {
       const tuq = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1 AND indexdef ILIKE '%UNIQUE%'`, [tbl]);
       if (tuq.rows.length > 0) {
         console.log(tbl, tuq.rows);
       }
    }
  } finally {
    await pool.end();
  }
}
inspect().catch(console.error);
