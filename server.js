console.log('🚀 Starting backend server...');

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');

const publicVapidKey = process.env.VAPID_PUBLIC_KEY || 'BBCJtzBn22IJcujyWlCCwtSAyWLfsiELTqWAjQcEiOuPX0yiad9P5LIpMJv5T8VwkHJU0vxLHTqFYImzLYWBQyU';
const privateVapidKey = process.env.VAPID_PRIVATE_KEY || 'Sn-oYBv_LJxdaKVe3S7GEdlKGuT9n50SifBdNpDPpxs';
const vapidEmail = process.env.VAPID_EMAIL || 'mailto:soporte@distrito.com';
webpush.setVapidDetails(vapidEmail, publicVapidKey, privateVapidKey);

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET no está definida en las variables de entorno. El servidor no puede iniciar de forma segura.');
  process.exit(1);
}

const app = express();

// Restringir CORS a dominios conocidos
const allowedOrigins = [
  'https://distrito-web.vercel.app',
  'https://distrito-admin.vercel.app',
  /\.vercel\.app$/,          // Cualquier preview de Vercel
  /^http:\/\/localhost/,      // Desarrollo local
];
app.use(cors({
  origin: (origin, callback) => {
    // Permitir peticiones sin origin (Postman, Render health checks)
    if (!origin) return callback(null, true);
    const allowed = allowedOrigins.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    );
    if (allowed) return callback(null, true);
    return callback(new Error(`CORS: Origen no permitido: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));

let getHorariosStatus = async () => ({ isOpen: true }); // Fallback before initialized
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const dbUrl = process.env.DATABASE_URL || process.env.VITE_NEON_URL;

const pool = new Pool({
  connectionString: dbUrl,
  ssl: {
    rejectUnauthorized: false
  }
});
pool.connect()
  .then(client => {
    console.log('✅ Conectado a Neon correctamente');
    client.release();
  })
  .catch(err => {
    console.error('❌ Error conectando a Neon:', err);
  });

const FINAL_ORDER_STATUSES = new Set(['Entregado', 'Completado']);

// El inventario se controla por movimientos y lotes. `stock` se conserva solo
// por compatibilidad con pantallas antiguas; nunca es la fuente de verdad.
async function ensureRealInventorySchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS pedidos_app_purchases (
      id SERIAL PRIMARY KEY,
      invoice_number VARCHAR(100),
      supplier VARCHAR(255),
      purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
      total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      iva_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pedidos_app_purchase_items (
      id SERIAL PRIMARY KEY,
      purchase_id INTEGER NOT NULL REFERENCES pedidos_app_purchases(id) ON DELETE RESTRICT,
      inventory_id INTEGER NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE RESTRICT,
      quantity NUMERIC(14,4) NOT NULL,
      unit_cost NUMERIC(14,4) NOT NULL,
      total_cost NUMERIC(14,2) NOT NULL,
      iva_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      lot_code VARCHAR(100),
      expiration_date DATE
    );
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS sku VARCHAR(100);
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS purchase_unit VARCHAR(50);
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS consumption_unit VARCHAR(50);
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS conversion_factor NUMERIC(14,4) DEFAULT 1;
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS max_stock NUMERIC(14,4);
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Activo';
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS observations TEXT;
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS branch_id INTEGER DEFAULT 1;
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS unit VARCHAR(50);
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS image TEXT;
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'Ingrediente';
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS expiry_date DATE;
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS supplier VARCHAR(255);
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS min_stock NUMERIC(14,4) DEFAULT 0;
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS stock NUMERIC(14,4) DEFAULT 0;
    ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(14,4) DEFAULT 0;
    ALTER TABLE pedidos_app_purchase_items ADD COLUMN IF NOT EXISTS lot_code VARCHAR(100);
    ALTER TABLE pedidos_app_purchase_items ADD COLUMN IF NOT EXISTS expiration_date DATE;

    CREATE TABLE IF NOT EXISTS pedidos_app_inventory_lots (
      id BIGSERIAL PRIMARY KEY,
      inventory_id INTEGER NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE RESTRICT,
      purchase_item_id INTEGER,
      branch_id INTEGER NOT NULL DEFAULT 1,
      lot_code VARCHAR(100) NOT NULL,
      source_quantity NUMERIC(14,4) NOT NULL,
      source_unit VARCHAR(50),
      initial_quantity NUMERIC(14,4) NOT NULL CHECK (initial_quantity > 0),
      available_quantity NUMERIC(14,4) NOT NULL CHECK (available_quantity >= 0),
      unit_cost NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
      expiration_date DATE,
      status VARCHAR(20) NOT NULL DEFAULT 'Disponible',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (branch_id, lot_code)
    );

    CREATE TABLE IF NOT EXISTS pedidos_app_inventory_movements (
      id BIGSERIAL PRIMARY KEY,
      inventory_id INTEGER NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE RESTRICT,
      lot_id BIGINT REFERENCES pedidos_app_inventory_lots(id) ON DELETE RESTRICT,
      branch_id INTEGER NOT NULL DEFAULT 1,
      movement_type VARCHAR(30) NOT NULL,
      quantity NUMERIC(14,4) NOT NULL,
      unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
      balance_after NUMERIC(14,4),
      reference_type VARCHAR(30),
      reference_id VARCHAR(100),
      notes TEXT,
      created_by VARCHAR(100) DEFAULT 'Administrador',
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    ALTER TABLE pedidos_app_inventory_movements ADD COLUMN IF NOT EXISTS lot_id BIGINT;
    ALTER TABLE pedidos_app_inventory_movements ADD COLUMN IF NOT EXISTS branch_id INTEGER DEFAULT 1;
    ALTER TABLE pedidos_app_inventory_movements ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(14,4) DEFAULT 0;
    ALTER TABLE pedidos_app_inventory_movements ADD COLUMN IF NOT EXISTS balance_after NUMERIC(14,4);
    ALTER TABLE pedidos_app_inventory_movements ADD COLUMN IF NOT EXISTS reference_type VARCHAR(30);
    ALTER TABLE pedidos_app_inventory_movements ADD COLUMN IF NOT EXISTS reference_id VARCHAR(100);
    ALTER TABLE pedidos_app_inventory_movements ADD COLUMN IF NOT EXISTS created_by VARCHAR(100) DEFAULT 'Administrador';

    CREATE TABLE IF NOT EXISTS pedidos_app_order_inventory_consumptions (
      id BIGSERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES pedidos_app_orders(id) ON DELETE RESTRICT,
      recipe_id INTEGER,
      inventory_id INTEGER NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE RESTRICT,
      lot_id BIGINT NOT NULL REFERENCES pedidos_app_inventory_lots(id) ON DELETE RESTRICT,
      movement_id BIGINT REFERENCES pedidos_app_inventory_movements(id) ON DELETE RESTRICT,
      quantity NUMERIC(14,4) NOT NULL CHECK (quantity > 0),
      unit_cost NUMERIC(14,4) NOT NULL,
      reversed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_lots_fifo ON pedidos_app_inventory_lots (inventory_id, branch_id, created_at, id) WHERE available_quantity > 0;
    CREATE INDEX IF NOT EXISTS idx_inventory_movements_item ON pedidos_app_inventory_movements (inventory_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_order_consumptions_order ON pedidos_app_order_inventory_consumptions (order_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_sku_unique ON pedidos_app_inventory (sku) WHERE sku IS NOT NULL;
  `);
}

async function getInventoryAvailability(client, inventoryId, branchId = 1) {
  const { rows } = await client.query(
    'SELECT COALESCE(SUM(available_quantity), 0) AS quantity FROM pedidos_app_inventory_lots WHERE inventory_id = $1 AND branch_id = $2 AND status = \'Disponible\'',
    [inventoryId, branchId]
  );
  return Number(rows[0].quantity);
}

function skuPrefix(value) {
  const normalized = String(value || 'ITEM').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const letters = normalized.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 3);
  return letters || 'ITEM';
}

async function generateIngredientSku(client, category) {
  const prefix = skuPrefix(category);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [prefix]);
  const { rows } = await client.query(
    'SELECT COUNT(*)::int AS total FROM pedidos_app_inventory WHERE sku LIKE $1',
    [`${prefix}-%`]
  );
  return `${prefix}-${String(Number(rows[0].total) + 1).padStart(4, '0')}`;
}

async function createInventoryMovement(client, data) {
  const { rows } = await client.query(
    `INSERT INTO pedidos_app_inventory_movements
      (inventory_id, lot_id, branch_id, movement_type, quantity, unit_cost, balance_after, reference_type, reference_id, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [data.inventoryId, data.lotId || null, data.branchId || 1, data.type, data.quantity, data.unitCost || 0,
    data.balanceAfter ?? null, data.referenceType || null, data.referenceId ? String(data.referenceId) : null,
    data.notes || null, data.createdBy || 'Administrador']
  );
  return rows[0];
}

async function consumeOrderInventoryFIFO(client, order, createdBy = 'Administrador') {
  const cart = Array.isArray(order.cart_json) ? order.cart_json : JSON.parse(order.cart_json || '[]');
  for (const cartItem of cart) {
    const productId = cartItem.id || cartItem.product_id;
    const productQuantity = Number(cartItem.quantity || cartItem.qty || 1);
    if (!productId || productQuantity <= 0) continue;

    const { rows: recipeItems } = await client.query(`
      SELECT r.id AS recipe_id, r.cantidad_usada, ren.ingrediente_id
      FROM pedidos_app_recipes r
      JOIN pedidos_app_rendimientos ren ON ren.id = r.rendimiento_id
      WHERE r.product_id::text = $1 AND ren.ingrediente_id IS NOT NULL
    `, [String(productId)]);

    for (const recipeItem of recipeItems) {
      let pending = Number(recipeItem.cantidad_usada) * productQuantity;
      const { rows: lots } = await client.query(`
        SELECT * FROM pedidos_app_inventory_lots
        WHERE inventory_id = $1 AND branch_id = 1 AND status = 'Disponible' AND available_quantity > 0
        ORDER BY created_at ASC, id ASC FOR UPDATE
      `, [recipeItem.ingrediente_id]);

      for (const lot of lots) {
        if (pending <= 0) break;
        const consumed = Math.min(pending, Number(lot.available_quantity));
        const balance = Number(lot.available_quantity) - consumed;
        await client.query(
          `UPDATE pedidos_app_inventory_lots
           SET available_quantity = $1, status = CASE WHEN $1 = 0 THEN 'Agotado' ELSE 'Disponible' END
           WHERE id = $2`,
          [balance, lot.id]
        );
        const movement = await createInventoryMovement(client, {
          inventoryId: recipeItem.ingrediente_id, lotId: lot.id, type: 'Venta', quantity: -consumed,
          unitCost: lot.unit_cost, balanceAfter: balance, referenceType: 'Pedido', referenceId: order.id,
          notes: `Consumo FIFO del pedido #${order.id}`, createdBy
        });
        await client.query(
          `INSERT INTO pedidos_app_order_inventory_consumptions
           (order_id, recipe_id, inventory_id, lot_id, movement_id, quantity, unit_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [order.id, recipeItem.recipe_id, recipeItem.ingrediente_id, lot.id, movement.id, consumed, lot.unit_cost]
        );
        pending -= consumed;
      }
      if (pending > 0) {
        const error = new Error(`Inventario insuficiente para el ingrediente #${recipeItem.ingrediente_id}. Faltan ${pending} unidades.`);
        error.statusCode = 409;
        throw error;
      }
    }
  }
}

