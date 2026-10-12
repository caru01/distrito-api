const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({ connectionString: 'postgresql://neondb_owner:npg_pClfKMJxI0a7@ep-round-lake-at22joot-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require' });

function escapeValue(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  if (val instanceof Date) return `'${val.toISOString()}'`;
  if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
  return `'${String(val).replace(/'/g, "''")}'`;
}

async function run() {
  try {
    const result = await pool.query('SELECT * FROM pedidos_app_crm_contacts ORDER BY id ASC');
    if (result.rows.length === 0) {
        console.log('No contacts found.');
        return;
    }

    const outStream = fs.createWriteStream('crm_contacts_only_migration.sql');
    outStream.write(`-- MIGRATION SCRIPT FOR CRM CONTACTS ONLY\n`);
    outStream.write(`-- INSERTS MISSING CONTACTS, IGNORING EXISTING ONES BY PHONE\n`);
    

    // We exclude 'id' so the new DB auto-generates it
    const allColumns = Object.keys(result.rows[0]);
    const insertColumns = allColumns.filter(col => col !== 'id');

    for (const row of result.rows) {
      const values = insertColumns.map(col => { if (col === 'primary_customer_id' || col === 'assigned_user_id') return 'NULL'; return escapeValue(row[col]); });
      outStream.write(`INSERT INTO pedidos_app_crm_contacts (${insertColumns.join(', ')}) VALUES (${values.join(', ')}) ON CONFLICT (normalized_phone) DO NOTHING;\n`);
    }

    
    outStream.end();
    console.log('crm_contacts_only_migration.sql generated.');
  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
run();
