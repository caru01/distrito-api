CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS pedidos_app_roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  is_system_role BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS pedidos_app_permissions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(220),
  module VARCHAR(100),
  action VARCHAR(100),
  description TEXT
);

CREATE TABLE IF NOT EXISTS pedidos_app_role_permissions (
  role_id INTEGER NOT NULL REFERENCES pedidos_app_roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES pedidos_app_permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS pedidos_app_users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50),
  role_id INTEGER REFERENCES pedidos_app_roles(id),
  email VARCHAR(255),
  phone VARCHAR(50),
  photo_url TEXT,
  branch VARCHAR(100),
  status VARCHAR(50) DEFAULT 'Activo',
  failed_attempts INTEGER DEFAULT 0,
  blocked_until TIMESTAMP,
  last_access TIMESTAMP,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  name VARCHAR(255),
  last_name VARCHAR(255),
  document VARCHAR(100),
  reset_token VARCHAR(255),
  reset_token_expiry TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedidos_app_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES pedidos_app_users(id) ON DELETE CASCADE,
  token_jti VARCHAR(255) UNIQUE,
  ip VARCHAR(100),
  browser VARCHAR(100),
  os VARCHAR(100),
  location VARCHAR(255),
  status VARCHAR(100) DEFAULT 'Activa',
  created_at TIMESTAMP DEFAULT NOW(),
  last_active TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pedidos_app_audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES pedidos_app_users(id) ON DELETE SET NULL,
  username_attempted VARCHAR(100),
  module VARCHAR(100),
  action VARCHAR(255) NOT NULL,
  ip VARCHAR(100),
  browser VARCHAR(100),
  os VARCHAR(100),
  location VARCHAR(255),
  details TEXT,
  request_data JSONB,
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

