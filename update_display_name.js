require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  try {
    // Update display_name for contact 2267
    const upd = await pool.query(
      'UPDATE pedidos_app_crm_contacts SET display_name = $1 WHERE id = $2 RETURNING *',
      ['MARIAM QUINTERO 💜', 2267]
    );
    console.log('Update result rows:', upd.rowCount);
    console.log('Updated contact:', upd.rows[0]);

    // Verify searches
    const tests = [
      { label: 'Mariam (display_name)', term: 'Mariam' },
      { label: 'MARSTUDI (username)', term: 'MARSTUDI' },
      { label: '@MARSTUDI (username with @)', term: '@MARSTUDI' },
      { label: 'BSUID', term: 'CO.1514055124256652' }
    ];
    for (const { label, term } of tests) {
      const q = term.trim();
      const termNoAt = q.startsWith('@') ? q.slice(1) : q;
      const res = await pool.query(`
        SELECT c.id AS crm_contact_id, c.display_name, c.username, c.bsuid
        FROM pedidos_app_crm_contacts c
        WHERE c.display_name ILIKE $1
          OR c.normalized_phone LIKE $2
          OR COALESCE(c.username, '') ILIKE $3
          OR COALESCE(c.bsuid, '') ILIKE $3
          OR c.id::text = $4
        LIMIT 1
      `, [`%${q}%`, `%${q.replace(/\D/g, '')}%`, `%${termNoAt}%`, q]);
      console.log(`Search ${label}: rows=${res.rowCount}`, res.rows[0]);
    }
  } catch (err) {
    console.error('Error executing script:', err);
  } finally {
    await pool.end();
  }
})();
