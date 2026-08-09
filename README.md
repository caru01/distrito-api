# Distrito BG API

Backend HTTP de Distrito BG. Centraliza acceso a PostgreSQL, autenticación,
catálogo, pedidos, inventario, contabilidad, configuración y seguridad.

Consulta también [ARCHITECTURE.md](ARCHITECTURE.md) para las reglas de diseño que
deben conservarse al implementar cambios.

## Tecnologías

- Node.js y Express 4.
- PostgreSQL/Neon mediante `pg`.
- JWT y `bcryptjs` para autenticación.
- Helmet, CORS, compresión y límites de solicitudes.
- Web Push mediante VAPID.
- SMTP mediante Nodemailer para recuperación de contraseña.
- WhatsApp Business Platform / Cloud API oficial de Meta.
- Outbox transaccional, PostgreSQL `LISTEN/NOTIFY` y SSE recuperable.
- Tests nativos de Node.js.

## Preparación local

```powershell
Copy-Item .env.example .env
npm ci
npm run migrate
npm start
```

La API usa `PORT=3001` como valor documentado para desarrollo. El proveedor de
despliegue puede inyectar otro puerto.

## Variables de entorno

| Variable | Uso |
| --- | --- |
| `DATABASE_URL` | Cadena de conexión PostgreSQL/Neon |
| `DB_POOL_MAX` | Máximo de conexiones del pool |
| `DB_IDLE_TIMEOUT_MS` | Tiempo antes de liberar una conexión inactiva |
| `DB_CONNECT_TIMEOUT_MS` | Tiempo máximo de conexión |
| `JWT_SECRET` | Firma de tokens de acceso y renovación |
| `VAPID_PUBLIC_KEY` | Clave pública para notificaciones web |
| `VAPID_PRIVATE_KEY` | Clave privada para notificaciones web |
| `VAPID_EMAIL` | Contacto VAPID en formato `mailto:` |
| `EMAIL_USER` | Usuario SMTP |
| `EMAIL_PASS` | Credencial SMTP |
| `PORT` | Puerto HTTP |
| `CORS_ORIGINS` | Orígenes adicionales separados por coma para pruebas por IP |
| `OPEN_FOOD_FACTS_USER_AGENT` | Identificación de la consulta opcional de códigos de barras |
| `WHATSAPP_VERIFY_TOKEN` | Token privado elegido para verificar el webhook (`WHATSAPP_WEBHOOK_VERIFY_TOKEN` queda como alias temporal) |
| `WHATSAPP_ACCESS_TOKEN` | Token privado del usuario del sistema de Meta |
| `WHATSAPP_PHONE_NUMBER_ID` | Identificador del número emisor |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Identificador de la cuenta WhatsApp Business |
| `WHATSAPP_APP_SECRET` | Secreto usado para validar la firma del webhook |
| `WHATSAPP_GRAPH_API_VERSION` | Versión habilitada de Graph API, con formato `vNN.N` |
| `WHATSAPP_WEBHOOK_LOG_PAYLOAD` | Registro temporal del payload válido; usar `false` después de verificar la integración |
| `CRM_WEBHOOK_RETENTION_DAYS` | Retención de cuerpos de webhook procesados |
| `CRM_JOB_RETENTION_DAYS` | Retención de trabajos de envío terminados |

`src/db.js` carga `.env` y crea el pool usado por servidor, migraciones, pruebas y
scripts de diagnóstico. No se deben instanciar pools adicionales ni copiar cadenas
de conexión a otros archivos.

## Comandos

| Comando | Función |
| --- | --- |
| `npm start` | Inicia la API |
| `npm run check` | Comprueba sintaxis de `server.js` y horarios |
| `npm test` | Ejecuta contratos y flujos transaccionales |
| `npm run migrate` | Aplica migraciones SQL pendientes |
| `npm run db:analyze` | Ejecuta `VACUUM ANALYZE` sobre tablas críticas |
| `npm run db:prune` | Aplica retención a GPS, eventos y datos operativos CRM |
| `npm run db:prune-delivery` | Alias compatible del comando anterior |

Scripts de lectura disponibles en `scripts/`:

- `check-db.js`: conectividad e información general.
- `check-schema.js`: columnas y estructura observada.
- `check-tables.js`: inventario de tablas.
- `check-products.js`: muestra una muestra pequeña del catálogo.

## Estructura

