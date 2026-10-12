const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({ connectionString: 'postgresql://neondb_owner:npg_pClfKMJxI0a7@ep-round-lake-at22joot-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require' });

async function run() {
  try {
    const contacts = await pool.query('SELECT * FROM pedidos_app_crm_contacts ORDER BY id ASC');
    const messages = await pool.query('SELECT * FROM pedidos_app_crm_messages ORDER BY id ASC');
    
    let sql = `-- MIGRATION SCRIPT FOR CRM CONTACTS AND MESSAGES\n\n`;
    
    sql += `-- Disable triggers if necessary, or just insert\n`;
    sql += `BEGIN;\n\n`;
    
    sql += `-- Insert Contacts\n`;
    for (const c of contacts.rows) {
      const id = c.id;
      const phone = c.phone.replace(/'/g, "''");
      const name = c.name ? `'${c.name.replace(/'/g, "''")}'` : 'NULL';
      const address = c.address ? `'${c.address.replace(/'/g, "''")}'` : 'NULL';
      const barrio = c.barrio ? `'${c.barrio.replace(/'/g, "''")}'` : 'NULL';
      const comments = c.comments ? `'${c.comments.replace(/'/g, "''")}'` : 'NULL';
      const created_at = c.created_at ? `'${c.created_at.toISOString()}'` : 'NULL';
      const updated_at = c.updated_at ? `'${c.updated_at.toISOString()}'` : 'NULL';
      const total_orders = c.total_orders || 0;
      const total_spent = c.total_spent || 0;
      
      sql += `INSERT INTO pedidos_app_crm_contacts (id, phone, name, address, barrio, comments, created_at, updated_at, total_orders, total_spent) VALUES (${id}, '${phone}', ${name}, ${address}, ${barrio}, ${comments}, ${created_at}, ${updated_at}, ${total_orders}, ${total_spent}) ON CONFLICT (id) DO NOTHING;\n`;
    }
    
    sql += `\n-- Reset Sequence for Contacts\n`;
    sql += `SELECT setval('pedidos_app_crm_contacts_id_seq', (SELECT MAX(id) FROM pedidos_app_crm_contacts));\n\n`;

    sql += `-- Insert Messages\n`;
    for (const m of messages.rows) {
      const id = m.id;
      const contact_id = m.contact_id;
      const role = m.role ? `'${m.role.replace(/'/g, "''")}'` : 'NULL';
      const content = m.content ? `'${m.content.replace(/'/g, "''")}'` : 'NULL';
      const message_id = m.message_id ? `'${m.message_id.replace(/'/g, "''")}'` : 'NULL';
      const status = m.status ? `'${m.status.replace(/'/g, "''")}'` : 'NULL';
      const created_at = m.created_at ? `'${m.created_at.toISOString()}'` : 'NULL';
      const delivered_at = m.delivered_at ? `'${m.delivered_at.toISOString()}'` : 'NULL';
      const read_at = m.read_at ? `'${m.read_at.toISOString()}'` : 'NULL';
      
      sql += `INSERT INTO pedidos_app_crm_messages (id, contact_id, role, content, message_id, status, created_at, delivered_at, read_at) VALUES (${id}, ${contact_id}, ${role}, ${content}, ${message_id}, ${status}, ${created_at}, ${delivered_at}, ${read_at}) ON CONFLICT (id) DO NOTHING;\n`;
    }
    
    sql += `\n-- Reset Sequence for Messages\n`;
    sql += `SELECT setval('pedidos_app_crm_messages_id_seq', (SELECT MAX(id) FROM pedidos_app_crm_messages));\n\n`;

    sql += `COMMIT;\n`;
    
    fs.writeFileSync('crm_migration.sql', sql);
    console.log('crm_migration.sql generated successfully.');
  } catch(e) { 
    console.error(e); 
  } finally { 
    pool.end(); 
  }
}
run();