async function reverseOrderInventory(client, orderId, createdBy = 'Administrador') {
  const { rows: consumptions } = await client.query(`
    SELECT c.*, l.available_quantity
    FROM pedidos_app_order_inventory_consumptions c
    JOIN pedidos_app_inventory_lots l ON l.id = c.lot_id
    WHERE c.order_id = $1 AND c.reversed_at IS NULL
    ORDER BY c.id ASC FOR UPDATE OF l, c
  `, [orderId]);
  for (const consumption of consumptions) {
    const balance = Number(consumption.available_quantity) + Number(consumption.quantity);
    await client.query(
      `UPDATE pedidos_app_inventory_lots SET available_quantity = $1, status = 'Disponible' WHERE id = $2`,
      [balance, consumption.lot_id]
    );
    await createInventoryMovement(client, {
      inventoryId: consumption.inventory_id, lotId: consumption.lot_id, type: 'Devolución', quantity: consumption.quantity,
      unitCost: consumption.unit_cost, balanceAfter: balance, referenceType: 'Pedido', referenceId: orderId,
      notes: `Reverso del pedido #${orderId}`, createdBy
    });
    await client.query('UPDATE pedidos_app_order_inventory_consumptions SET reversed_at = NOW() WHERE id = $1', [consumption.id]);
  }
}

// Wrapper de reconexión automática para manejar el "Cold Start" de Neon
const originalQuery = pool.query.bind(pool);
pool.query = async function (text, params) {
  const MAX_RETRIES = 3;
  let lastError;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await originalQuery(text, params);
    } catch (err) {
      lastError = err;
      // Si el error es de sintaxis (código que empieza con 42), fallar de inmediato
      if (err.code && err.code.startsWith('42')) throw err;

      console.warn(`[Neon DB] Intento ${i + 1}/${MAX_RETRIES} falló. Reintentando en ${1000 * (i + 1)}ms... Error: ${err.message}`);
      // Esperar 1 segundo en el primer intento, 2 en el segundo...
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
  console.error('[Neon DB] Fallo crítico después de múltiples reintentos.');
  throw lastError;
};