```text
distrito-api/
├── server.js                 # Entrada HTTP y reglas de negocio actuales
├── horarios_api.js           # Estado y administración de horarios
├── delivery_api.js           # Domiciliarios propios, GPS, capacidad y tiempo real
├── external_delivery_api.js  # Empresas aliadas y flujo externo manual
├── crm_api.js                # CRM, Inbox, segmentos, campañas y reportes
├── src/db.js                 # Única fábrica de conexiones PostgreSQL
├── src/dashboard.js          # Agregación optimizada del resumen operativo
├── src/delivery-domain.js    # Máquina de estados logística
├── src/delivery-geo.js       # Distancia y geocerca autoritativa
├── src/delivery-order-service.js # Operaciones transaccionales e idempotentes
├── src/delivery-location-service.js # Ingestión GPS normalizada
├── src/outbox.js             # Publicación multiinstancia de eventos
├── src/crm-service.js        # Webhooks, cola, estados, automatizaciones y atribución
├── src/whatsapp-cloud.js     # Cliente oficial Graph API y firma HMAC
├── src/crm/                  # Teléfono, clasificación y segmentos seguros
├── migrations/               # Fuente de verdad del esquema
├── scripts/migrate.js        # Ejecutor transaccional de migraciones
├── scripts/analyze-db.js     # Mantenimiento de estadísticas
├── test/                     # Contratos y pruebas de flujos
├── ARCHITECTURE.md           # Decisiones de arquitectura
└── .env.example              # Contrato de configuración sin secretos
```

## Contrato de URL

Todas las rutas usan el prefijo:

```text
/api/pedidos
```

Los frontends configuran únicamente el origen mediante `VITE_API_URL`. Por ejemplo,
si el origen es `http://localhost:3001`, el cliente construye
`http://localhost:3001/api/pedidos`.

## Rutas públicas principales

| Método y ruta | Función |
| --- | --- |
| `GET /health` | PostgreSQL, migraciones, outbox, SSE, GPS y turnos activos |
| `GET /init` | Catálogo activo, categorías, configuración y anuncio |
| `GET /horarios/status` | Determina si se pueden recibir pedidos |
| `POST /checkout` | Valida productos y crea un pedido con total calculado |
| `GET /track/:id?phone=` | Seguimiento limitado por pedido y teléfono |
| `POST /rate` | Registra una calificación de producto |
| `POST /push/subscribe` | Registra una suscripción Web Push |
| `GET /announcement` | Obtiene el anuncio público actual |
| `GET /media/products/:id` | Entrega la imagen cacheable de un producto |
| `GET /media/announcements/:id` | Entrega la imagen cacheable de un anuncio |

Las rutas anteriores se muestran sin el prefijo `/api/pedidos` para facilitar la
lectura.

## Rutas administrativas

Todas requieren autenticación, salvo login y recuperación de contraseña.

| Dominio | Rutas y funciones |
| --- | --- |
| Autenticación | Login, refresh, logout, verificación y restablecimiento de contraseña |
| Dashboard | `GET /admin/dashboard`: métricas del día, catálogo, inventario, últimos pedidos y productos solicitados |
| Pedidos | Listado, cambio de estado validado y edición transaccional |
| Clientes | Fichas históricas enlazadas al contacto CRM canónico |
| CRM | Dashboard, contactos, Inbox, segmentos, campañas, automatizaciones, reportes y configuración WhatsApp |
| Catálogo | CRUD de categorías y productos |
| Configuración | Identidad, domicilio, cocina, temas y preferencias de voz/idioma mediante una lista permitida de campos |
| Horarios | Semana regular, configuración y excepciones por fecha |
| Inventario | Stock, umbral, costo, código de barras y movimientos por producto |
| Contabilidad | Gastos, reportes por rango con comparativo, vista previa de cierre, cierre y reapertura |
| Comunicación | Campaña programada, frecuencia, CTA, imagen y envío de notificaciones Push |
| Domicilios | Capacidad propia, mapa operativo, empresas externas, costos separados y trazabilidad |
| Seguridad | Perfil, sesiones, auditoría, usuarios, roles y permisos |

El CRUD de usuarios, roles y permisos aplica comprobaciones `módulo:acción` en el
servidor. Una frontera adicional consulta el rol real y bloquea cuentas de reparto
en el prefijo administrativo; solo se permite leer Configuración para aplicar el
tema de Delivery. La autorización fina del resto de rutas se detalla como trabajo
pendiente en `../distrito-docs/AUDITORIA_FUNCIONAL_2026-08-09.md`.

