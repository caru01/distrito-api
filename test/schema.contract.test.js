const test = require('node:test');
const assert = require('node:assert/strict');
const { createPool } = require('../src/db');

const requiredColumns = {
  pedidos_app_orders: [
    'updated_at', 'delivered_at', 'delivery_user_id', 'delivery_status', 'delivery_fee',
    'delivery_accepted_at', 'picked_up_at', 'on_the_way_at', 'delivery_completed_at',
    'delivery_latitude', 'delivery_longitude', 'delivery_place_id',
    'delivery_location_adjusted', 'delivery_apartment', 'delivery_tower', 'delivery_floor'
  ],
  pedidos_app_products: ['updated_at', 'barcode', 'track_stock', 'low_stock_threshold'],
  pedidos_app_inventory_movements: [
    'lot_id', 'branch_id', 'unit_cost', 'balance_after',
    'reference_type', 'reference_id', 'created_by'
  ],
  pedidos_app_permissions: ['module', 'action'],
  pedidos_app_users: ['must_change_password', 'name', 'last_name', 'document', 'max_active_sessions', 'session_idle_minutes'],
  pedidos_app_sessions: ['device_id', 'device_name', 'last_active', 'expires_at'],
  pedidos_app_settings: ['web_primary_color', 'admin_primary_color', 'store_latitude', 'store_longitude', 'kitchen_address', 'kitchen_place_id', 'delivery_completion_radius_meters'],
  pedidos_app_audit_logs: ['module', 'request_data'],
  pedidos_app_announcements: ['body', 'cta_label', 'cta_url', 'starts_at', 'ends_at', 'display_frequency'],
  pedidos_app_delivery_profiles: ['user_id', 'availability_status', 'current_latitude', 'current_longitude', 'last_location_at', 'max_active_orders'],
  pedidos_app_delivery_locations: ['user_id', 'order_id', 'latitude', 'longitude', 'recorded_at'],
  pedidos_app_push_subscriptions: ['user_id', 'audience', 'updated_at'],
};

test('el esquema configurado cumple el contrato de la API', async () => {
  const pool = createPool({ max: 1 });
  try {
    const tables = [...Object.keys(requiredColumns), 'pedidos_app_order_inventory_consumptions', 'pedidos_app_product_stock_movements'];
    const { rows } = await pool.query(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [tables]
    );
    const actual = new Map();
    for (const row of rows) {
      if (!actual.has(row.table_name)) actual.set(row.table_name, new Set());
      actual.get(row.table_name).add(row.column_name);
    }

    assert.ok(actual.has('pedidos_app_order_inventory_consumptions'));
    assert.ok(actual.has('pedidos_app_product_stock_movements'));
    for (const [table, columns] of Object.entries(requiredColumns)) {
      assert.ok(actual.has(table), `Falta la tabla ${table}`);
      for (const column of columns) {
        assert.ok(actual.get(table).has(column), `Falta ${table}.${column}`);
      }
    }
  } finally {
    await pool.end();
  }
});

test('todas las migraciones versionadas están registradas', async () => {
  const pool = createPool({ max: 1 });
  try {
    const { rows } = await pool.query('SELECT name FROM pedidos_app_schema_migrations ORDER BY name');
    assert.deepEqual(rows.map((row) => row.name), [
      '001_align_schema.sql',
      '002_compact_order_cart.sql',
      '003_align_administrator_permissions.sql',
      '004_robust_ordering.sql',
      '005_announcement_campaigns.sql',
      '006_delivery_operations.sql',
      '007_delivery_guards_and_retention.sql',
      '008_order_delivery_geolocation.sql',
      '009_restaurant_geolocation.sql',
      '010_delivery_capacity_and_kitchen.sql',
      '011_delivery_completion_geofence.sql',
    ]);
  } finally {
    await pool.end();
  }
});
