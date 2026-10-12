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

async function exportTable(tableName, outStream) {
  const result = await pool.query(`SELECT * FROM ${tableName} ORDER BY id ASC`);
  if (result.rows.length === 0) return;
  
  const columns = Object.keys(result.rows[0]);
  
  outStream.write(`\n-- ============================\n`);
  outStream.write(`-- TABLE: ${tableName}\n`);
  outStream.write(`-- ============================\n`);
   // Be careful with foreign keys! Actually, PostgreSQL doesn't allow DISABLE TRIGGER ALL for normal users. We will just delete or insert.
  
  // Actually, let's just do INSERT ... ON CONFLICT (id) DO NOTHING
  for (const row of result.rows) {
    const values = columns.map(col => escapeValue(row[col]));
    outStream.write(`INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')}) ON CONFLICT (id) DO NOTHING;\n`);
  }
  
  outStream.write(`\nSELECT setval('${tableName}_id_seq', (SELECT MAX(id) FROM ${tableName}));\n`);
}

async function run() {
  try {
    const outStream = fs.createWriteStream('crm_migration.sql');
    outStream.write(`-- MIGRATION SCRIPT FROM ROUND-LAKE TO NEW DATABASE\n`);
    outStream.write(`BEGIN;\n`);
    
    await exportTable('pedidos_app_crm_contacts', outStream);
    await exportTable('pedidos_app_crm_conversations', outStream);
    await exportTable('pedidos_app_crm_messages', outStream);
    
    outStream.write(`\nCOMMIT;\n`);
    outStream.end();
    
    console.log('Export successful: crm_migration.sql generated.');
  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}

run();