El dashboard usa una consulta agregada con CTE para evitar que el navegador tenga
que descargar pedidos, productos e inventario completos. El estado del horario se
obtiene mediante la misma función usada por `/horarios/status`, por lo que no se
duplica la lógica que determina si la tienda está abierta.

`GET /admin/reports?from=AAAA-MM-DD&to=AAAA-MM-DD` limita el rango a 366 días,
consulta pedidos y compras mediante índices de fecha, calcula tendencias contra el
periodo anterior y devuelve alertas reales de stock. Las fechas de la interfaz se
interpretan con la zona `America/Bogota`.

El anuncio público solo se devuelve durante su vigencia y contiene `is_visible`, calculado por la API a partir de
`is_active`, `starts_at` y `ends_at`. La tienda no replica esa regla: solo aplica la
frecuencia configurada (`always`, `session` o `daily`) como preferencia local del
dispositivo.

## Creación y edición de pedidos

El frontend no envía títulos, precios ni totales como valores confiables. Envía:

```json
{
  "cart": [
    { "id": "uuid-del-producto", "quantity": 2 }
  ]
}
```

`normalizeOrderCart` valida cantidades, consulta los productos, toma los precios
vigentes y produce el total. El carrito persistido conserva solamente:

- `id`
- `title`
- `price`
- `category`
- `quantity`

Para `domicilio`, la misma transacción lee `settings.delivery_cost`, lo guarda en
`delivery_fee` y suma el valor al total. La tienda y Tomar pedido muestran una
estimación, pero reemplazan sus cifras por `subtotal`, `delivery_fee` y `total`
devueltos por la API.

La edición completa usa `/admin/orders/:id/edit`. La ruta
`/admin/orders/:id` está reservada para cambios de estado válidos. La máquina de
estados vive en `src/order-rules.js`, admite operaciones idempotentes y rechaza
saltos o reaperturas de estados terminales con
`409 INVALID_ORDER_TRANSITION`.

Los estados de operador externo solo se modifican mediante
`external_delivery_api.js`; la ruta genérica de estado los rechaza para impedir
pedidos sin empresa, costo o auditoría. El contrato completo está documentado en
`../distrito-docs/ENTREGAS_EXTERNAS.md`.

La creación y edición completa comparten `normalizeDeliveryLocation`: para un
domicilio guardan juntas latitud/longitud, Place ID, referencia, indicador de
marcador ajustado, apartamento, torre y piso. Cambiar a recoger/presencial limpia
esos campos y el costo de domicilio en la misma actualización.

## Inventario directo por producto

Al confirmar un checkout:

1. Se valida el horario colombiano y el carrito.
2. Se crea el pedido dentro de una transacción.
3. Se bloquean y descuentan productos con `track_stock=true`.
4. Se registra un movimiento relacionado con el pedido.
5. Si falta stock, todo se revierte y el pedido no existe.

Cancelar, editar o eliminar reconcilia el stock en la misma transacción. Las tablas
antiguas de ingredientes, rendimientos, recetas y lotes permanecen como histórico,
pero no participan en pedidos nuevos.

`GET /admin/products/lookup-barcode/:code` consulta manualmente Open Food Facts con
caché y límite de solicitudes. La respuesta es orientativa; el catálogo local y su
precio continúan siendo la fuente de verdad.

## Medios e impacto en rendimiento

Las imágenes existentes permanecen en PostgreSQL para conservar compatibilidad,
pero la API ya no las incluye como Base64 dentro de respuestas JSON grandes. Los
endpoints `/media/*` decodifican y entregan el contenido binario con caché HTTP.

El checkout tampoco copia imágenes al carrito. La migración
`002_compact_order_cart.sql` compactó los pedidos históricos. Resultado medido:

- 234 pedidos durante la auditoría del 9 de agosto de 2026.
- Carrito promedio cercano a 160 bytes.
- Tabla de pedidos cercana a 1.6 MB.
- Tablas `pedidos_app_*` cercanas a 25 MB.
- 17 índices operativos creados por la migración base.

## Migraciones

Migraciones actuales:

1. `001_align_schema.sql`: esquema, relaciones, restricciones, índices y catálogos
   de roles/permisos.