// Datos de prueba iniciales basados en el frontend
const seedProducts = [
  { title: 'Hamburguesa Clásica', description: 'Carne 100% de res, queso cheddar, lechuga, tomate y nuestra salsa secreta.', price: 15000, category: 'hamburguesas', image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&q=80&w=500' },
  { title: 'Doble Bacon Burger', description: 'Doble carne, doble queso, tocino crujiente, cebolla caramelizada y salsa BBQ.', price: 22000, category: 'hamburguesas', image: 'https://images.unsplash.com/photo-1594212691516-b2a9e94bd548?auto=format&fit=crop&q=80&w=500' },
  { title: 'Pizza Pepperoni', description: 'Salsa de tomate artesanal, mozzarella fundida y doble pepperoni.', price: 28000, category: 'pizzas', image: 'https://images.unsplash.com/photo-1628840042765-356cda07504e?auto=format&fit=crop&q=80&w=500' },
  { title: 'Coca-Cola Zero 500ml', description: 'Bebida refrescante sin azúcar.', price: 5000, category: 'bebidas', image: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?auto=format&fit=crop&q=80&w=500' },
  { title: 'Limonada de Coco', description: 'Refrescante limonada natural con crema de coco.', price: 8000, category: 'bebidas', image: 'https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?auto=format&fit=crop&q=80&w=500' },
  { title: 'Cheesecake de Frutos Rojos', description: 'Suave tarta de queso con base de galleta y coulis de frutos rojos.', price: 12000, category: 'postres', image: 'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?auto=format&fit=crop&q=80&w=500' }
];

app.get('/api/pedidos/init', async (req, res) => {
  try {
    // Si no hay dbUrl configurada, devolver datos de prueba
    if (!dbUrl) {
      console.log('No database connection URL found. Returning mock data.');
      return res.json({
        status: 'ok',
        products: seedProducts.map((p, i) => ({ id: i + 1, ...p })),
        settings: { whatsapp_number: '', nequi_number: '', bancolombia_number: '' }
      });
    }

    const { rows: products } = await pool.query("SELECT * FROM pedidos_app_products WHERE status = 'Activo' ORDER BY id DESC");
    const { rows: categories } = await pool.query("SELECT * FROM pedidos_app_categories WHERE status = 'Activa' ORDER BY id ASC");

    // Asumimos que settings es solo una fila
    let settingsRow = { whatsapp_number: '', nequi_number: '', bancolombia_number: '' };
    try {
      const { rows: settings } = await pool.query('SELECT * FROM pedidos_app_settings LIMIT 1');
      if (settings.length > 0) settingsRow = settings[0];
    } catch (err) {
      console.log('Settings table might not exist yet.');
    }

    // Anuncio
    let announcementRow = null;
    try {
      const { rows: announcements } = await pool.query('SELECT * FROM pedidos_app_announcements ORDER BY id DESC LIMIT 1');
      if (announcements.length > 0) announcementRow = announcements[0];
    } catch (err) {
      console.log('Announcement table might not exist yet.');
    }

    res.json({
      status: 'ok',
      products,
      categories,
      settings: settingsRow,
      announcement: announcementRow
    });
  } catch (error) {
    console.error('Error fetching init data:', error);
    // Fallback a los datos de prueba si la tabla no existe (42P01)
    if (error.code === '42P01') {
      return res.json({
        status: 'ok',
        products: seedProducts.map((p, i) => ({ id: i + 1, ...p })),
        settings: { whatsapp_number: '', nequi_number: '', bancolombia_number: '' },
        message: 'Devolviendo datos locales. Por favor ejecuta el POST a /api/pedidos/setup para crear las tablas en Neon.'
      });
    }
    res.status(500).json({ status: 'error', message: 'Fallo al conectar con la base de datos', details: error.message });
  }
});

// Middleware / Helper
const isDateClosed = async (isoDate) => {
  if (!isoDate) return false;
  try {
    const d = isoDate.split('T')[0];
    const res = await pool.query("SELECT id FROM pedidos_app_closures WHERE start_date <= $1 AND end_date >= $2 AND status = 'Cerrado'", [d, d]);
    return res.rows.length > 0;
  } catch (e) { return false; }
};

app.post('/api/pedidos/checkout', async (req, res) => {
  try {
    const status = await getHorariosStatus();
    if (!status.isOpen && req.body.source !== 'Presencial' && req.body.source !== 'WhatsApp' && req.body.source !== 'Teléfono') {
      return res.status(403).json({ error: 'El restaurante se encuentra cerrado en este momento. ' + status.statusText });
    }

    const { customer, cart, total } = req.body;

    // Si no hay DB, retornar un ID falso para que el frontend siga
    if (!process.env.DATABASE_URL) {
      return res.json({ status: 'ok', order_id: Math.floor(Math.random() * 1000) });
    }

    let customDateStr = req.body.created_at || (customer && customer.created_at);
    let customDate = null;
    if (customDateStr) {
      if (customDateStr.length === 10) customDateStr += 'T12:00:00-05:00';
      customDate = new Date(customDateStr).toISOString();
    }

    if (customDate && await isDateClosed(customDate)) {
      return res.status(403).json({ error: 'El período contable para esta fecha ya está cerrado.' });
    }

    // Format phone to always start with 57
    let formattedPhone = customer.phone ? customer.phone.replace(/\D/g, '') : '';
    if (formattedPhone.length === 10) {
      formattedPhone = '57' + formattedPhone;
    } else if (formattedPhone.length > 10 && !formattedPhone.startsWith('57')) {
      formattedPhone = '57' + formattedPhone;
    }

    const { rows } = await pool.query(
      `INSERT INTO pedidos_app_orders 
       (customer_name, customer_phone, address, barrio, delivery_type, payment_method, total, cart_json, source, notes, voucher_reference, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, NOW())) 
       RETURNING id`,
      [
        customer.name,
        formattedPhone,
        customer.address || '',
        customer.barrio || '',
        customer.deliveryType,
        customer.paymentMethod,
        total,
        JSON.stringify(cart),
        req.body.source || customer.source || 'Web',
        customer.notes || '',
        customer.voucher_reference || '',
        customDate
      ]
    );

    res.json({ status: 'ok', order_id: rows[0].id });
  } catch (error) {
    console.error('Error guardando orden:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// AUTH MIDDLEWARE
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Acceso denegado' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido o expirado' });
    req.user = user;
    next();
  });
};

app.post('/api/pedidos/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Si no hay DB, mockear login para desarrollo local si la DB no está conectada
    if (!process.env.DATABASE_URL) {
      if (username === 'admin' && password === 'Distrito2026*') {
        const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        return res.json({ status: 'ok', token });
      }
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const { rows } = await pool.query('SELECT * FROM pedidos_app_users WHERE username = $1', [username]);

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }

    const user = rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ status: 'ok', token });

  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/pedidos/admin/verify', authenticateToken, (req, res) => {
  res.json({ status: 'ok', user: req.user });
});

// Obtener todas las categorías para el panel admin
app.get('/api/pedidos/admin/categories', authenticateToken, async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) {
      return res.json({ status: 'ok', categories: [] });
    }

    // Obtener categorías y contar productos relacionados
    const { rows } = await pool.query(`
      SELECT c.id, c.name, c.description, c.image, c.status, COUNT(p.id) as products
      FROM pedidos_app_categories c
      LEFT JOIN pedidos_app_products p ON c.name = p.category
      GROUP BY c.id
      ORDER BY c.id ASC
    `);

    res.json({ status: 'ok', categories: rows });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Crear categoría
