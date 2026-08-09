const DASHBOARD_QUERY = `
  WITH context AS (
    SELECT COALESCE(
      (SELECT timezone FROM pedidos_app_settings WHERE id = 1),
      'America/Bogota'
    ) AS timezone
  ),
  today_orders AS (
    SELECT orders.*
    FROM pedidos_app_orders orders
    CROSS JOIN context
    WHERE (orders.created_at AT TIME ZONE context.timezone)::date =
          (NOW() AT TIME ZONE context.timezone)::date
  ),
  inventory_stock AS (
    SELECT id, low_stock_threshold AS min_stock, COALESCE(stock, 0) AS stock
    FROM pedidos_app_products
    WHERE status = 'Activo' AND track_stock = TRUE
  ),
  top_products AS (
    SELECT item ->> 'title' AS title,
           SUM(COALESCE((item ->> 'quantity')::numeric, (item ->> 'qty')::numeric, 1)) AS quantity,
           SUM(
             COALESCE((item ->> 'price')::numeric, 0) *
             COALESCE((item ->> 'quantity')::numeric, (item ->> 'qty')::numeric, 1)
           ) AS total
    FROM today_orders orders
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(orders.cart_json, '[]'::jsonb)) item
    WHERE orders.status <> 'Cancelado' AND NULLIF(item ->> 'title', '') IS NOT NULL
    GROUP BY item ->> 'title'
    ORDER BY quantity DESC, total DESC
    LIMIT 5
  )
  SELECT
    (
      SELECT jsonb_build_object(
        'today', COUNT(*)::int,
        'new', COUNT(*) FILTER (WHERE status = 'Nuevo')::int,
        'preparing', COUNT(*) FILTER (WHERE status = 'En preparación')::int,
        'ready', COUNT(*) FILTER (WHERE status IN ('Listo', 'Asignado externo', 'Entregado al operador externo'))::int,
        'onTheWay', COUNT(*) FILTER (WHERE status = 'En camino')::int,
        'pendingPayment', COUNT(*) FILTER (WHERE status = 'Pendiente Pago')::int,
        'completed', COUNT(*) FILTER (WHERE status IN ('Entregado', 'Completado'))::int,
        'cancelled', COUNT(*) FILTER (WHERE status = 'Cancelado')::int,
        'active', COUNT(*) FILTER (WHERE status IN ('Nuevo', 'En preparación', 'Listo', 'Asignado externo', 'Entregado al operador externo', 'En camino', 'Pendiente Pago'))::int,
        'revenue', COALESCE(SUM(total) FILTER (WHERE status IN ('Entregado', 'Completado')), 0),
        'averageTicket', COALESCE(ROUND(AVG(total) FILTER (WHERE status IN ('Entregado', 'Completado'))), 0)
      )
      FROM today_orders
    ) AS orders,
    (
      SELECT jsonb_build_object(
        'total', COUNT(*)::int,
        'active', COUNT(*) FILTER (WHERE status = 'Activo')::int,
        'inactive', COUNT(*) FILTER (WHERE status <> 'Activo')::int,
        'featured', COUNT(*) FILTER (WHERE status = 'Activo' AND is_featured = TRUE)::int
      )
      FROM pedidos_app_products
    ) AS products,
    (
      SELECT jsonb_build_object(
        'total', COUNT(*)::int,
        'critical', COUNT(*) FILTER (WHERE stock <= min_stock)::int,
        'outOfStock', COUNT(*) FILTER (WHERE stock <= 0)::int
      )
      FROM inventory_stock
    ) AS inventory,
    (
      SELECT COALESCE(jsonb_agg(to_jsonb(recent) ORDER BY recent.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT id, customer_name, customer_phone, total, status, source,
               payment_method, delivery_type, created_at
        FROM pedidos_app_orders
        ORDER BY created_at DESC
        LIMIT 6
      ) recent
    ) AS recent_orders,
    (
      SELECT COALESCE(jsonb_agg(to_jsonb(product)), '[]'::jsonb)
      FROM top_products product
    ) AS top_products,
    (
      SELECT jsonb_build_object(
        'restaurantName', COALESCE(restaurant_name, 'Distrito BG'),
        'currency', COALESCE(currency, 'COP'),
        'prepTime', prep_time,
        'enabledPayments',
          (CASE WHEN payment_efectivo THEN 1 ELSE 0 END) +
          (CASE WHEN payment_nequi THEN 1 ELSE 0 END) +
          (CASE WHEN payment_daviplata THEN 1 ELSE 0 END) +
          (CASE WHEN payment_tarjeta THEN 1 ELSE 0 END) +
          (CASE WHEN payment_transferencia THEN 1 ELSE 0 END) +
          (CASE WHEN payment_pse THEN 1 ELSE 0 END)
      )
      FROM pedidos_app_settings
      WHERE id = 1
    ) AS settings
`;

function emptyDashboard() {
  return {
    orders: {
      today: 0, new: 0, preparing: 0, ready: 0, onTheWay: 0,
      pendingPayment: 0, completed: 0, cancelled: 0, active: 0,
      revenue: 0, averageTicket: 0,
    },
    products: { total: 0, active: 0, inactive: 0, featured: 0 },
    inventory: { total: 0, critical: 0, outOfStock: 0 },
    recentOrders: [],
    topProducts: [],
    settings: { restaurantName: 'Distrito BG', currency: 'COP', prepTime: null, enabledPayments: 0 },
    schedule: { isOpen: false, statusText: 'No disponible', currentSchedule: null },
  };
}

async function getDashboardSnapshot(pool, getScheduleStatus) {
  const [databaseResult, schedule] = await Promise.all([
    pool.query(DASHBOARD_QUERY),
    getScheduleStatus(),
  ]);
  const row = databaseResult.rows[0] || {};
  const fallback = emptyDashboard();

  return {
    orders: row.orders || fallback.orders,
    products: row.products || fallback.products,
    inventory: row.inventory || fallback.inventory,
    recentOrders: row.recent_orders || fallback.recentOrders,
    topProducts: row.top_products || fallback.topProducts,
    settings: row.settings || fallback.settings,
    schedule: schedule || fallback.schedule,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { DASHBOARD_QUERY, emptyDashboard, getDashboardSnapshot };