2. `002_compact_order_cart.sql`: elimina datos repetidos de carritos históricos.
3. `003_align_administrator_permissions.sql`: alinea permisos administrativos.
4. `004_robust_ordering.sql`: sesiones por dispositivo, stock de producto, temas,
   movimientos, códigos de barras e índices de seguimiento.
5. `005_announcement_campaigns.sql`: contenido y programación de campañas, CTA,
   frecuencia de visualización e índices de anuncios y compras.
6. `006_delivery_operations.sql`: rol y permisos de domicilios, perfil del
   repartidor, estados y tiempos de entrega, muestras GPS, push por usuario e
   índices parciales para la cola operativa.
7. `007_delivery_guards_and_retention.sql`: guardia histórica de una entrega por
   domiciliario e índice cronológico para depurar GPS. La guardia fue reemplazada
   por el cupo configurable en la migración 010; el índice de retención permanece.
8. `008_order_delivery_geolocation.sql`: coordenadas de destino, Google Place ID,
   confirmación ajustada y datos de apartamento, torre y piso en el pedido.
9. `009_restaurant_geolocation.sql`: punto geográfico central del restaurante,
   validado por rango y reutilizado por los mapas público y administrativo.
10. `010_delivery_capacity_and_kitchen.sql`: cupo configurable de uno a cinco
    pedidos por domiciliario, retiro de la antigua unicidad de una entrega y
    dirección/Place ID de la cocina como punto de salida.
11. `011_delivery_completion_geofence.sql`: radio central de 50 a 500 metros para
    validar por GPS cuándo el domiciliario puede finalizar una entrega.
12. `012_notification_preferences.sql`: idioma y estilo de voz centralizados para
    los avisos de pedidos del ERP y Delivery.
13. `013_branding_campaigns_customers_closures.sql`: identidad visual por
    superficie, campañas completas, CRM de clientes y cierres contables
    conciliados.
14. `014_external_delivery_companies.sql`: catálogo, costos y trazabilidad de
    empresas externas de reparto.
15. `015_delivery_professional_core.sql`: versión de pedido, turnos, presencia,
    dispositivo GPS oficial, modos de rastreo, lotes normalizados, idempotencia,
    geocerca excepcional, evidencia separada y outbox transaccional.
16. `016_delivery_runtime_settings.sql`: capacidad predeterminada e intervalos
    centrales de reconexión SSE.
17. `017_delivery_native_bootstrap.sql`: intercambio de un solo uso para que el
    servicio Android obtenga un token GPS limitado sin exponerlo a JavaScript.
18. `018_crm_foundation.sql`: contacto canónico E.164, consentimiento,
    conversaciones, mensajes, timeline y backfill no destructivo.
19. `019_crm_commercial.sql`: segmentos, plantillas, campañas, cola,
    automatizaciones, estados del proveedor y atribución.
20. `020_crm_normalization_and_integrity.sql`: paridad entre normalización SQL y
    Node.js para marcación internacional.
21. `021_crm_search_indexes.sql`: índices GIN/trigram para búsquedas parciales del
    directorio CRM.
22. `022_crm_acquisition_source.sql`: recupera la fuente de adquisición desde el
    primer pedido y la conserva al sincronizar órdenes nuevas.

Para cambiar el esquema:

1. Crea la siguiente migración correlativa, por ejemplo `023_descripcion.sql`.
2. Escribe una migración reejecutable cuando sea posible.
3. Ejecuta `npm run migrate` contra la base configurada.
4. Ejecuta `npm test` y `npm run check`.
5. No modifiques archivos ya aplicados: el ejecutor valida su checksum.

Las migraciones se ejecutan bajo bloqueo asesor y transacción. El registro está en
`pedidos_app_schema_migrations`.

## Seguridad

- No existe un endpoint público para crear el esquema o un administrador inicial.
- No hay contraseñas ni claves privadas predeterminadas en el código versionado.
- Las sesiones se validan en PostgreSQL y fallan de forma cerrada si no pueden
  verificarse.
- Los intentos de login tienen límite y bloqueo temporal.
- Los tokens de acceso tienen duración corta y se renuevan contra un usuario activo.
- Cada usuario admite como máximo tres sesiones. Administración caduca por
  inactividad; los roles `Domiciliario` y `Repartidor` están exentos para poder
  esperar pedidos, pero conservan cierre remoto/manual y expiración absoluta.
