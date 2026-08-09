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

test('la presentación de estados se comparte entre panel, delivery y seguimiento', () => {
  const projectsRoot = path.resolve(root, '..');
  const shared = fs.readFileSync(path.join(projectsRoot, 'distrito-shared', 'src', 'orderFlow.js'), 'utf8');
  const adminOrders = fs.readFileSync(path.join(projectsRoot, 'distrito-admin', 'src', 'pages', 'AdminPedidos.jsx'), 'utf8');
  const adminDashboard = fs.readFileSync(path.join(projectsRoot, 'distrito-admin', 'src', 'pages', 'AdminDashboard.jsx'), 'utf8');
  const deliveryCard = fs.readFileSync(path.join(projectsRoot, 'Distrito-delivery', 'src', 'components', 'OrderCard.jsx'), 'utf8');
  const webTracker = fs.readFileSync(path.join(projectsRoot, 'distrito-web', 'src', 'components', 'OrderTracker.jsx'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

  assert.match(shared, /Listo para despacho/);
  assert.match(shared, /En reparto/);
  assert.match(adminOrders, /orderStatusMeta/);
  assert.match(adminDashboard, /orderStatusMeta/);
  assert.match(deliveryCard, /deliveryStatusMeta/);
  assert.match(webTracker, /orderStatusMeta/);
  assert.match(server, /canTransitionOrder/);
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
  assert.match(server, /requireAdministrativeUser/);
  assert.match(server, /Esta cuenta no tiene acceso al panel administrativo/);
});

test('las vistas CRM no devuelven promesas como limpieza de React', () => {
  const marketing = fs.readFileSync(
    path.resolve(root, '..', 'distrito-admin', 'src', 'pages', 'crm', 'CrmMarketing.jsx'),
    'utf8',
  );
  assert.doesNotMatch(marketing, /useEffect\(load\s*,/);
  assert.match(marketing, /useEffect\(\(\)=>\{void load\(\);\},\[revision\]\)/);
});

test('el webhook de Meta usa la ruta CRM existente, HTTPS y secretos solo backend', () => {
  const crmApi = fs.readFileSync(path.join(root, 'crm_api.js'), 'utf8');
  const whatsapp = fs.readFileSync(path.join(root, 'src', 'whatsapp-cloud.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

  assert.match(crmApi, /app\.get\('\/api\/pedidos\/webhooks\/whatsapp'/);
  assert.match(crmApi, /app\.post\('\/api\/pedidos\/webhooks\/whatsapp'/);
  assert.match(crmApi, /WHATSAPP_WEBHOOK_HTTPS_REQUIRED/);
  assert.match(crmApi, /status:\s*'accepted'/);
  assert.match(crmApi, /payload_received/);
  assert.match(whatsapp, /env\.WHATSAPP_VERIFY_TOKEN\s*\|\|\s*env\.WHATSAPP_WEBHOOK_VERIFY_TOKEN/);
  assert.match(server, /req\.rawBody\s*=\s*Buffer\.from\(buffer\)/);
  for (const variable of ['WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID']) {
    assert.match(envExample, new RegExp(`^${variable}=`, 'm'));
    assert.doesNotMatch(envExample, new RegExp(`^VITE_${variable}=`, 'm'));
  }
});

test('el Release Android fija la API HTTPS y rechaza configuración local', () => {
  const deliveryRoot = path.resolve(root, '..', 'distrito-delivery');
  const environments = JSON.parse(fs.readFileSync(path.join(deliveryRoot, 'config', 'api-environments.json'), 'utf8'));
  const vite = fs.readFileSync(path.join(deliveryRoot, 'vite.config.mjs'), 'utf8');
  const capacitor = fs.readFileSync(path.join(deliveryRoot, 'capacitor.config.ts'), 'utf8');
  const gradle = fs.readFileSync(path.join(deliveryRoot, 'android', 'app', 'build.gradle'), 'utf8');
  const manifest = fs.readFileSync(path.join(deliveryRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  const plugin = fs.readFileSync(path.join(deliveryRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'distritobg', 'delivery', 'DeliveryLocationPlugin.java'), 'utf8');
  const service = fs.readFileSync(path.join(deliveryRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'distritobg', 'delivery', 'DeliveryLocationService.java'), 'utf8');
  assert.equal(environments.production.apiUrl, 'https://api.distritobg.app');
  assert.equal(environments.development.apiUrl, 'auto');
  assert.match(environments.androidDevelopment.apiUrl, /^http:\/\/10\.0\.2\.2:/);
  assert.match(vite, /productionUrl\.protocol !== 'https:'/);
  assert.match(vite, /productionUrl\.hostname !== 'api\.distritobg\.app'/);
  assert.match(capacitor, /hostname: development \? 'localhost' : 'delivery\.distritobg\.app'/);
  assert.match(capacitor, /allowMixedContent: development/);
  assert.match(gradle, /android-release-signing\.properties/);
  assert.match(gradle, /usesCleartextTraffic: "false"/);
  assert.match(manifest, /android:usesCleartextTraffic="\$\{usesCleartextTraffic\}"/);
  assert.match(plugin, /UNTRUSTED_API_URL/);
  assert.match(plugin, /BuildConfig\.PRODUCTION_API_URL/);
  assert.match(service, /setInstanceFollowRedirects\(false\)/);
});

test('delivery conserva PWA, capacidad por usuario, GPS global y aceptación atómica', () => {
  const projectsRoot = path.resolve(root, '..');
  const api = fs.readFileSync(path.join(root, 'delivery_api.js'), 'utf8');
  const orderService = fs.readFileSync(path.join(root, 'src', 'delivery-order-service.js'), 'utf8');
  const deliveryRoot = path.join(projectsRoot, 'distrito-delivery');
  const manifest = fs.readFileSync(path.join(deliveryRoot, 'public', 'manifest.webmanifest'), 'utf8');
  const serviceWorker = fs.readFileSync(path.join(deliveryRoot, 'public', 'sw.js'), 'utf8');
  const locationHook = fs.readFileSync(path.join(deliveryRoot, 'src', 'hooks', 'useDeliveryLocation.js'), 'utf8');
  const nativeHook = fs.readFileSync(path.join(deliveryRoot, 'src', 'hooks', 'useNativeDeliveryLocation.js'), 'utf8');
  const nativeService = fs.readFileSync(path.join(deliveryRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'distritobg', 'delivery', 'DeliveryLocationService.java'), 'utf8');
  const deliveryAuth = fs.readFileSync(path.join(deliveryRoot, 'src', 'context', 'AuthContext.jsx'), 'utf8');
  const deliveryLayout = fs.readFileSync(path.join(deliveryRoot, 'src', 'components', 'AppLayout.jsx'), 'utf8');
  const onboarding = fs.readFileSync(path.join(deliveryRoot, 'src', 'components', 'DeliveryOnboarding.jsx'), 'utf8');
  const orderDetail = fs.readFileSync(path.join(deliveryRoot, 'src', 'pages', 'OrderDetail.jsx'), 'utf8');
  const deliveryCss = fs.readFileSync(path.join(deliveryRoot, 'src', 'styles.css'), 'utf8');
  const deliveryApp = fs.readFileSync(path.join(deliveryRoot, 'src', 'App.jsx'), 'utf8');
  assert.match(manifest, /"display"\s*:\s*"standalone"/);
  assert.match(serviceWorker, /addEventListener\('push'/);
  assert.match(api, /DELIVERY_ROLES/);
  assert.match(api, /delivery_status = 'Pendiente'/);
  assert.match(api, /deliveryOrderService\.acceptOrder/);
  assert.match(api, /deliveryOrderService\.startDelivery/);
  assert.match(api, /max_active_orders/);
  assert.match(api, /\/delivery\/location\/batch/);
  assert.match(locationHook, /enqueueLocation/);
  assert.match(locationHook, /listQueuedLocations/);
  assert.match(locationHook, /arrivals/);
  assert.match(nativeHook, /startNativeLocation/);
  assert.match(nativeService, /START_STICKY/);
  assert.match(nativeService, /startForeground/);
  assert.match(nativeService, /store\.enqueue/);
  assert.doesNotMatch(deliveryAuth, /session_idle_minutes/);
  assert.match(deliveryAuth, /renewAccessToken/);
  assert.match(deliveryLayout, /distrito:new-order-alert/);
  assert.match(deliveryLayout, /DeliveryOnboarding/);
  assert.match(onboarding, /Instalar aplicación/);
  assert.match(onboarding, /Permitir ubicación/);
  assert.match(onboarding, /Activar sonido/);
  assert.match(deliveryCss, /height:100dvh/);
  assert.match(deliveryCss, /overflow-y:auto/);
  assert.match(deliveryApp, /pathname === '\/estadisticas'.*<Stats/s);
  assert.match(orderDetail, /data-testid="complete-delivery"/);
  assert.match(orderDetail, /LiveDeliveryMap/);
  assert.match(orderDetail, /withinCompletionRange/);
  assert.match(orderService, /GEOFENCE_OUTSIDE_RADIUS/);
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
  assert.match(server, /COALESCE\(delivery_cost, 0\)/);
  assert.match(server, /const orderTotal = normalized\.total \+ deliveryFee/);
  assert.match(server, /delivery_fee/);
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
  const orderMessages = fs.readFileSync(path.join(projectsRoot, 'distrito-shared', 'src', 'orderMessages.js'), 'utf8');
  assert.match(server, /tracking_token:\s*issueTrackingToken/);
  assert.match(web, /buildNewOrderWhatsAppMessage/);
  assert.match(web, /whatsappWindow\.location\.replace/);
  assert.match(orderMessages, /Rastrear pedido:/);
  assert.match(orderMessages, /encodeURIComponent/);
  assert.match(tracker, /Recorrido en vivo del domiciliario/);
  assert.match(webCss, /tracker-panel > header span \{ color: #fff/);
  assert.match(admin, /Preparar e imprimir cocina/);
  assert.match(admin, /Marcar listo para despacho/);
  assert.match(admin, /realtime\/stream/);
  assert.match(admin, /setSelectedOrder\(null\)/);
  assert.match(deliveryApi, /deliveryOrderService\.startDelivery/);
});

test('las entregas externas conservan costos, auditoría y seguimiento sin GPS simulado', () => {
  const projectsRoot = path.resolve(root, '..');
  const migration = fs.readFileSync(path.join(root, 'migrations', '014_external_delivery_companies.sql'), 'utf8');
  const externalApi = fs.readFileSync(path.join(root, 'external_delivery_api.js'), 'utf8');
  const tracking = fs.readFileSync(path.join(projectsRoot, 'distrito-web', 'src', 'components', 'OrderTracker.jsx'), 'utf8');
  const assignment = fs.readFileSync(path.join(projectsRoot, 'distrito-admin', 'src', 'components', 'DeliveryAssignmentModal.jsx'), 'utf8');
  const messages = fs.readFileSync(path.join(projectsRoot, 'distrito-shared', 'src', 'orderMessages.js'), 'utf8');
  assert.match(migration, /external_delivery_cost/);
  assert.match(migration, /pedidos_app_delivery_events/);
  assert.match(externalApi, /assign-external/);
  assert.match(externalApi, /external-handoff/);
  assert.match(externalApi, /external-complete/);
  assert.match(assignment, /Domiciliario Distrito BG/);
  assert.match(assignment, /Empresa externa/);
  assert.match(tracking, /!isExternalDelivery && hasDriverLocation/);
  assert.match(tracking, /no comparte GPS/);
  assert.match(messages, /operador logístico aliado/);
});
