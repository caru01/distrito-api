const test = require('node:test');
const assert = require('node:assert/strict');
const { createPool } = require('../src/db');

const requiredColumns = {
  pedidos_app_orders: [
    'updated_at', 'delivered_at', 'delivery_user_id', 'delivery_status', 'delivery_fee',
    'delivery_accepted_at', 'picked_up_at', 'on_the_way_at', 'delivery_completed_at',
    'delivery_latitude', 'delivery_longitude', 'delivery_place_id',
    'delivery_location_adjusted', 'delivery_apartment', 'delivery_tower', 'delivery_floor',
    'delivery_provider_type', 'external_delivery_company_id', 'external_driver_name',
    'external_driver_phone', 'external_vehicle_id', 'external_delivery_cost',
    'external_eta_minutes', 'external_assigned_at', 'external_handed_off_at',
    'external_delivery_confirmed_at', 'external_delivery_confirmed_by', 'version', 'accepted_by_device_id'
    , 'customer_phone_e164', 'crm_contact_id', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content'
  ],
  pedidos_app_products: ['updated_at', 'barcode', 'track_stock', 'low_stock_threshold'],
  pedidos_app_inventory_movements: [
    'lot_id', 'branch_id', 'unit_cost', 'balance_after',
    'reference_type', 'reference_id', 'created_by'
  ],
  pedidos_app_permissions: ['module', 'action'],
  pedidos_app_users: ['must_change_password', 'name', 'last_name', 'document', 'max_active_sessions', 'session_idle_minutes'],
  pedidos_app_sessions: ['device_id', 'device_name', 'last_active', 'expires_at'],
  pedidos_app_settings: ['web_primary_color', 'admin_primary_color', 'delivery_primary_color', 'store_latitude', 'store_longitude', 'kitchen_address', 'kitchen_place_id', 'delivery_completion_radius_meters', 'notification_voice', 'notification_language', 'web_logo', 'admin_logo', 'delivery_logo', 'web_page_title', 'admin_page_title', 'delivery_page_title', 'gps_delivery_interval_seconds', 'gps_free_interval_seconds', 'presence_heartbeat_interval_seconds', 'presence_timeout_seconds', 'gps_max_age_seconds', 'gps_max_accuracy_meters', 'offline_location_queue_limit', 'default_max_driver_capacity', 'sse_reconnect_initial_ms', 'sse_reconnect_max_ms', 'crm_inactive_days', 'crm_frequent_orders', 'crm_vip_orders', 'crm_vip_spend', 'crm_attribution_days', 'crm_campaign_frequency_days'],
  pedidos_app_audit_logs: ['module', 'request_data'],
  pedidos_app_announcements: ['body', 'cta_label', 'cta_url', 'starts_at', 'ends_at', 'display_frequency', 'campaign_type', 'audience', 'priority', 'views_count', 'clicks_count'],
  pedidos_app_customers: ['email', 'address', 'barrio', 'status', 'tags', 'notes', 'birthday', 'marketing_opt_in', 'last_contact_at', 'phone_e164', 'source'],
  pedidos_app_closures: ['orders_count', 'cancelled_orders', 'cash_expected', 'cash_counted', 'cash_difference', 'notes', 'reopened_at', 'reopen_reason'],
  pedidos_app_delivery_profiles: ['user_id', 'availability_status', 'current_latitude', 'current_longitude', 'last_location_at', 'max_active_orders', 'shift_active', 'last_seen_at', 'tracking_device_id', 'tracking_mode', 'gps_status'],
  pedidos_app_delivery_locations: ['user_id', 'order_id', 'latitude', 'longitude', 'recorded_at'],
  pedidos_app_push_subscriptions: ['user_id', 'audience', 'updated_at'],
  pedidos_app_delivery_companies: ['name', 'phone', 'status', 'observations', 'default_fee', 'estimated_delivery_minutes', 'integration_type'],
  pedidos_app_delivery_events: ['order_id', 'event_type', 'provider_type', 'delivery_user_id', 'company_id', 'actor_user_id', 'external_cost', 'metadata'],
  pedidos_app_delivery_idempotency: ['operation', 'idempotency_key', 'actor_user_id', 'order_id', 'request_fingerprint', 'response_body'],
  pedidos_app_driver_location_points: ['driver_id', 'device_id', 'client_point_id', 'captured_at', 'received_at', 'latitude', 'longitude', 'accuracy', 'mode', 'distance_from_previous_km'],
  pedidos_app_delivery_geofence_overrides: ['order_id', 'authorized_by', 'driver_id', 'reason', 'distance_meters'],
  pedidos_app_delivery_evidence_files: ['order_id', 'uploaded_by', 'mime_type', 'byte_size', 'sha256', 'contents'],
  pedidos_app_domain_events: ['event_id', 'aggregate_type', 'aggregate_id', 'event_type', 'payload', 'published_at'],
  pedidos_app_delivery_native_bootstrap: ['code_hash', 'driver_id', 'device_id', 'expires_at', 'consumed_at'],
  pedidos_app_crm_contacts: ['normalized_phone', 'status', 'source', 'orders_count', 'total_spent', 'marketing_opt_in', 'marketing_opt_out', 'no_contact'],
  pedidos_app_crm_conversations: ['contact_id', 'channel', 'status', 'unread_count', 'last_message_at'],
  pedidos_app_crm_messages: ['conversation_id', 'contact_id', 'provider_message_id', 'direction', 'message_type', 'status'],
  pedidos_app_crm_consents: ['contact_id', 'channel', 'consent_type', 'granted', 'source'],
  pedidos_app_crm_segments: ['segment_type', 'definition', 'estimated_count'],
  pedidos_app_crm_campaigns: ['segment_id', 'template_id', 'status', 'sent_count', 'attributed_revenue'],
  pedidos_app_crm_campaign_recipients: ['campaign_id', 'contact_id', 'status', 'provider_message_id'],
  pedidos_app_crm_message_jobs: ['job_key', 'job_type', 'payload', 'status', 'attempts', 'available_at'],
  pedidos_app_crm_automations: ['trigger_type', 'conditions', 'action_type', 'action_config', 'is_active'],
  pedidos_app_crm_automation_runs: ['automation_id', 'contact_id', 'run_key', 'status', 'scheduled_at'],
  pedidos_app_crm_attributions: ['campaign_id', 'contact_id', 'order_id', 'attribution_type', 'attributed_amount'],
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
      '012_notification_preferences.sql',
      '013_branding_campaigns_customers_closures.sql',
      '014_external_delivery_companies.sql',
      '015_delivery_professional_core.sql',
      '016_delivery_runtime_settings.sql',
      '017_delivery_native_bootstrap.sql',
      '018_crm_foundation.sql',
      '019_crm_commercial.sql',
      '020_crm_normalization_and_integrity.sql',
      '021_crm_search_indexes.sql',
      '022_crm_acquisition_source.sql',
    ]);
  } finally {
    await pool.end();
  }
});
