const { Pool } = require('pg');
require('dotenv').config();
const fs = require('fs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function backup() {
  const q1 = await pool.query("SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'pedidos_app_crm_sync_order_before'");
  let backupContent = '-- BACKUP BEFORE MIGRATION 024 --\n\n';
  if (q1.rows.length > 0) {
    backupContent += q1.rows[0].pg_get_functiondef + ';\n\n';
  }
  
  const q2 = await pool.query("SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'trg_crm_order_before'");
  if (q2.rows.length > 0) {
    backupContent += q2.rows[0].pg_get_triggerdef + ';\n\n';
  }
  
  fs.writeFileSync('migrations/backup_before_024.sql', backupContent);
  console.log('Backup done.');
  await pool.end();
}
backup().catch(console.error);
