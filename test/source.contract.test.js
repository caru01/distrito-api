const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('el servidor no contiene DDL ni expone setup remoto', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.doesNotMatch(server, /CREATE\s+TABLE|ALTER\s+TABLE/i);
  assert.doesNotMatch(server, /\/api\/pedidos\/setup/);
});

test('la configuración de PostgreSQL tiene una única fuente', () => {
  const files = [
    path.join(root, 'server.js'),
    ...fs.readdirSync(path.join(root, 'scripts'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => path.join(root, 'scripts', name)),
  ];
  for (const file of files) {
    const contents = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(contents, /new\s+Pool\s*\(/, `${file} crea un pool fuera de src/db.js`);
  }
});

test('las consultas parametrizadas de horarios conservan sus marcadores', () => {
  const schedules = fs.readFileSync(path.join(root, 'horarios_api.js'), 'utf8');
  assert.match(schedules, /exception_date = \$1/);
  assert.match(schedules, /day_of_week = \$1/);
  assert.doesNotMatch(schedules, /WHERE\s+[\w.]+\s*=\s*['`]/i);
});

test('los frontends no duplican el prefijo de la API', () => {
  for (const project of ['distrito-web', 'distrito-admin', 'Distrito-delivery']) {
    const source = path.resolve(root, '..', project, 'src');
    const files = [];
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(entryPath);
        else if (/\.(js|jsx)$/.test(entry.name)) files.push(entryPath);
      }
    };
    visit(source);
    for (const file of files) {
      const contents = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(contents, /\$\{API_URL\}\/api\/pedidos/);
      assert.doesNotMatch(contents, /BASE_URL\s+as\s+API_URL/);
    }
  }
});

test('el frontend público no contiene módulos administrativos', () => {
  const webSource = path.resolve(root, '..', 'distrito-web', 'src');
  const legacyFiles = [path.join(webSource, 'pages'), path.join(webSource, 'layouts')]
    .flatMap((directory) => fs.existsSync(directory) ? fs.readdirSync(directory) : []);
  assert.deepEqual(legacyFiles, []);
});

test('los frontends conservan viewport y contratos adaptativos separados', () => {
  const projectsRoot = path.resolve(root, '..');
  for (const project of ['distrito-web', 'distrito-admin']) {
    const html = fs.readFileSync(path.join(projectsRoot, project, 'index.html'), 'utf8');
    assert.match(html, /name=["']viewport["'][^>]*width=device-width/i, `${project} no define viewport móvil`);
  }

  const webCss = fs.readFileSync(path.join(projectsRoot, 'distrito-web', 'src', 'index.css'), 'utf8');
  assert.match(webCss, /min-width:\s*901px[^}]*max-width:\s*1199px/s);
  assert.match(webCss, /max-width:\s*600px/);
  assert.match(webCss, /max-width:\s*360px/);
  assert.doesNotMatch(webCss, /\.admin-sidebar|\.responsive-table/, 'la tienda volvió a incorporar estilos administrativos');

  const adminMain = fs.readFileSync(path.join(projectsRoot, 'distrito-admin', 'src', 'main.jsx'), 'utf8');
  const adminCss = fs.readFileSync(path.join(projectsRoot, 'distrito-admin', 'src', 'styles', 'design-system.css'), 'utf8');
  assert.doesNotMatch(adminMain, /import\s+['"]\.\/index\.css['"]/);
  assert.match(adminCss, /max-width:\s*1599px/);
  assert.match(adminCss, /max-width:\s*1199px/);
  assert.match(adminCss, /max-width:\s*767px/);
  assert.match(adminCss, /\.take-order-checkout/);
});

test('el dashboard usa una fuente agregada y no cifras fijas', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const dashboardApi = fs.readFileSync(path.join(root, 'src', 'dashboard.js'), 'utf8');
  const dashboardPage = fs.readFileSync(path.resolve(root, '..', 'distrito-admin', 'src', 'pages', 'AdminDashboard.jsx'), 'utf8');

  assert.match(server, /\/api\/pedidos\/admin\/dashboard/);
  assert.match(dashboardApi, /today_orders/);
  assert.match(dashboardApi, /inventory_stock/);
  assert.match(dashboardPage, /API_URL}\/admin\/dashboard/);
  assert.match(dashboardPage, /STOREFRONT_URL/);
  assert.doesNotMatch(dashboardPage, /<p className="stat-value">0<\/p>/);
});

test('inventario de producto reemplaza recetas y rendimientos en la operación vigente', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const adminMain = fs.readFileSync(path.resolve(root, '..', 'distrito-admin', 'src', 'main.jsx'), 'utf8');
  const adminLayout = fs.readFileSync(path.resolve(root, '..', 'distrito-admin', 'src', 'layouts', 'AdminLayout.jsx'), 'utf8');
  assert.match(server, /pedidos_app_product_stock_movements/);
  assert.match(server, /reserveProductStock/);
  assert.doesNotMatch(server, /\/api\/pedidos\/admin\/recipes/);
  assert.doesNotMatch(server, /\/api\/pedidos\/admin\/rendimientos/);
  assert.doesNotMatch(adminMain, /AdminRecetas|AdminRendimientos|path="recetas"|path="rendimientos"/);
  assert.doesNotMatch(adminLayout, /\/admin\/recetas|\/admin\/rendimientos/);
});

test('la sesión administrativa tiene una sola fuente de inactividad', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const auth = fs.readFileSync(path.resolve(root, '..', 'distrito-admin', 'src', 'context', 'AuthContext.jsx'), 'utf8');
  const layout = fs.readFileSync(path.resolve(root, '..', 'distrito-admin', 'src', 'layouts', 'AdminLayout.jsx'), 'utf8');
  assert.match(auth, /session_idle_minutes/);
  assert.match(auth, /visibilitychange/);
  assert.doesNotMatch(layout, /resetTimer|timeoutRef|showWarning/);
  assert.match(server, /NOT IN \('Domiciliario', 'Repartidor'\)/);
});

test('delivery conserva PWA, capacidad por usuario, GPS global y aceptación atómica', () => {
  const projectsRoot = path.resolve(root, '..');
  const api = fs.readFileSync(path.join(root, 'delivery_api.js'), 'utf8');
  const manifest = fs.readFileSync(path.join(projectsRoot, 'Distrito-delivery', 'public', 'manifest.webmanifest'), 'utf8');
  const serviceWorker = fs.readFileSync(path.join(projectsRoot, 'Distrito-delivery', 'public', 'sw.js'), 'utf8');
  const locationHook = fs.readFileSync(path.join(projectsRoot, 'Distrito-delivery', 'src', 'hooks', 'useDeliveryLocation.js'), 'utf8');
  const deliveryAuth = fs.readFileSync(path.join(projectsRoot, 'Distrito-delivery', 'src', 'context', 'AuthContext.jsx'), 'utf8');
  const deliveryLayout = fs.readFileSync(path.join(projectsRoot, 'Distrito-delivery', 'src', 'components', 'AppLayout.jsx'), 'utf8');
  const onboarding = fs.readFileSync(path.join(projectsRoot, 'Distrito-delivery', 'src', 'components', 'DeliveryOnboarding.jsx'), 'utf8');
  const orderDetail = fs.readFileSync(path.join(projectsRoot, 'Distrito-delivery', 'src', 'pages', 'OrderDetail.jsx'), 'utf8');
  const deliveryCss = fs.readFileSync(path.join(projectsRoot, 'Distrito-delivery', 'src', 'styles.css'), 'utf8');
  assert.match(manifest, /"display"\s*:\s*"standalone"/);
  assert.match(serviceWorker, /addEventListener\('push'/);
  assert.match(api, /DELIVERY_ROLES/);
  assert.match(api, /delivery_status = 'Pendiente'/);
  assert.match(api, /delivery_user_id IS NULL OR delivery_user_id = \$1/);
  assert.match(api, /delivery_status = 'En camino'/);
  assert.match(api, /max_active_orders/);
  assert.match(api, /DELIVERY_CAPACITY_REACHED/);
  assert.match(api, /FOR UPDATE/);
  assert.match(locationHook, /activeOrderIds\.map/);
  assert.match(locationHook, /Promise\.allSettled/);
  assert.match(locationHook, /arrivals/);
  assert.doesNotMatch(deliveryAuth, /session_idle_minutes/);
  assert.match(deliveryAuth, /renewAccessToken/);
  assert.match(deliveryLayout, /distrito:new-order-alert/);
  assert.match(deliveryLayout, /DeliveryOnboarding/);
  assert.match(onboarding, /Instalar aplicación/);
  assert.match(onboarding, /Permitir ubicación/);
  assert.match(onboarding, /Activar sonido/);
  assert.match(deliveryCss, /height:100dvh/);
  assert.match(deliveryCss, /overflow-y:auto/);
  assert.match(orderDetail, /data-testid="complete-delivery"/);
  assert.match(orderDetail, /LiveDeliveryMap/);
  assert.match(orderDetail, /withinCompletionRange/);
  assert.match(api, /OUTSIDE_DELIVERY_GEOFENCE/);
  assert.match(api, /delivery_completion_radius_meters/);
  assert.doesNotMatch(orderDetail, /disabled=\{busy \|\| gps\.status === 'error'\}/);
});

test('el mapa, delivery y seguimiento comparten el contrato en tiempo real', () => {
  const projectsRoot = path.resolve(root, '..');
  const api = fs.readFileSync(path.join(root, 'delivery_api.js'), 'utf8');
  const adminMap = fs.readFileSync(path.join(projectsRoot, 'distrito-admin', 'src', 'pages', 'AdminDeliveryMap.jsx'), 'utf8');
  const tracker = fs.readFileSync(path.join(projectsRoot, 'distrito-web', 'src', 'components', 'OrderTracker.jsx'), 'utf8');
  const sharedMap = fs.readFileSync(path.join(projectsRoot, 'distrito-shared', 'src', 'LiveDeliveryMap.jsx'), 'utf8');
  const settings = fs.readFileSync(path.join(projectsRoot, 'distrito-admin', 'src', 'pages', 'AdminConfiguracion.jsx'), 'utf8');
  const capacityMigration = fs.readFileSync(path.join(root, 'migrations', '010_delivery_capacity_and_kitchen.sql'), 'utf8');
  assert.match(api, /\/realtime\/stream/);
  assert.match(api, /\/track\/:id\/stream/);
  assert.match(api, /\/admin\/delivery\/overview/);
  assert.match(adminMap, /realtime\/stream/);
  assert.match(adminMap, /LiveDeliveryMap/);
  assert.match(tracker, /new EventSource/);
  assert.match(tracker, /order\.driver/);
  assert.match(tracker, /LiveDeliveryMap/);
  assert.doesNotMatch(tracker, /Acceso temporal activo/);
  assert.match(sharedMap, /AdvancedMarkerElement/);
  assert.match(sharedMap, /🛵/);
  assert.match(settings, /Dirección de la cocina/);
  assert.match(settings, /DeliveryAddressPicker/);
  assert.match(capacityMigration, /DROP INDEX IF EXISTS idx_delivery_one_active_per_driver/);
});

test('checkout separa el tipo textual de la decisión booleana del domicilio', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.doesNotMatch(server, /CASE WHEN lower\(\$5\)/);
  assert.doesNotMatch(server, /CASE WHEN lower\(\$6\)/);
  assert.match(server, /CASE WHEN \$15::boolean/);
  assert.match(server, /delivery_latitude, delivery_longitude/);
});

test('la dirección pública confirma un punto y delivery navega a sus coordenadas', () => {
  const projectsRoot = path.resolve(root, '..');
  const picker = fs.readFileSync(path.join(projectsRoot, 'distrito-shared', 'src', 'DeliveryAddressPicker.jsx'), 'utf8');
  const web = fs.readFileSync(path.join(projectsRoot, 'distrito-web', 'src', 'App.jsx'), 'utf8');
  const admin = fs.readFileSync(path.join(projectsRoot, 'distrito-admin', 'src', 'pages', 'TomarPedido.jsx'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'delivery_api.js'), 'utf8');
  assert.match(picker, /AutocompleteSuggestion\.fetchAutocompleteSuggestions/);
  assert.match(picker, /AutocompleteSessionToken/);
  assert.match(picker, /aria-autocomplete="list"/);
  assert.match(picker, /gmpDraggable:\s*true/);
  assert.match(picker, /locationConfirmed:\s*true/);
  assert.match(web, /@distrito\/shared-ui/);
  assert.match(admin, /@distrito\/shared-ui/);
  assert.match(admin, /placeId:\s*customer\.placeId/);
  assert.match(api, /delivery_latitude.*delivery_longitude/);
  assert.match(api, /destinationLatitude/);
});

test('pedido, WhatsApp, cocina y delivery comparten el flujo de seguimiento', () => {
  const projectsRoot = path.resolve(root, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const deliveryApi = fs.readFileSync(path.join(root, 'delivery_api.js'), 'utf8');
  const web = fs.readFileSync(path.join(projectsRoot, 'distrito-web', 'src', 'App.jsx'), 'utf8');
  const tracker = fs.readFileSync(path.join(projectsRoot, 'distrito-web', 'src', 'components', 'OrderTracker.jsx'), 'utf8');
  const webCss = fs.readFileSync(path.join(projectsRoot, 'distrito-web', 'src', 'index.css'), 'utf8');
  const admin = fs.readFileSync(path.join(projectsRoot, 'distrito-admin', 'src', 'pages', 'AdminPedidos.jsx'), 'utf8');
  assert.match(server, /tracking_token:\s*issueTrackingToken/);
  assert.match(web, /Seguimiento temporal:/);
  assert.match(web, /whatsappWindow\.location\.replace/);
  assert.match(tracker, /Recorrido en vivo del domiciliario/);
  assert.match(webCss, /tracker-panel > header span \{ color: #fff/);
  assert.match(admin, /Preparar e imprimir cocina/);
  assert.match(admin, /Pedido listo/);
  assert.match(admin, /realtime\/stream/);
  assert.match(admin, /setSelectedOrder\(null\)/);
  assert.match(deliveryApi, /delivery_status = 'En camino',[\s\S]*status = 'En camino'/);
});