- La configuración solo permite campos declarados en `SETTINGS_FIELDS`.
- Checkout y autenticación cuentan con rate limiting.
- Las coordenadas se validan por rango y PostgreSQL exige latitud/longitud juntas.
- Las cuentas Domiciliario/Repartidor reciben `403` al intentar consumir módulos
  del ERP, aunque su JWT sea válido.
- Solo un dispositivo por turno es el emisor GPS oficial. El token nativo tiene
  alcance exclusivo de ubicación, duración limitada y se obtiene con un código de
  un solo uso de 90 segundos.
- Las operaciones críticas exigen identidad de dispositivo e idempotencia; el
  servidor usa bloqueos de fila y control de versión para resolver carreras.
- La geocerca, la vigencia y la precisión del GPS se validan nuevamente en la API.
  Una excepción requiere permiso específico, motivo y registro auditable.
- Las evidencias se validan por formato, firma y tamaño, y no forman parte del JSON
  de la orden.
- Los logs estructurados contienen `request_id` y contexto operativo, pero nunca
  tokens ni cuerpos de solicitudes.
- Las transiciones comerciales se validan contra `src/order-rules.js`; Entregado,
  Completado y Cancelado son terminales.
- El cálculo del domicilio usa un valor numérico leído de Configuración antes del
  `INSERT`, evitando expresiones SQL ambiguas y errores de inferencia de parámetros.

## Pruebas

`npm test` valida actualmente:

- Columnas, tablas y migraciones requeridas en la base configurada.
- Compatibilidad de UUID entre compras, lotes y movimientos.
- Escrituras parametrizadas de horarios dentro de transacciones revertidas.
- Ausencia de DDL y `/setup` en el servidor.
- Pool PostgreSQL único.
- Prefijo de API único en ambos frontends.
- Ausencia de módulos administrativos en la tienda pública.
- Presentación centralizada de estados y ruta funcional de Estadísticas Delivery.
- Reglas permitidas y prohibidas de transición de pedidos.
- Frontera de acceso administrativo para roles de reparto.
- Carreras entre dos conductores por el mismo pedido.
- Carreras por capacidad y entre reserva administrativa/aceptación.
- Repetición idempotente de aceptar, iniciar y completar.
- Matriz de geocerca, antigüedad y precisión GPS.
- Duplicados en lotes de ubicación.
- Normalización E.164, clasificación CRM y segmentos parametrizados.
- Consentimiento, frequency cap, atribución y rollback de flujos CRM.
- Webhook firmado, rechazo de firmas inválidas e idempotencia HTTP.
- Estados de Meta fuera de orden y permisos separados para leer, enviar y exportar.

Las pruebas de flujo abren transacciones y hacen `ROLLBACK`; no deben dejar datos de
prueba persistidos.

## Lista de comprobación para despliegue

1. Configurar las variables de `.env.example` en el proveedor.
2. Ejecutar `npm ci`.
3. Ejecutar `npm run migrate` una sola vez por versión.
4. Ejecutar `npm run check` y `npm test`.
5. Iniciar con `npm start`.
6. Consultar `/api/pedidos/health`.
7. Verificar catálogo, medios y estado de horarios desde el frontend.

## Operación de domicilios

`delivery_api.js` registra la API especializada sin duplicar autenticación ni acceso
a datos. Reutiliza `authenticateToken`, `requirePermission`, el pool central y las
claves VAPID configuradas en `server.js`. Las mutaciones se delegan a
`DeliveryOrderService`; la ruta HTTP no implementa otra máquina de estados.

- `POST /delivery/shift/start|heartbeat|transfer-device|end` administra turno,
  presencia y propiedad del GPS independientemente de la sesión web.
- `GET /delivery/orders/available` devuelve una proyección mínima de domicilios en
  `Listo/Pendiente`; teléfono, pago, referencia, notas e ítems quedan fuera hasta
  que el usuario sea responsable.
- `POST /delivery/orders/:id/accept` bloquea perfil y orden, cuenta compromisos y
  avanza a `Aceptado`. Dos repartidores nunca aceptan el mismo pedido ni superan el
  cupo por solicitudes concurrentes.
- `POST /delivery/orders/:id/pickup` inicia el recorrido y sincroniza estado
  comercial/logístico a `En camino`.
- `POST /delivery/location/batch` y su variante nativa reciben posiciones por
  conductor/dispositivo, deduplican y determinan el modo `FREE` o `DELIVERY`.