CREATE TABLE IF NOT EXISTS pedidos_app_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL CHECK (price >= 0),
  category TEXT,
  image TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  status VARCHAR(50) DEFAULT 'Activo',
  is_featured BOOLEAN DEFAULT FALSE,
  stock INTEGER,
  rating_sum INTEGER DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedidos_app_settings (
  id INTEGER PRIMARY KEY,
  whatsapp_number TEXT,
  nequi_number TEXT,
  bancolombia_number TEXT,
  restaurant_name VARCHAR(255),
  description TEXT,
  phone VARCHAR(50),
  email VARCHAR(255),
  address TEXT,
  schedule VARCHAR(255),
  logo TEXT,
  prep_time VARCHAR(50),
  min_order INTEGER DEFAULT 0,
  delivery_cost INTEGER DEFAULT 0,
  max_distance VARCHAR(50),
  delivery_schedule VARCHAR(255),
  default_order_type VARCHAR(50),
  payment_efectivo BOOLEAN DEFAULT TRUE,
  payment_nequi BOOLEAN DEFAULT TRUE,
  payment_daviplata BOOLEAN DEFAULT FALSE,
  payment_tarjeta BOOLEAN DEFAULT FALSE,
  payment_transferencia BOOLEAN DEFAULT FALSE,
  payment_pse BOOLEAN DEFAULT FALSE,
  instagram VARCHAR(255),
  facebook VARCHAR(255),
  tiktok VARCHAR(255),
  welcome_message TEXT,
  currency VARCHAR(20) DEFAULT 'COP',
  timezone VARCHAR(100) DEFAULT 'America/Bogota',
  language VARCHAR(20) DEFAULT 'es',
  date_format VARCHAR(30) DEFAULT 'DD/MM/YYYY',
  time_format VARCHAR(20) DEFAULT '12h',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedidos_app_announcements (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  image_url TEXT NOT NULL,
  is_active BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMP DEFAULT NOW()
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

CREATE TABLE IF NOT EXISTS pedidos_app_orders (
  id SERIAL PRIMARY KEY,
  customer_name VARCHAR(255),
  customer_phone VARCHAR(50),
  address TEXT,
  barrio VARCHAR(255),
  delivery_type VARCHAR(50),
  payment_method VARCHAR(50),
  total INTEGER CHECK (total >= 0),
  cart_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(50) DEFAULT 'Nuevo',
  source VARCHAR(50) DEFAULT 'Web',
  notes TEXT,
  voucher_reference VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  delivered_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pedidos_app_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image TEXT,
  name VARCHAR(255) UNIQUE NOT NULL,
  type VARCHAR(50) DEFAULT 'Ingrediente',
  category VARCHAR(100),
  unit VARCHAR(50),
  stock NUMERIC(14,4) DEFAULT 0,
  min_stock NUMERIC(14,4) DEFAULT 0,
  max_stock NUMERIC(14,4),
  expiry_date DATE,
  unit_cost NUMERIC(14,4) DEFAULT 0,
  supplier VARCHAR(255),
  sku VARCHAR(100),
  purchase_unit VARCHAR(50),
  consumption_unit VARCHAR(50),
  conversion_factor NUMERIC(14,4) DEFAULT 1,
  status VARCHAR(20) DEFAULT 'Activo',
  observations TEXT,
  branch_id INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedidos_app_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number VARCHAR(100),
  supplier VARCHAR(255),
  purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
  total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  iva_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedidos_app_purchase_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID REFERENCES pedidos_app_purchases(id) ON DELETE CASCADE,
  inventory_id UUID REFERENCES pedidos_app_inventory(id) ON DELETE CASCADE,
  quantity NUMERIC(14,4) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
  total_cost NUMERIC(14,2) NOT NULL CHECK (total_cost >= 0),
  iva_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  lot_code VARCHAR(100),
  expiration_date DATE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedidos_app_inventory_lots (
  id BIGSERIAL PRIMARY KEY,
  inventory_id UUID NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE RESTRICT,
  purchase_item_id UUID REFERENCES pedidos_app_purchase_items(id) ON DELETE RESTRICT,
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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
);

CREATE TABLE IF NOT EXISTS pedidos_app_rendimientos (
  id SERIAL PRIMARY KEY,
  ingrediente_id UUID REFERENCES pedidos_app_inventory(id) ON DELETE CASCADE,
  ingrediente_name VARCHAR(255),
  unidad_compra VARCHAR(50),
  cantidad_comprada NUMERIC(10,2),
  costo_compra INTEGER,
  unidad_consumo VARCHAR(50),
  conversion_definida NUMERIC(10,2),
  rendimiento_obtenido NUMERIC(10,2),
  costo_por_unidad NUMERIC(10,2),
  estado VARCHAR(20) DEFAULT 'Activo',
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedidos_app_recipes (
  id SERIAL PRIMARY KEY,
  product_id UUID REFERENCES pedidos_app_products(id) ON DELETE CASCADE,
  rendimiento_id INTEGER REFERENCES pedidos_app_rendimientos(id) ON DELETE CASCADE,
  cantidad_usada NUMERIC(10,2),
  costo_calculado NUMERIC(10,2),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedidos_app_order_inventory_consumptions (
  id BIGSERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES pedidos_app_orders(id) ON DELETE RESTRICT,
  recipe_id INTEGER REFERENCES pedidos_app_recipes(id) ON DELETE RESTRICT,
  inventory_id UUID NOT NULL REFERENCES pedidos_app_inventory(id) ON DELETE RESTRICT,
  lot_id BIGINT NOT NULL REFERENCES pedidos_app_inventory_lots(id) ON DELETE RESTRICT,
  movement_id UUID REFERENCES pedidos_app_inventory_movements(id) ON DELETE RESTRICT,
  quantity NUMERIC(14,4) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
  reversed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedidos_app_expenses (
  id SERIAL PRIMARY KEY,
  category VARCHAR(100),
  description TEXT,
  amount INTEGER CHECK (amount >= 0),
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

CREATE TABLE IF NOT EXISTS pedidos_app_push_subscriptions (
  id SERIAL PRIMARY KEY,
  endpoint TEXT UNIQUE NOT NULL,
  subscription_json JSON NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedidos_app_horarios (
  id SERIAL PRIMARY KEY,
  day_of_week VARCHAR(20) UNIQUE NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
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
  is_closed BOOLEAN DEFAULT TRUE,
  open_time VARCHAR(10),
  close_time VARCHAR(10),
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE pedidos_app_roles ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE pedidos_app_roles ADD COLUMN IF NOT EXISTS is_system_role BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE pedidos_app_permissions ADD COLUMN IF NOT EXISTS name VARCHAR(220);
ALTER TABLE pedidos_app_permissions ADD COLUMN IF NOT EXISTS module VARCHAR(100);
ALTER TABLE pedidos_app_permissions ADD COLUMN IF NOT EXISTS action VARCHAR(100);
ALTER TABLE pedidos_app_permissions ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE pedidos_app_permissions ALTER COLUMN name DROP NOT NULL;

ALTER TABLE pedidos_app_users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pedidos_app_users ADD COLUMN IF NOT EXISTS name VARCHAR(255);
ALTER TABLE pedidos_app_users ADD COLUMN IF NOT EXISTS last_name VARCHAR(255);
ALTER TABLE pedidos_app_users ADD COLUMN IF NOT EXISTS document VARCHAR(100);
ALTER TABLE pedidos_app_users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(255);
ALTER TABLE pedidos_app_users ADD COLUMN IF NOT EXISTS reset_token_expiry TIMESTAMP;

ALTER TABLE pedidos_app_audit_logs ADD COLUMN IF NOT EXISTS module VARCHAR(100);
ALTER TABLE pedidos_app_audit_logs ADD COLUMN IF NOT EXISTS request_data JSONB;

ALTER TABLE pedidos_app_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE pedidos_app_orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;
ALTER TABLE pedidos_app_products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE pedidos_app_inventory_movements ADD COLUMN IF NOT EXISTS lot_id BIGINT;
ALTER TABLE pedidos_app_inventory_movements ADD COLUMN IF NOT EXISTS branch_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pedidos_app_inventory_movements ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0;
ALTER TABLE pedidos_app_inventory_movements ADD COLUMN IF NOT EXISTS balance_after NUMERIC(14,4);
ALTER TABLE pedidos_app_inventory_movements ADD COLUMN IF NOT EXISTS reference_type VARCHAR(30);
ALTER TABLE pedidos_app_inventory_movements ADD COLUMN IF NOT EXISTS reference_id VARCHAR(100);
ALTER TABLE pedidos_app_inventory_movements ADD COLUMN IF NOT EXISTS created_by VARCHAR(100) DEFAULT 'Administrador';

DO $$
DECLARE
  purchase_item_type TEXT;
BEGIN
  SELECT data_type INTO purchase_item_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'pedidos_app_inventory_lots'
    AND column_name = 'purchase_item_id';

  IF purchase_item_type = 'integer' THEN
    IF EXISTS (SELECT 1 FROM pedidos_app_inventory_lots WHERE purchase_item_id IS NOT NULL) THEN
      RAISE EXCEPTION 'No se puede convertir purchase_item_id a UUID con valores existentes';
    END IF;
    ALTER TABLE pedidos_app_inventory_lots
      ALTER COLUMN purchase_item_id TYPE UUID USING NULL::uuid;
  END IF;
END $$;

UPDATE pedidos_app_products SET created_at = NULL WHERE created_at IS NOT NULL AND btrim(created_at::text) = '';
ALTER TABLE pedidos_app_products
  ALTER COLUMN created_at TYPE TIMESTAMPTZ
  USING COALESCE(created_at::text::timestamptz, NOW());
ALTER TABLE pedidos_app_products ALTER COLUMN created_at SET DEFAULT NOW();

ALTER TABLE pedidos_app_settings
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ
  USING COALESCE(NULLIF(btrim(updated_at::text), '')::timestamptz, NOW());
ALTER TABLE pedidos_app_settings ALTER COLUMN updated_at SET DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_app_sessions_user_id_fkey') THEN
    ALTER TABLE pedidos_app_sessions ADD CONSTRAINT pedidos_app_sessions_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES pedidos_app_users(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_app_audit_logs_user_id_fkey') THEN
    ALTER TABLE pedidos_app_audit_logs ADD CONSTRAINT pedidos_app_audit_logs_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES pedidos_app_users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_app_inventory_movements_lot_id_fkey') THEN
    ALTER TABLE pedidos_app_inventory_movements ADD CONSTRAINT pedidos_app_inventory_movements_lot_id_fkey
      FOREIGN KEY (lot_id) REFERENCES pedidos_app_inventory_lots(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_app_inventory_lots_purchase_item_id_fkey') THEN
    ALTER TABLE pedidos_app_inventory_lots ADD CONSTRAINT pedidos_app_inventory_lots_purchase_item_id_fkey
      FOREIGN KEY (purchase_item_id) REFERENCES pedidos_app_purchase_items(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_module_action
  ON pedidos_app_permissions (module, action) WHERE module IS NOT NULL AND action IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_sku_unique
  ON pedidos_app_inventory (sku) WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON pedidos_app_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON pedidos_app_orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON pedidos_app_orders (customer_phone);
CREATE INDEX IF NOT EXISTS idx_products_status_category ON pedidos_app_products (status, category);
CREATE INDEX IF NOT EXISTS idx_purchases_created_at ON pedidos_app_purchases (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON pedidos_app_purchase_items (purchase_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON pedidos_app_expenses (expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_closures_period ON pedidos_app_closures (start_date, end_date, status);
CREATE INDEX IF NOT EXISTS idx_sessions_user_status ON pedidos_app_sessions (user_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON pedidos_app_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recipes_product ON pedidos_app_recipes (product_id);
CREATE INDEX IF NOT EXISTS idx_rendimientos_inventory ON pedidos_app_rendimientos (ingrediente_id);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_fifo
  ON pedidos_app_inventory_lots (inventory_id, branch_id, created_at, id)
  WHERE available_quantity > 0 AND status = 'Disponible';
CREATE INDEX IF NOT EXISTS idx_inventory_movements_item
  ON pedidos_app_inventory_movements (inventory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_consumptions_order
  ON pedidos_app_order_inventory_consumptions (order_id);

INSERT INTO pedidos_app_roles (name, is_system_role)
VALUES
  ('Super Administrador', TRUE), ('Administrador', TRUE), ('Gerente', TRUE),
  ('Cajero', TRUE), ('Cocina', TRUE), ('Inventario', TRUE), ('Compras', TRUE),
  ('Delivery', TRUE), ('Contabilidad', TRUE)
ON CONFLICT (name) DO UPDATE SET is_system_role = EXCLUDED.is_system_role;

INSERT INTO pedidos_app_permissions (name, module, action, description)
SELECT module || ':' || action, module, action, module || ' - ' || action
FROM unnest(ARRAY[
  'Dashboard','Pedidos','Categorias','Productos','Clientes','Inventario','Rendimientos',
  'Recetas','Gastos','Cierre Contable','Reportes','Configuracion','Perfil','Usuarios',
  'Roles','Permisos','Auditoria'
]) AS modules(module)
CROSS JOIN unnest(ARRAY['ver','crear','editar','eliminar']) AS actions(action)
ON CONFLICT (module, action) WHERE module IS NOT NULL AND action IS NOT NULL DO NOTHING;

INSERT INTO pedidos_app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM pedidos_app_roles r
CROSS JOIN pedidos_app_permissions p
WHERE r.name = 'Super Administrador'
ON CONFLICT DO NOTHING;

INSERT INTO pedidos_app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

INSERT INTO pedidos_app_horarios (day_of_week)
SELECT day FROM unnest(ARRAY['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo']) AS days(day)
ON CONFLICT (day_of_week) DO NOTHING;

INSERT INTO pedidos_app_horarios_config (id)
SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pedidos_app_horarios_config);
