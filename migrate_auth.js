const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    console.log('Starting DB migration for Auth & Security...');

    // 1. Create Roles and Permissions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_app_roles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        description TEXT
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_app_permissions (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        description TEXT
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_app_role_permissions (
        role_id INTEGER REFERENCES pedidos_app_roles(id) ON DELETE CASCADE,
        permission_id INTEGER REFERENCES pedidos_app_permissions(id) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_id)
      );
    `);

    // 2. Create Audit Logs
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_app_audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        username_attempted VARCHAR(255),
        action VARCHAR(100) NOT NULL,
        ip VARCHAR(100),
        browser VARCHAR(100),
        os VARCHAR(100),
        location VARCHAR(100),
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Create Sessions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_app_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        token_jti VARCHAR(255) UNIQUE, 
        ip VARCHAR(100),
        browser VARCHAR(100),
        os VARCHAR(100),
        location VARCHAR(100),
        status VARCHAR(50) DEFAULT 'Activa',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP
      );
    `);

    // 4. Update Users Table
    const addColumn = async (table, column, definition) => {
      try {
        await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`Added ${column} to ${table}`);
      } catch (e) {
        if (e.code === '42701') {
          console.log(`Column ${column} already exists in ${table}`);
        } else {
          throw e;
        }
      }
    };

    await addColumn('pedidos_app_users', 'email', 'VARCHAR(255)');
    await addColumn('pedidos_app_users', 'phone', 'VARCHAR(255)');
    await addColumn('pedidos_app_users', 'photo_url', 'VARCHAR(500)');
    await addColumn('pedidos_app_users', 'branch', 'VARCHAR(255)');
    await addColumn('pedidos_app_users', 'status', "VARCHAR(50) DEFAULT 'Activo'");
    await addColumn('pedidos_app_users', 'failed_attempts', 'INTEGER DEFAULT 0');
    await addColumn('pedidos_app_users', 'blocked_until', 'TIMESTAMP');
    await addColumn('pedidos_app_users', 'last_access', 'TIMESTAMP');
    await addColumn('pedidos_app_users', 'role_id', 'INTEGER REFERENCES pedidos_app_roles(id)');

    // 5. Seed default roles if empty
    const roleCheck = await pool.query('SELECT COUNT(*) FROM pedidos_app_roles');
    if (parseInt(roleCheck.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO pedidos_app_roles (name, description) VALUES 
        ('Administrador', 'Acceso total al sistema'),
        ('Cajero', 'Gestión de pedidos y caja'),
        ('Mesero', 'Solo toma de pedidos')
      `);
      console.log('Seeded default roles');
    }

    // 6. Map existing users to Administrador role if they have string 'admin'
    const adminRole = await pool.query("SELECT id FROM pedidos_app_roles WHERE name = 'Administrador'");
    if (adminRole.rows.length > 0) {
      const adminId = adminRole.rows[0].id;
      await pool.query(`UPDATE pedidos_app_users SET role_id = $1 WHERE role = 'admin' AND role_id IS NULL`, [adminId]);
    }

    console.log('Migration completed successfully!');

  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    pool.end();
  }
}

migrate();