app.post('/api/pedidos/admin/categories', authenticateToken, async (req, res) => {
  try {
    const { name, description, image, status } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO pedidos_app_categories (name, description, image, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, description, image, status || 'Activa']
    );
    res.json({ status: 'ok', category: rows[0] });
  } catch (error) {
    console.error('Error creating category:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Actualizar categoría
app.put('/api/pedidos/admin/categories/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, image, status } = req.body;
    const { rows } = await pool.query(
      'UPDATE pedidos_app_categories SET name = $1, description = $2, image = $3, status = $4 WHERE id = $5 RETURNING *',
      [name, description, image, status, id]
    );
    res.json({ status: 'ok', category: rows[0] });
  } catch (error) {
    console.error('Error updating category:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Eliminar categoría
app.delete('/api/pedidos/admin/categories/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM pedidos_app_categories WHERE id = $1', [id]);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error deleting category:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Obtener todas las ordenes para admin
app.get('/api/pedidos/admin/orders', authenticateToken, async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) return res.json({ status: 'ok', orders: [] });
    const { rows } = await pool.query('SELECT * FROM pedidos_app_orders ORDER BY created_at DESC');
    res.json({ status: 'ok', orders: rows });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Actualizar estado de orden
app.put('/api/pedidos/admin/orders/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) return res.status(400).json({ status: 'error', error: 'El estado es requerido' });

    const { rows } = await pool.query(
      'UPDATE pedidos_app_orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    res.json({ status: 'ok', order: rows[0] });
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Editar pedido completo (carrito, total, cliente)
app.put('/api/pedidos/admin/orders/:id/edit', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { cart, total, customer } = req.body;

    const cartStr = JSON.stringify(cart);
    let customDateStr = customer && customer.created_at;
    let customDate = null;
    if (customDateStr) {
      if (customDateStr.length === 10) customDateStr += 'T12:00:00-05:00';
      customDate = new Date(customDateStr).toISOString();
    }

    if (customDate && await isDateClosed(customDate)) {
      return res.status(403).json({ error: 'El período contable para esta fecha ya está cerrado.' });
    }

    // Format phone to always start with 57
    let formattedPhone = customer.phone ? customer.phone.replace(/\D/g, '') : '';
    if (formattedPhone.length === 10) {
      formattedPhone = '57' + formattedPhone;
    } else if (formattedPhone.length > 10 && !formattedPhone.startsWith('57')) {
      formattedPhone = '57' + formattedPhone;
    }

    const { rows } = await pool.query(
      `UPDATE pedidos_app_orders 
       SET cart_json = $1, total = $2, customer_name = $3, customer_phone = $4, address = $5, delivery_type = $6, payment_method = $7, barrio = $8, source = $9, created_at = COALESCE($10, created_at), notes = COALESCE($12, notes), voucher_reference = $13
       WHERE id = $11 RETURNING *`,
      [cartStr, total, customer.name, formattedPhone, customer.address, customer.deliveryType, customer.paymentMethod, customer.barrio || '', req.body.source || customer.source || 'Web', customDate, id, customer.notes || '', customer.voucher_reference || '']
    );
    res.json({ status: 'ok', order: rows[0] });
  } catch (error) {
    console.error('Error editing order:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Eliminar orden
app.delete('/api/pedidos/admin/orders/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM pedidos_app_orders WHERE id = $1', [id]);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// ================= PRODUCTOS =================
// Obtener todos los productos admin
app.get('/api/pedidos/admin/products', authenticateToken, async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) return res.json({ status: 'ok', products: [] });
    const { rows } = await pool.query('SELECT * FROM pedidos_app_products ORDER BY id DESC');
    res.json({ status: 'ok', products: rows });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Crear producto
app.post('/api/pedidos/admin/products', authenticateToken, async (req, res) => {
  try {
    const { title, description, price, category, image, status, is_featured, stock } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO pedidos_app_products (title, description, price, category, image, status, is_featured, stock) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [title, description, price, category, image, status || 'Activo', is_featured || false, stock || null]
    );
    res.json({ status: 'ok', product: rows[0] });
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Actualizar producto
app.put('/api/pedidos/admin/products/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, price, category, image, status, is_featured, stock } = req.body;
    const { rows } = await pool.query(
      'UPDATE pedidos_app_products SET title = $1, description = $2, price = $3, category = $4, image = $5, status = $6, is_featured = $7, stock = $8 WHERE id = $9 RETURNING *',
      [title, description, price, category, image, status, is_featured, stock, id]
    );
    res.json({ status: 'ok', product: rows[0] });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Eliminar producto
app.delete('/api/pedidos/admin/products/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM pedidos_app_products WHERE id = $1', [id]);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// ================= CONFIGURACION =================
app.get('/api/pedidos/admin/settings', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos_app_settings WHERE id = 1');
    if (rows.length === 0) {
      await pool.query('INSERT INTO pedidos_app_settings (id) VALUES (1)');
      const { rows: newRows } = await pool.query('SELECT * FROM pedidos_app_settings WHERE id = 1');
      return res.json({ status: 'ok', settings: newRows[0] });
    }
    res.json({ status: 'ok', settings: rows[0] });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.put('/api/pedidos/admin/settings', authenticateToken, async (req, res) => {
  try {
    const data = req.body;
    // Build dynamic UPDATE query
    const keys = Object.keys(data).filter(k => k !== 'id' && k !== 'updated_at');
    if (keys.length === 0) return res.json({ status: 'ok', message: 'No fields to update' });

    const setString = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = keys.map(k => data[k]);

    // Add updated_at manually if needed, or rely on schema default

    const query = `UPDATE pedidos_app_settings SET ${setString} WHERE id = 1 RETURNING *`;
    const { rows } = await pool.query(query, values);

    res.json({ status: 'ok', settings: rows[0] });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});


async function ensureRealInventorySchema(client) {
  await client.query(`
      CREATE TABLE IF NOT EXISTS pedidos_app_purchases (
        id SERIAL PRIMARY KEY,
        invoice_number VARCHAR(100),
        supplier VARCHAR(255),
        purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
        total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        iva_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS pedidos_app_purchase_items (
        id SERIAL PRIMARY KEY,
        purchase_id INTEGER NOT NULL REFERENCES pedidos_app_purchases(id) ON DELETE RESTRICT,
        inventory_id UUID NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE RESTRICT,
        quantity NUMERIC(14,4) NOT NULL,
        unit_cost NUMERIC(14,4) NOT NULL,
        total_cost NUMERIC(14,2) NOT NULL,
        iva_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        lot_code VARCHAR(100),
        expiration_date DATE
      );
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS sku VARCHAR(100);
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS purchase_unit VARCHAR(50);
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS consumption_unit VARCHAR(50);
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS conversion_factor NUMERIC(14,4) DEFAULT 1;
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS max_stock NUMERIC(14,4);
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Activo';
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS observations TEXT;
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS branch_id INTEGER DEFAULT 1;
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS unit VARCHAR(50);
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS image TEXT;
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'Ingrediente';
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS expiry_date DATE;
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS supplier VARCHAR(255);
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS min_stock NUMERIC(14,4) DEFAULT 0;
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS stock NUMERIC(14,4) DEFAULT 0;
      ALTER TABLE pedidos_app_inventory ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(14,4) DEFAULT 0;
      ALTER TABLE pedidos_app_purchase_items ADD COLUMN IF NOT EXISTS lot_code VARCHAR(100);
      ALTER TABLE pedidos_app_purchase_items ADD COLUMN IF NOT EXISTS expiration_date DATE;
  
      CREATE TABLE IF NOT EXISTS pedidos_app_inventory_lots (
        id BIGSERIAL PRIMARY KEY,
        inventory_id UUID NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE RESTRICT,
        purchase_item_id INTEGER,
        branch_id INTEGER NOT NULL DEFAULT 1,
        lot_code VARCHAR(100) NOT NULL,
        source_quantity NUMERIC(14,4) NOT NULL,
        source_unit VARCHAR(50),
        initial_quantity NUMERIC(14,4) NOT NULL CHECK (initial_quantity > 0),
        available_quantity NUMERIC(14,4) NOT NULL CHECK (available_quantity >= 0),
        unit_cost NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
        expiration_date DATE,
        status VARCHAR(20) NOT NULL DEFAULT 'Disponible',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (branch_id, lot_code)
      );
  
      CREATE TABLE IF NOT EXISTS pedidos_app_inventory_movements (
        id BIGSERIAL PRIMARY KEY,
        inventory_id UUID NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE RESTRICT,
        lot_id BIGINT REFERENCES pedidos_app_inventory_lots(id) ON DELETE RESTRICT,
        branch_id INTEGER NOT NULL DEFAULT 1,
        movement_type VARCHAR(30) NOT NULL,
        quantity NUMERIC(14,4) NOT NULL,
        unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
        balance_after NUMERIC(14,4),
        reference_type VARCHAR(30),
        reference_id VARCHAR(100),
        notes TEXT,
        created_by VARCHAR(100) DEFAULT 'Administrador',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        whatsapp_number VARCHAR(50),
        nequi_number VARCHAR(50),
        bancolombia_number VARCHAR(50)
      );
    `);
}

app.post('/api/pedidos/setup', async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) return res.status(400).json({ error: 'No hay DATABASE_URL en el archivo .env' });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_app_products (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        price INTEGER NOT NULL,
        category VARCHAR(100),
        image TEXT
      );
      
      ALTER TABLE pedidos_app_products ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Activo';
      ALTER TABLE pedidos_app_products ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT false;
      ALTER TABLE pedidos_app_products ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT NULL;
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        whatsapp_number VARCHAR(50),
        nequi_number VARCHAR(50),
        bancolombia_number VARCHAR(50)
      );
      CREATE TABLE IF NOT EXISTS pedidos_app_orders (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(255),
        customer_phone VARCHAR(50),
        address TEXT,
        barrio VARCHAR(255),
        delivery_type VARCHAR(50),
        payment_method VARCHAR(50),
        total INTEGER,
        cart_json JSONB,
        status VARCHAR(50) DEFAULT 'Nuevo',
        source VARCHAR(50) DEFAULT 'Web',
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      );
      
      ALTER TABLE pedidos_app_orders ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Nuevo';
      ALTER TABLE pedidos_app_orders ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'Web';
      ALTER TABLE pedidos_app_orders ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE pedidos_app_orders ADD COLUMN IF NOT EXISTS voucher_reference VARCHAR(255);
      ALTER TABLE pedidos_app_purchases ADD COLUMN IF NOT EXISTS iva_amount INTEGER DEFAULT 0;
      ALTER TABLE pedidos_app_purchase_items ADD COLUMN IF NOT EXISTS iva_amount INTEGER DEFAULT 0;

      CREATE TABLE IF NOT EXISTS pedidos_app_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT NOW()
      );
        CREATE TABLE IF NOT EXISTS pedidos_app_categories (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) UNIQUE NOT NULL,
          description TEXT,
          image TEXT,
          status VARCHAR(20) DEFAULT 'Activa',
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS pedidos_app_customers (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255),
          phone VARCHAR(50) UNIQUE NOT NULL,
          avatar_url TEXT,
          total_orders INTEGER DEFAULT 0,
          total_spent INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS pedidos_app_push_subscriptions (
          id SERIAL PRIMARY KEY,
          endpoint TEXT UNIQUE NOT NULL,
          subscription_json JSON NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS pedidos_app_expenses (
          id SERIAL PRIMARY KEY,
          category VARCHAR(100),
          description TEXT,
          amount INTEGER,
          expense_date DATE,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS pedidos_app_closures (
          id SERIAL PRIMARY KEY,
          start_date DATE NOT NULL,
          end_date DATE NOT NULL,
          status VARCHAR(20) DEFAULT 'Cerrado',
          total_sales INTEGER DEFAULT 0,
          total_costs INTEGER DEFAULT 0,
          total_expenses INTEGER DEFAULT 0,
          net_profit INTEGER DEFAULT 0,
          summary_json JSONB,
          closed_by VARCHAR(100),
          closed_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS pedidos_app_inventory (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) UNIQUE NOT NULL,
          category VARCHAR(100) DEFAULT 'General',
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS pedidos_app_rendimientos (
          id SERIAL PRIMARY KEY,
          ingrediente_id INTEGER REFERENCES pedidos_app_inventory(id) ON DELETE CASCADE,
          ingrediente_name VARCHAR(255),
          unidad_compra VARCHAR(50),
          cantidad_comprada NUMERIC(10, 2),
          costo_compra INTEGER,
          unidad_consumo VARCHAR(50),
          conversion_definida NUMERIC(10, 2),
          rendimiento_obtenido NUMERIC(10, 2),
          costo_por_unidad NUMERIC(10, 2),
          estado VARCHAR(20) DEFAULT 'Activo',
          created_by VARCHAR(100),
          created_at TIMESTAMP DEFAULT NOW()
        );
        ALTER TABLE pedidos_app_rendimientos ADD COLUMN IF NOT EXISTS conversion_definida NUMERIC(10, 2);
        ALTER TABLE pedidos_app_rendimientos ADD COLUMN IF NOT EXISTS created_by VARCHAR(100);
        CREATE TABLE IF NOT EXISTS pedidos_app_recipes (
          id SERIAL PRIMARY KEY,
          product_id INTEGER REFERENCES pedidos_app_products(id) ON DELETE CASCADE,
          rendimiento_id INTEGER REFERENCES pedidos_app_rendimientos(id) ON DELETE CASCADE,
          cantidad_usada NUMERIC(10, 2),
          costo_calculado NUMERIC(10, 2),
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS pedidos_app_horarios (
          id SERIAL PRIMARY KEY,
          day_of_week VARCHAR(20) UNIQUE NOT NULL,
          is_active BOOLEAN DEFAULT true,
          open_time VARCHAR(10) DEFAULT '18:00',
          close_time VARCHAR(10) DEFAULT '22:00'
        );
        CREATE TABLE IF NOT EXISTS pedidos_app_horarios_config (
          id SERIAL PRIMARY KEY,
          pre_open_minutes INTEGER DEFAULT 30,
          auto_close_minutes INTEGER DEFAULT 15,
          prep_time_minutes INTEGER DEFAULT 30,
          timezone VARCHAR(50) DEFAULT 'America/Bogota'
        );
        CREATE TABLE IF NOT EXISTS pedidos_app_horarios_exceptions (
          id SERIAL PRIMARY KEY,
          exception_date DATE UNIQUE NOT NULL,
          description VARCHAR(255),
          is_closed BOOLEAN DEFAULT true,
          open_time VARCHAR(10),
          close_time VARCHAR(10),
          created_at TIMESTAMP DEFAULT NOW()
        );
    `);

    await ensureRealInventorySchema(pool);

    // Seed Horarios if empty
    const { rows: horariosCount } = await pool.query('SELECT COUNT(*) FROM pedidos_app_horarios');
    if (parseInt(horariosCount[0].count) === 0) {
      const days = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
      for (const day of days) {
        await pool.query('INSERT INTO pedidos_app_horarios (day_of_week) VALUES ($1)', [day]);
      }
    }

    // Seed Horarios Config if empty
    const { rows: configCount } = await pool.query('SELECT COUNT(*) FROM pedidos_app_horarios_config');
    if (parseInt(configCount[0].count) === 0) {
      await pool.query('INSERT INTO pedidos_app_horarios_config DEFAULT VALUES');
    }

    // Insertar usuario por defecto si no hay
    const { rows: userCount } = await pool.query('SELECT COUNT(*) FROM pedidos_app_users');
    if (parseInt(userCount[0].count) === 0) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash('Distrito2026*', salt);
      await pool.query('INSERT INTO pedidos_app_users (username, password_hash, role) VALUES ($1, $2, $3)', ['admin', hashedPassword, 'admin']);
      console.log('Usuario admin creado por defecto.');
    }

    // Solo insertar si esta vacía
    const { rows: count } = await pool.query('SELECT COUNT(*) FROM pedidos_app_products');
    if (parseInt(count[0].count) === 0) {
      for (const p of seedProducts) {
        await pool.query(
          'INSERT INTO pedidos_app_products (title, description, price, category, image) VALUES ($1, $2, $3, $4, $5)',
          [p.title, p.description, p.price, p.category, p.image]
        );
      }
    }

    res.json({ status: 'ok', message: 'Tablas creadas e inicializadas exitosamente en Neon!' });
  } catch (error) {
    console.error('Error de setup:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});
// ================= INVENTARIO =================

app.get('/api/pedidos/admin/inventory', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT i.*, COALESCE(SUM(l.available_quantity), 0) AS stock,
        COALESCE(SUM(l.available_quantity * l.unit_cost) / NULLIF(SUM(l.available_quantity), 0), 0) AS unit_cost,
        MAX(m.created_at) AS last_movement_at
      FROM pedidos_app_inventory i
      LEFT JOIN pedidos_app_inventory_lots l ON l.inventory_id = i.id AND l.branch_id = 1 AND l.status = 'Disponible'
      LEFT JOIN pedidos_app_inventory_movements m ON m.inventory_id = i.id
      GROUP BY i.id ORDER BY i.name ASC
    `);
    res.json({ status: 'ok', items: rows });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.post('/api/pedidos/admin/inventory', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { image, name, type, category, unit, min_stock, purchase_unit, consumption_unit,
      conversion_factor, max_stock, status, observations } = req.body;
    if (!name?.trim()) return res.status(400).json({ status: 'error', error: 'El nombre es requerido' });
    await client.query('BEGIN');
    await ensureRealInventorySchema(client);
    const automaticSku = await generateIngredientSku(client, category);
    const { rows } = await client.query(
      `INSERT INTO pedidos_app_inventory
       (image, name, type, category, unit, min_stock, sku, purchase_unit, consumption_unit, conversion_factor, max_stock, status, observations)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [image || null, name.trim(), type || 'Ingrediente', category || 'General', consumption_unit || unit || 'Unidad',
      Number(min_stock) || 0, automaticSku, purchase_unit || unit || 'Unidad', consumption_unit || unit || 'Unidad',
      Number(conversion_factor) || 1, max_stock || null, status || 'Activo', observations || null]
    );
    await client.query('COMMIT');
    res.json({ status: 'ok', item: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ status: 'error', error: error.message });
  } finally {
    client.release();
  }
});

app.put('/api/pedidos/admin/inventory/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { image, name, type, category, unit, min_stock, sku, purchase_unit, consumption_unit,
      conversion_factor, max_stock, status, observations } = req.body;
    const { rows } = await pool.query(
      `UPDATE pedidos_app_inventory 
       SET image=$1, name=$2, type=$3, category=$4, unit=$5, min_stock=$6, sku=COALESCE(sku, $7), purchase_unit=$8,
           consumption_unit=$9, conversion_factor=$10, max_stock=$11, status=$12, observations=$13, updated_at=NOW()
       WHERE id=$14 RETURNING *`,
      [image || null, name, type || 'Ingrediente', category || 'General', consumption_unit || unit || 'Unidad', Number(min_stock) || 0,
      sku || null, purchase_unit || unit || 'Unidad', consumption_unit || unit || 'Unidad', Number(conversion_factor) || 1,
      max_stock || null, status || 'Activo', observations || null, id]
    );
    res.json({ status: 'ok', item: rows[0] });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.delete('/api/pedidos/admin/inventory/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM pedidos_app_inventory WHERE id = $1', [id]);
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.post('/api/pedidos/admin/inventory/:id/movement', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { movement_type, quantity, notes, unit_cost } = req.body;
    const numericQuantity = Number(quantity);
    if (!['IN', 'OUT'].includes(movement_type) || !Number.isFinite(numericQuantity) || numericQuantity <= 0) {
      return res.status(400).json({ status: 'error', error: 'Solo se permiten ajustes positivos o negativos con una cantidad mayor a cero.' });
    }

    // Iniciar transacción
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await ensureRealInventorySchema(client);
      const { rows: ingredients } = await client.query('SELECT * FROM pedidos_app_inventory WHERE id = $1 FOR UPDATE', [id]);
      if (!ingredients.length) throw new Error('Ingrediente no encontrado.');
      if (movement_type === 'IN') {
        const cost = Number(unit_cost || ingredients[0].unit_cost || 0);
        const lotCode = `AJU-${id}-${Date.now()}`;
        const { rows: lots } = await client.query(
          `INSERT INTO pedidos_app_inventory_lots
           (inventory_id, lot_code, source_quantity, source_unit, initial_quantity, available_quantity, unit_cost)
           VALUES ($1,$2,$3,$4,$3,$3,$5) RETURNING *`,
          [id, lotCode, numericQuantity, ingredients[0].consumption_unit || ingredients[0].unit, cost]
        );
        await createInventoryMovement(client, {
          inventoryId: id, lotId: lots[0].id, type: 'Ajuste positivo', quantity: numericQuantity,
          unitCost: cost, balanceAfter: numericQuantity, referenceType: 'Ajuste', notes, createdBy: req.user?.username
        });
      } else {
        let pending = numericQuantity;
        const { rows: lots } = await client.query(`
          SELECT * FROM pedidos_app_inventory_lots WHERE inventory_id = $1 AND branch_id = 1
          AND status = 'Disponible' AND available_quantity > 0 ORDER BY created_at, id FOR UPDATE`, [id]);
        for (const lot of lots) {
          if (pending <= 0) break;
          const used = Math.min(pending, Number(lot.available_quantity));
          const balance = Number(lot.available_quantity) - used;
          await client.query('UPDATE pedidos_app_inventory_lots SET available_quantity = $1, status = CASE WHEN $1 = 0 THEN \'Agotado\' ELSE \'Disponible\' END WHERE id = $2', [balance, lot.id]);
          await createInventoryMovement(client, {
            inventoryId: id, lotId: lot.id, type: 'Ajuste negativo', quantity: -used,
            unitCost: lot.unit_cost, balanceAfter: balance, referenceType: 'Ajuste', notes, createdBy: req.user?.username
          });
          pending -= used;
        }
        if (pending > 0) { const error = new Error('No hay existencia suficiente para el ajuste.'); error.statusCode = 409; throw error; }
      }

      await client.query('COMMIT');
      res.json({ status: 'ok' });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(error.statusCode || 500).json({ status: 'error', error: error.message });
  }
});

app.get('/api/pedidos/admin/inventory/:id/movements', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query('SELECT * FROM pedidos_app_inventory_movements WHERE inventory_id = $1 ORDER BY created_at DESC', [id]);
    res.json({ status: 'ok', movements: rows });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});
// ================= COMPRAS =================
app.get('/api/pedidos/admin/purchases', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos_app_purchases ORDER BY created_at DESC');
    res.json({ status: 'ok', purchases: rows });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.post('/api/pedidos/admin/purchases', authenticateToken, async (req, res) => {
  const { invoice_number, supplier, purchase_date, total_amount, iva_amount, notes, items } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await ensureRealInventorySchema(client);

    // 1. Crear compra
    const { rows: purchaseRows } = await client.query(
      `INSERT INTO pedidos_app_purchases (invoice_number, supplier, purchase_date, total_amount, iva_amount, notes) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [invoice_number, supplier, purchase_date || new Date(), total_amount, iva_amount || 0, notes]
    );
    const purchase = purchaseRows[0];

    // 2. Procesar ítems
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (!item.inventory_id || Number(item.quantity) <= 0 || Number(item.total_cost) < 0) {
        const error = new Error('Cada compra debe tener ingrediente, cantidad y costo válidos.');
        error.statusCode = 400;
        throw error;
      }
      const { rows: ingredients } = await client.query(
        'SELECT id, purchase_unit, consumption_unit, conversion_factor FROM pedidos_app_inventory WHERE id = $1 FOR UPDATE',
        [item.inventory_id]
      );
      if (!ingredients.length) throw new Error(`Ingrediente #${item.inventory_id} no encontrado.`);
      const ingredient = ingredients[0];
      const factor = Number(item.conversion_factor || ingredient.conversion_factor || 1);
      const usableQuantity = Number(item.usable_quantity || (Number(item.quantity) * factor));
      if (!Number.isFinite(usableQuantity) || usableQuantity <= 0) throw new Error('El rendimiento útil debe ser mayor a cero.');
      const totalWithTax = Number(item.total_cost) * (1 + Number(item.iva_amount || 0) / 100);
      const unitCost = totalWithTax / usableQuantity;
      const lotCode = item.lot_code || `${String(ingredient.sku || 'LOT').replace(/\s+/g, '-').toUpperCase()}-${String(purchase.purchase_date).replace(/-/g, '')}-${String(index + 1).padStart(3, '0')}`;
      // Registrar detalle de compra
      const { rows: purchaseItemRows } = await client.query(
        `INSERT INTO pedidos_app_purchase_items (purchase_id, inventory_id, quantity, unit_cost, total_cost, iva_amount, lot_code, expiration_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [purchase.id, item.inventory_id, item.quantity, item.unit_cost, item.total_cost, item.iva_amount || 0, lotCode, item.expiration_date || null]
      );
      const purchaseItemId = purchaseItemRows[0]?.id;
      const { rows: lotRows } = await client.query(
        `INSERT INTO pedidos_app_inventory_lots
           (inventory_id, purchase_item_id, lot_code, source_quantity, source_unit, initial_quantity, available_quantity, unit_cost, expiration_date)
           VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8) RETURNING *`,
        [item.inventory_id, purchaseItemId || null, lotCode, item.quantity, ingredient.purchase_unit || item.unit,
          usableQuantity, unitCost, item.expiration_date || null]
      );
      await createInventoryMovement(client, {
        inventoryId: item.inventory_id, lotId: lotRows[0].id, type: 'Compra', quantity: usableQuantity,
        unitCost, balanceAfter: usableQuantity, referenceType: 'Compra', referenceId: purchase.id,
        notes: `Compra: ${invoice_number || 'S/N'} · Lote ${lotCode}`, createdBy: req.user?.username
      });
    }

    await client.query('COMMIT');
    res.json({ status: 'ok', purchase });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.statusCode || 500).json({ status: 'error', error: error.message });
  } finally {
    client.release();
  }
});

app.get('/api/pedidos/admin/purchases/:id/items', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT pi.*, i.name, i.unit 
       FROM pedidos_app_purchase_items pi
       JOIN pedidos_app_inventory i ON pi.inventory_id = i.id
       WHERE pi.purchase_id = $1`,
      [id]
    );
    res.json({ status: 'ok', items: rows });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.put('/api/pedidos/admin/purchases/:id', authenticateToken, async (req, res) => {
  return res.status(409).json({
    status: 'error',
    error: 'Las compras contabilizadas no se editan. Registra un ajuste o una compra de corrección para conservar el Kardex.'
  });
  /* Historial anterior: se conserva temporalmente como referencia, pero no se ejecuta.
  const { id } = req.params;
  const { invoice_number, supplier, purchase_date, total_amount, iva_amount, notes, items } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 1. Obtener ítems antiguos para revertir stock
    const { rows: oldItems } = await client.query('SELECT inventory_id, quantity FROM pedidos_app_purchase_items WHERE purchase_id = $1', [id]);
    for (const old of oldItems) {
      await client.query(
        `UPDATE pedidos_app_inventory SET stock = stock - $1, updated_at = NOW() WHERE id = $2`,
        [old.quantity, old.inventory_id]
      );
    }
    
    // 2. Eliminar ítems antiguos
    await client.query('DELETE FROM pedidos_app_purchase_items WHERE purchase_id = $1', [id]);
    
    // 3. Actualizar datos de compra
    await client.query(
      `UPDATE pedidos_app_purchases 
       SET invoice_number = $1, supplier = $2, purchase_date = $3, total_amount = $4, iva_amount = $5, notes = $6
       WHERE id = $7`,
      [invoice_number, supplier, purchase_date, total_amount, iva_amount || 0, notes, id]
    );
    
    // 4. Insertar ítems nuevos y actualizar stock
      for (const item of items) {
        await client.query(
          `INSERT INTO pedidos_app_purchase_items (purchase_id, inventory_id, quantity, unit_cost, total_cost, iva_amount)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, item.inventory_id, item.quantity, item.unit_cost, item.total_cost, item.iva_amount || 0]
        );
        
        await client.query(
        `UPDATE pedidos_app_inventory 
         SET stock = stock + $1, unit_cost = $2, updated_at = NOW() 
         WHERE id = $3`,
        [item.quantity, item.unit_cost, item.inventory_id]
      );

      await client.query(
        `INSERT INTO pedidos_app_inventory_movements (inventory_id, movement_type, quantity, notes) 
         VALUES ($1, 'In', $2, $3)`,
        [item.inventory_id, item.quantity, `Edición Compra: ${invoice_number || 'S/N'}`]
      );
    }
    
    await client.query('COMMIT');
    res.json({ status: 'ok' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ status: 'error', error: error.message });
  } finally {
    client.release();
  }
  */
});

// --- MÓDULO DE CALIFICACIONES ---
app.post('/api/pedidos/rate', async (req, res) => {
  const { product_id, rating } = req.body;
  if (!product_id || !rating || rating < 1 || rating > 5) {
    return res.status(400).json({ status: 'error', error: 'Calificación inválida' });
  }

  try {
    const result = await pool.query(
      `UPDATE pedidos_app_products 
       SET rating_sum = rating_sum + $1, rating_count = rating_count + 1 
       WHERE id = $2 RETURNING *`,
      [rating, product_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', error: 'Producto no encontrado' });
    }

    res.json({ status: 'ok', product: result.rows[0] });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// --- MÓDULO DE ANUNCIOS Y PUSH ---
app.post('/api/pedidos/push/subscribe', async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Suscripción inválida' });
    }
    await pool.query(
      `INSERT INTO pedidos_app_push_subscriptions (endpoint, subscription_json)
       VALUES ($1, $2)
       ON CONFLICT (endpoint) DO UPDATE SET subscription_json = $2`,
      [subscription.endpoint, JSON.stringify(subscription)]
    );
    res.status(201).json({ status: 'ok' });
  } catch (err) {
    console.error('Error guardando suscripción:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pedidos/admin/push/send', authenticateToken, async (req, res) => {
  try {
    const { title, message, url } = req.body;
    const { rows } = await pool.query('SELECT subscription_json FROM pedidos_app_push_subscriptions');

    const payload = JSON.stringify({ title, body: message, url: url || '/' });

    const promises = rows.map(async (row) => {
      const sub = typeof row.subscription_json === 'string' ? JSON.parse(row.subscription_json) : row.subscription_json;
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query('DELETE FROM pedidos_app_push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
        }
      }
    });

    await Promise.all(promises);
    res.json({ status: 'ok', sent: rows.length });
  } catch (err) {
    console.error('Error enviando push:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pedidos/announcement', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos_app_announcements ORDER BY id DESC LIMIT 1');
    if (rows.length > 0) {
      res.json({ status: 'ok', announcement: rows[0] });
    } else {
      res.json({ status: 'ok', announcement: null });
    }
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.put('/api/pedidos/admin/announcement', authenticateToken, async (req, res) => {
  const { title, image_url, is_active } = req.body;
  try {
    const { rows } = await pool.query('SELECT id FROM pedidos_app_announcements LIMIT 1');
    if (rows.length > 0) {
      const id = rows[0].id;
      const updated = await pool.query(
        'UPDATE pedidos_app_announcements SET title = $1, image_url = $2, is_active = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
        [title, image_url, is_active, id]
      );
      res.json({ status: 'ok', announcement: updated.rows[0] });
    } else {
      const inserted = await pool.query(
        'INSERT INTO pedidos_app_announcements (title, image_url, is_active) VALUES ($1, $2, $3) RETURNING *',
        [title, image_url, is_active]
      );
      res.json({ status: 'ok', announcement: inserted.rows[0] });
    }
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// ================= RENDIMIENTOS & INVENTARIO =================
app.get('/api/pedidos/admin/inventory/basic', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos_app_inventory ORDER BY name ASC');
    res.json({ status: 'ok', data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pedidos/admin/inventory/basic', authenticateToken, async (req, res) => {
  try {
    const { name, category } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO pedidos_app_inventory (name, category) VALUES ($1, $2) RETURNING *',
      [name, category || 'General']
    );
    res.json({ status: 'ok', data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= RECETAS =================
app.get('/api/pedidos/admin/recipes', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.product_id, SUM(r.costo_calculado) as total_cost
      FROM pedidos_app_recipes r
      GROUP BY r.product_id
    `);
    res.json({ status: 'ok', data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pedidos/admin/recipes/:productId', authenticateToken, async (req, res) => {
  try {
    const { productId } = req.params;
    const { rows } = await pool.query(`
      SELECT r.id, r.product_id, r.cantidad_usada, r.costo_calculado, 
             ren.ingrediente_name, ren.unidad_consumo, ren.costo_por_unidad 
      FROM pedidos_app_recipes r
      JOIN pedidos_app_rendimientos ren ON r.rendimiento_id = ren.id
      WHERE r.product_id = $1
      ORDER BY r.id ASC
    `, [productId]);
    res.json({ status: 'ok', data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pedidos/admin/recipes', authenticateToken, async (req, res) => {
  try {
    const { product_id, rendimiento_id, cantidad_usada } = req.body;

    // Obtener costo por unidad del rendimiento
    const renRes = await pool.query('SELECT costo_por_unidad FROM pedidos_app_rendimientos WHERE id = $1', [rendimiento_id]);
    if (renRes.rowCount === 0) return res.status(404).json({ error: 'Rendimiento no encontrado' });

    const costo_por_unidad = Number(renRes.rows[0].costo_por_unidad);
    const costo_calculado = costo_por_unidad * Number(cantidad_usada);

    const { rows } = await pool.query(
      `INSERT INTO pedidos_app_recipes (product_id, rendimiento_id, cantidad_usada, costo_calculado) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [product_id, rendimiento_id, cantidad_usada, costo_calculado]
    );
    res.json({ status: 'ok', data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/pedidos/admin/recipes/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM pedidos_app_recipes WHERE id = $1', [id]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pedidos/admin/rendimientos', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos_app_rendimientos ORDER BY id DESC');
    res.json({ status: 'ok', data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pedidos/admin/rendimientos', authenticateToken, async (req, res) => {
  try {
    const { ingrediente_id, ingrediente_name, unidad_compra, cantidad_comprada, costo_compra, unidad_consumo, conversion_definida } = req.body;

    // Automatic yield calculation based on conversion rule
    const rendimiento_obtenido = Number(cantidad_comprada) * Number(conversion_definida);
    const costo_por_unidad = Number(costo_compra) / rendimiento_obtenido;
    const created_by = 'Administrador'; // Default since user auth roles aren't strictly complex yet

    const { rows } = await pool.query(
      `INSERT INTO pedidos_app_rendimientos 
      (ingrediente_id, ingrediente_name, unidad_compra, cantidad_comprada, costo_compra, unidad_consumo, conversion_definida, rendimiento_obtenido, costo_por_unidad, created_by) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [ingrediente_id, ingrediente_name, unidad_compra, cantidad_comprada, costo_compra, unidad_consumo, conversion_definida, rendimiento_obtenido, costo_por_unidad, created_by]
    );
    res.json({ status: 'ok', data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/pedidos/admin/rendimientos/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM pedidos_app_rendimientos WHERE id = $1', [req.params.id]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= REPORTES =================
app.get('/api/pedidos/admin/reports', authenticateToken, async (req, res) => {
  try {
    // Buscar el último cierre contable
    const closureRes = await pool.query("SELECT MAX(end_date) as last_closure FROM pedidos_app_closures WHERE status = 'Cerrado'");
    const lastClosure = closureRes.rows[0]?.last_closure;

    let ordersQuery = "SELECT * FROM pedidos_app_orders WHERE (status = 'Completado' OR status = 'Entregado')";
    let params = [];
    if (lastClosure) {
      ordersQuery += " AND DATE(created_at) > $1";
      params.push(lastClosure);
    }

    const { rows: orders } = await pool.query(ordersQuery, params);

    // Purchases also filtered
    let purchasesQuery = "SELECT total_amount FROM pedidos_app_purchases";
    let pParams = [];
    if (lastClosure) {
      purchasesQuery += " WHERE DATE(purchase_date) > $1";
      pParams.push(lastClosure);
    }
    const { rows: purchases } = await pool.query(purchasesQuery, pParams);

    let totalVentas = 0;
    let pedidosCount = orders.length;
    let clientesUnicos = new Set();
    let ventasPorFecha = {};
    let ventasPorCategoria = {};
    let ventasPorMetodo = {};
    let ventasPorProducto = {};
    let topClientes = {};

    orders.forEach(order => {
      totalVentas += order.total || 0;
      const name = (order.customer_name || 'Cliente sin nombre').trim();
      const phone = (order.customer_phone || '').trim();
      const clientKey = `${name.toLowerCase()}-${phone}`;

      clientesUnicos.add(clientKey);

      if (!topClientes[clientKey]) {
        topClientes[clientKey] = { name: name, phone: phone, total: 0, count: 0, products: {}, orderHistory: [] };
      }
      topClientes[clientKey].total += order.total || 0;
      topClientes[clientKey].count += 1;
      topClientes[clientKey].orderHistory.push({
        date: order.created_at,
        total: order.total || 0,
        cart: order.cart_json || []
      });

      const dateStr = new Date(order.created_at).toLocaleDateString();
      ventasPorFecha[dateStr] = (ventasPorFecha[dateStr] || 0) + (order.total || 0);

      const method = order.payment_method || 'Otro';
      ventasPorMetodo[method] = (ventasPorMetodo[method] || 0) + (order.total || 0);

      if (order.cart_json) {
        order.cart_json.forEach(item => {
          const cat = item.category || 'Otros';
          const qty = item.qty || item.quantity || 1;
          const itemTotal = item.price * qty;
          ventasPorCategoria[cat] = (ventasPorCategoria[cat] || 0) + itemTotal;

          if (!ventasPorProducto[item.title]) ventasPorProducto[item.title] = { name: item.title, category: cat, quantity: 0, total: 0 };
          ventasPorProducto[item.title].quantity += qty;
          ventasPorProducto[item.title].total += itemTotal;

          // Track for customer favorite
          if (!topClientes[clientKey].products[item.title]) {
            topClientes[clientKey].products[item.title] = 0;
          }
          topClientes[clientKey].products[item.title] += qty;
        });
      }
    });

    const totalCompras = purchases.reduce((sum, p) => sum + (p.total_amount || 0), 0);
    const utilidadBruta = totalVentas - totalCompras;
    const ticketPromedio = pedidosCount > 0 ? totalVentas / pedidosCount : 0;

    const chartVentas = Object.keys(ventasPorFecha).map(date => ({ date, ventas: ventasPorFecha[date] }));
    const chartCategorias = Object.keys(ventasPorCategoria).map(name => ({ name, value: ventasPorCategoria[name] }));
    const chartPagos = Object.keys(ventasPorMetodo).map(name => ({ name, value: ventasPorMetodo[name] }));
    const listProductos = Object.values(ventasPorProducto).sort((a, b) => b.total - a.total).slice(0, 5);
    const listClientes = Object.values(topClientes).map(client => {
      let favorite = "Ninguno";
      let maxQty = 0;
      for (const [prodName, qty] of Object.entries(client.products)) {
        if (qty > maxQty) {
          maxQty = qty;
          favorite = prodName;
        }
      }
      client.favoriteProduct = favorite;
      return client;
    }).sort((a, b) => b.total - a.total).slice(0, 5);

    res.json({
      status: 'ok',
      kpis: {
        totalVentas,
        pedidosRealizados: pedidosCount,
        clientesAtendidos: clientesUnicos.size,
        ticketPromedio: Math.round(ticketPromedio),
        utilidadBruta,
        totalCompras
      },
      charts: {
        ventas: chartVentas,
        categorias: chartCategorias,
        pagos: chartPagos
      },
      lists: {
        productos: listProductos,
        clientes: listClientes
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// ================= GASTOS =================
app.get('/api/pedidos/admin/expenses', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos_app_expenses ORDER BY expense_date DESC, id DESC');
    res.json({ status: 'ok', data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pedidos/admin/expenses', authenticateToken, async (req, res) => {
  try {
    const { category, description, amount, expense_date } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO pedidos_app_expenses (category, description, amount, expense_date) 
       VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE)) RETURNING *`,
      [category, description, amount, expense_date || null]
    );
    res.json({ status: 'ok', data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/pedidos/admin/expenses/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM pedidos_app_expenses WHERE id = $1', [id]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= CIERRES CONTABLES =================
app.get('/api/pedidos/admin/closures/preview', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'Faltan fechas' });

    // 1. Pedidos (Ventas, Métodos de Pago, Categorías)
    const ordersRes = await pool.query(
      `SELECT * FROM pedidos_app_orders 
       WHERE DATE(created_at) >= $1 AND DATE(created_at) <= $2 
       AND status IN ('Entregado', 'Listo', 'Completado')`,
      [startDate, endDate]
    );
    const orders = ordersRes.rows;

    let totalVentas = 0;
    let totalPedidos = orders.length;
    let metodosPago = {};
    let productosVendidos = {}; // productId -> quantity
    let categoriasVentas = {};

    orders.forEach(o => {
      totalVentas += Number(o.total || 0);

      const pm = o.payment_method || 'efectivo';
      metodosPago[pm] = (metodosPago[pm] || 0) + Number(o.total || 0);

      const cart = o.cart_json || [];
      cart.forEach(item => {
        productosVendidos[item.id] = (productosVendidos[item.id] || 0) + (item.quantity || 1);
        const cat = item.category || 'General';
        categoriasVentas[cat] = (categoriasVentas[cat] || 0) + (Number(item.price || 0) * (item.quantity || 1));
      });
    });

    // 2. Costos de Producción (Basado en recetas de productos vendidos)
    let totalCostoProduccion = 0;
    let desgloseCostos = {}; // Ingrediente -> Costo

    // Traer todas las recetas
    const recipesRes = await pool.query(`
      SELECT r.product_id, r.cantidad_usada, r.costo_calculado, ren.ingrediente_name 
      FROM pedidos_app_recipes r
      JOIN pedidos_app_rendimientos ren ON r.rendimiento_id = ren.id
    `);

    recipesRes.rows.forEach(recipe => {
      const qSold = productosVendidos[recipe.product_id] || 0;
      if (qSold > 0) {
        const costForThisIngredient = Number(recipe.costo_calculado) * qSold;
        totalCostoProduccion += costForThisIngredient;
        desgloseCostos[recipe.ingrediente_name] = (desgloseCostos[recipe.ingrediente_name] || 0) + costForThisIngredient;
      }
    });

    // 3. Gastos
    const expensesRes = await pool.query(
      `SELECT * FROM pedidos_app_expenses 
       WHERE expense_date >= $1 AND expense_date <= $2`,
      [startDate, endDate]
    );
    let totalGastos = 0;
    let desgloseGastos = {};
    expensesRes.rows.forEach(e => {
      totalGastos += Number(e.amount);
      desgloseGastos[e.category] = (desgloseGastos[e.category] || 0) + Number(e.amount);
    });

    const invRes = await pool.query(`
      SELECT i.name AS ingrediente_name, i.unit AS unidad_consumo,
        COALESCE(SUM(l.available_quantity), 0) AS cantidad,
        COALESCE(SUM(l.available_quantity * l.unit_cost), 0) AS valor
      FROM pedidos_app_inventory i
      LEFT JOIN pedidos_app_inventory_lots l ON l.inventory_id = i.id AND l.branch_id = 1 AND l.status = 'Disponible'
      GROUP BY i.id, i.name, i.unit
    `);
    const inventarioSnapshot = invRes.rows.map(r => ({
      name: r.ingrediente_name,
      unit: r.unidad_consumo,
      quantity: Number(r.cantidad),
      value: Number(r.valor)
    }));

    const utilidadNeta = totalVentas - totalCostoProduccion - totalGastos;

    res.json({
      status: 'ok',
      data: {
        totalVentas,
        totalPedidos,
        totalCostoProduccion,
        totalGastos,
        utilidadNeta,
        metodosPago,
        categoriasVentas,
        desgloseCostos,
        desgloseGastos,
        inventarioSnapshot
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pedidos/admin/closures', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate, summary, closedBy } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO pedidos_app_closures 
       (start_date, end_date, total_sales, total_costs, total_expenses, net_profit, summary_json, closed_by) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [startDate, endDate, summary.totalVentas, summary.totalCostoProduccion, summary.totalGastos, summary.utilidadNeta, JSON.stringify(summary), closedBy]
    );
    res.json({ status: 'ok', data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pedidos/admin/closures', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos_app_closures ORDER BY id DESC');
    res.json({ status: 'ok', data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/pedidos/admin/closures/:id/reopen', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("UPDATE pedidos_app_closures SET status = 'Abierto' WHERE id = $1", [id]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
const horariosApi = require('./horarios_api')(app, pool, authenticateToken);
getHorariosStatus = horariosApi.getHorariosStatus;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Servidor backend corriendo en http://localhost:${PORT}`);
  });
}

module.exports = app;