- `POST /delivery/orders/:id/complete` exige recepción confirmada y sincroniza el
  ERP a `Entregado` después de validar la geocerca en servidor.
- `GET /realtime/stream` mantiene SSE autenticado con ID, replay y resincronización.
- `GET /track/:id` y su stream autorizan por pedido/teléfono o por un JWT exclusivo
  de seguimiento. El token dura como máximo 48 horas, no concede acceso al ERP y
  finaliza 15 minutos después de entregar o cancelar. La ubicación se oculta fuera
  de `En camino` y se descartan coordenadas anteriores a la aceptación actual. La
  respuesta incluye punto de la cocina, destino, último GPS y hasta 120 muestras
  cronológicas del recorrido actual.
- `GET /delivery/orders/current` devuelve todas las entregas vigentes y el cupo
  actual del usuario. Una entrega finalizada solo marca al perfil `Libre` cuando ya
  no conserva otros pedidos activos.
- `POST /admin/orders/:id/tracking-token` permite regenerar un enlace vigente para
  el contacto administrativo por WhatsApp.
- `/admin/delivery/overview` y `/admin/delivery/orders/:id/assign` alimentan el
  Mapa de Domicilios y requieren permisos del módulo `Domicilios`. El overview
  entrega una sola coordenada de sede desde Configuración y la ubicación vigente
  de cada perfil; la conexión se calcula por turno y heartbeat, no solo por GPS.
  La asignación reserva capacidad y vuelve a validar todo con bloqueos de fila.
- Admin dispone de fin de turno forzado, excepción de geocerca de un solo uso y
  lectura protegida de evidencia mediante permisos diferenciados.

Cada checkout confirmado publica `order_created` por SSE. El ERP usa ese evento
para el aviso global “Nuevo Pedido”; Delivery recibe `order_available` cuando la
cocina marca la orden como `Listo`.

Cada mutación crítica inserta un evento de dominio dentro de su propia transacción.
El dispatcher usa `FOR UPDATE SKIP LOCKED`, un cursor incremental por instancia y
PostgreSQL `LISTEN/NOTIFY` como acelerador. Esto también funciona con poolers que no
propagan notificaciones: cada instancia lee los eventos nuevos del log compartido.
El cliente usa `Last-Event-ID` y REST para recuperar estado al reconectar.

Programa `npm run db:prune` diariamente o semanalmente. El script aplica la
retención configurada a puntos normalizados y heredados, claves de idempotencia,
eventos publicados, cuerpos de webhook y trabajos CRM finalizados; después
actualiza estadísticas. La cola offline del cliente es independiente y está
acotada por Configuración.

La arquitectura y activación operativa del canal oficial están documentadas en
[`../distrito-docs/CRM_WHATSAPP_2026-08-09.md`](../distrito-docs/CRM_WHATSAPP_2026-08-09.md).

## Personalización, campañas, clientes y cierres

La migración `013_branding_campaigns_customers_closures.sql` agrega:

- identidad visual y contenido por superficie (`web_*`, `admin_*`, `delivery_*`),
  con rutas de medios que entregan cada logo y usan el logo general como respaldo;
- campañas múltiples con prioridad, audiencia, formato, cupón, vistas y clics;
- perfil CRM de clientes sincronizado al insertar o actualizar pedidos;
- conciliación de efectivo, conteos, notas y auditoría de reapertura en cierres.

Rutas principales:

| Ruta | Función |
| --- | --- |
| `GET/POST /admin/announcements` | Lista y crea campañas |
| `PUT/DELETE /admin/announcements/:id` | Edita o elimina una campaña |
| `POST /announcements/:id/view|click` | Registra resultados sin datos personales |
| `GET/POST /admin/customers` | Directorio paginado y alta manual |
| `GET/PUT /admin/customers/:id` | Perfil, métricas e historial / edición |
| `POST /admin/customers/:id/contact` | Registra la última gestión de contacto |
| `GET /admin/closures/preview` | Recalcula el período en servidor |
| `POST /admin/closures` | Crea un cierre transaccional sin solapamientos |
| `PUT /admin/closures/:id/reopen` | Reabre exigiendo motivo |

Los campos históricos `total_orders` y `total_spent` de clientes no se usan para
reportar: los indicadores se agregan desde `pedidos_app_orders`, que sigue siendo
la fuente única de ventas. El cliente enviado por el navegador nunca puede fijar
los totales de un cierre; la API vuelve a calcularlos dentro de la transacción.
