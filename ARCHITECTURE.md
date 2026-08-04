# Arquitectura de Distrito BG

## Fuentes de verdad

- `distrito-web` contiene únicamente la tienda pública.
- `distrito-admin` contiene únicamente el panel autenticado.
- `Distrito-delivery` contiene únicamente la PWA de los domiciliarios.
- `distrito-api` concentra reglas de negocio y acceso a PostgreSQL.
- `distrito-shared` concentra componentes visuales que deben comportarse igual en
  más de una aplicación; actualmente contiene el selector exacto de entrega.
- `distrito-api/migrations` es la única fuente de verdad del esquema de base de datos.
- `VITE_API_URL` siempre representa el origen de la API, sin `/api/pedidos` al final.
- `src/config/api.js` agrega el prefijo `/api/pedidos` en cada frontend.

No deben agregarse sentencias `CREATE TABLE` o `ALTER TABLE` al servidor ni a scripts
independientes. Todo cambio de esquema se agrega como una migración SQL nueva e
inmutable y se aplica con `npm run migrate`.

## Flujo principal

1. Web consulta catálogo, configuración, anuncio y horarios en la API.
2. La API entrega URLs de medios cacheables en lugar de imágenes Base64 dentro del JSON.
3. Web o Admin confirman el destino con el mismo componente de Google Places y
   envían el carrito mínimo junto con dirección, coordenadas, Place ID y detalles
   complementarios del domicilio.
4. La API valida el horario en `America/Bogota`, recupera precios y reserva stock en una sola transacción.
5. Web sigue el pedido con el identificador confirmado y el teléfono del cliente.
6. Admin gestiona pedidos, productos, stock, contabilidad, configuración y seguridad sobre la misma API.
7. Delivery consume pedidos `Listo`, acepta de forma atómica, comparte GPS durante
   `En camino` y confirma la entrega; los eventos SSE actualizan admin y cliente.

## Base de datos

Los productos usan UUID. Pedidos, usuarios, roles y sesiones conservan identificadores
enteros. `pedidos_app_product_stock_movements` relaciona cada variación de stock con
el producto y, cuando corresponde, con el pedido. Las tablas antiguas de ingredientes,
recetas y lotes se conservan únicamente como histórico y no participan en el flujo vigente.

Las credenciales permanecen exclusivamente en `.env`. Los scripts de diagnóstico y
migración usan `src/db.js`; no deben incluir cadenas de conexión propias.

La clave de navegador de Google Maps es visible en el bundle por definición, pero
su valor local se lee desde un solo `.env` ignorado por Git y debe protegerse con
restricciones de referente y de API en Google Cloud. Nunca se usan variables
`VITE_*` para credenciales de PostgreSQL, JWT, SMTP o VAPID privado.

El reparto amplía `pedidos_app_orders` con responsable, `delivery_status` y marcas
de tiempo. La misma orden guarda el destino confirmado en
`delivery_latitude`/`delivery_longitude`, mientras `delivery_place_id` conserva la
referencia de Google; esa orden es la única fuente para la navegación del
domiciliario. La presencia actual se almacena en `pedidos_app_delivery_profiles`. El
histórico GPS está separado en `pedidos_app_delivery_locations`, con índices por
pedido/usuario y tiempo. `status` continúa siendo el estado comercial del ERP;
`delivery_status` es la máquina de estados logística. Esta separación evita que
cocina, ventas y reparto dupliquen o contradigan la misma regla.

## Operación

```text
npm run migrate     # aplica migraciones pendientes
npm run db:analyze  # actualiza estadísticas de las tablas de mayor uso
npm test            # valida el contrato del esquema
npm run check       # valida sintaxis de la API
```
