# Contexto del proyecto — Tuti's POS

> Este archivo está escrito para que un asistente (Claude Code) retome el
> proyecto sin tener que reconstruir el contexto. Claude Code lo lee
> automáticamente al abrir esta carpeta.

## 1. El negocio

**Tuti's Frozen Yogurt** — heladería de yogurt griego con toppings (dulces,
maní, salsas, jaleas). Dueño: Samuel Martínez. Opera en **Honduras** con
**2 sucursales**: Tuti's Galerías y Tuti's Multiplaza. Moneda HNL. Existe la
posibilidad de abrir en Guatemala y El Salvador más adelante, por eso el
sistema es multimoneda y multipaís desde el diseño.

El modelo de precio es el corazón del sistema y no es obvio: **al cliente se le
cobra un precio único por gramo del peso total** (vaso + helado + toppings), sin
importar qué toppings eligió. Pero los toppings no cuestan lo mismo entre sí, así
que internamente el sistema calcula el costo real de cada componente y protege el
margen con un esquema de dos niveles:

- **Tier 1**: topping barato, cabe dentro del precio único.
- **Tier 2 (premium)**: topping caro (Nutella, dulces importados). Lleva un
  `surcharge_per_gram` adicional calculado para alcanzar la meta de margen.

La función `suggestToppingTier()` (en `web/app.js`) calcula qué tier y qué
recargo necesita cada topping dado el precio por gramo y la meta de margen.

### Requisitos originales del cliente (los 8)

1. Facturar.
2. Peso de helado.
3. Peso de toppings.
4. Control e inventario de vasos y cucharas.
5. Parametrización de toppings.
6. % de venta y costo de toppings.
7. Precio único por peso total, sabiendo que los toppings cuestan distinto.
8. Optimización costo-beneficio por peso, en gramos **y** onzas.

Todos están implementados. El 1 está implementado como "listo para conectar"
(ver sección 5).

## 2. Arquitectura actual

- **Base de datos**: Supabase (PostgreSQL), plan **gratuito**, en la cuenta
  `soporte@innova504.com` (NO en la cuenta `martinezsamuel9`, que está en plan de
  pago — el dueño pidió explícitamente no desplegar ahí).
- **Frontend**: HTML/CSS/JS plano, sin framework ni build. Publicado en
  **Cloudflare Workers (assets estáticos)** en **https://tutis.slabblu.com**,
  con HTTPS. Se abre en Chrome en cada mostrador. Desplegar: `npm run deploy`.
- **Sin backend propio**: el navegador habla directo con Supabase usando la
  llave `anon`. La seguridad la imponen las políticas RLS en la base.
- **PWA**: instalable en la tableta y abre sin internet (`sw.js` +
  `manifest.webmanifest`).

```
sql/01_schema.sql   tablas, enums, RLS, process_sale(), daily_closing()
sql/02_seed.sql     2 sucursales + catálogo de arranque
sql/pruebas/        pruebas de aislamiento (ver sección 6) — 11 pruebas
web/index.html      estructura y pestañas (sin scripts en línea: hay CSP)
web/app.js          toda la lógica (16 secciones numeradas)
web/styles.css      estilos, modo día/noche
web/config.js       credenciales — ÚNICO archivo que el dueño edita
web/sw.js           service worker: app shell offline
web/_headers        cabeceras de seguridad (CSP, etc.) que aplica Cloudflare
web/vendor/         SDK de Supabase servido localmente, NO desde CDN
wrangler.jsonc      despliegue + subdominio tutis.slabblu.com
```

### Decisiones que NO hay que deshacer

Cada una resuelve un problema concreto; revertirlas rompe algo:

1. **Las ventas entran SOLO por `process_sale(jsonb)`**, nunca con un INSERT
   directo. No existe política de INSERT sobre `sales` a propósito. La función
   es `SECURITY DEFINER` y hace tres cosas que un insert suelto no puede:
   registra la venta y descuenta inventario en una sola transacción; valida que
   el usuario pertenezca a esa sucursal; y permite que la cajera venda sin
   darle permiso de escritura sobre el inventario.

2. **`client_uuid` con UNIQUE = idempotencia.** El cliente genera ese UUID
   ANTES de intentar enviar. Si la cola offline reenvía la venta, la función
   detecta el duplicado y devuelve la original sin volver a descontar stock.
   Sin esto, una reconexión intermitente duplicaría ventas.

3. **Las funciones auxiliares de RLS (`app_role()`, `app_location_id()`,
   `can_access_location()`, `can_manage_location()`, `is_owner()`) son
   `SECURITY DEFINER`.** Es obligatorio: leen `profiles`, y si respetaran RLS
   las políticas de `profiles` que las invocan caerían en recursión infinita.

4. **El aislamiento vive en la base, no en la interfaz.** Ocultar pestañas es
   solo cosmético. Lo que realmente protege son las políticas RLS. Cualquier
   funcionalidad nueva debe respetar `location_id` en la tabla y su política.

5. **Fecha local, no UTC.** El cierre del día usa `UTC_OFFSET_HOURS` (-6). En
   JS, la fecha se arma con `localDateStr()` (componentes locales), NUNCA con
   `toISOString().slice(0,10)`, que da la fecha UTC. Ese bug ya ocurrió una vez:
   en UTC-6 las ventas de la tarde caían en el día equivocado.

6. **El SDK de Supabase se sirve desde `web/vendor/`, no desde un CDN.** Dos
   razones: el service worker no puede cachear lo que sirve otro dominio (y sin
   eso no hay modo offline real), y la CSP de `web/_headers` es `script-src
   'self'`, que prohíbe ejecutar código de terceros dentro de la caja. Por eso
   tampoco puede haber `<script>` ni `onclick=` dentro del HTML.

7. **Todo texto que venga de la base pasa por `esc()` antes de entrar a
   `innerHTML`.** Los nombres de toppings, sabores, sucursales y personas los
   escribe un humano; sin escapar, uno con `<` rompe la tabla y uno con mala
   intención ejecuta código en la pantalla del propietario.

8. **El folio se asigna bajo `pg_advisory_xact_lock` por sucursal**, y el par
   `(location_id, folio)` es único. Sin el candado, dos cajas de la misma
   tienda cobrando a la vez leían el mismo `max(folio)`.

9. **Aviso de monedas mezcladas.** Si el consolidado del propietario abarca
   sucursales con monedas distintas, se muestra una advertencia en vez de sumar
   lempiras con quetzales. Ver `mixedCurrencyWarning()`.

## 3. Roles y permisos

| Rol | Alcance | Puede |
|---|---|---|
| `cajera` | solo su sucursal | cobrar (vía RPC), ver catálogo |
| `gerente` | solo su sucursal | todo lo anterior + inventario, toppings, precios, reportes, configuración de SU tienda |
| `propietario` | todas | todo + crear sucursales + asignar roles y tiendas |

`profiles.location_id` es NULL solo para el propietario. Un usuario sin
sucursal asignada (y que no sea propietario) no puede entrar — es intencional,
para que nadie vea datos por accidente al registrarse.

**Regla dura del cliente**: Tuti's Galerías no ve NADA de Tuti's Multiplaza, y
viceversa. Solo el dueño ve ambas, y necesita reportes **por tienda**, no solo
consolidados.

## 4. Restricciones permanentes (pedidas explícitamente)

- **NUNCA incluir el sitio web `https://tutis.innova504.com/` en la factura o
  comprobante.** El dueño lo pidió dos veces, textual: "no lo agregues en la
  factura". Aplica a cualquier comprobante, recibo o impresión que se agregue
  en el futuro.
- **Todo el texto en Arial**, tanto en pantalla como en lo que se imprime.
- **Modo día y modo noche**, con la elección recordada en el navegador.
- En las tablas, guardar y eliminar van con **iconos** (disquete y papelera),
  no con texto.
- La pantalla de venta debe mostrar **peso de helado, peso de toppings, peso de
  recipiente (vaso) y peso total**. El peso de toppings se calcula como
  `peso total − peso de helado − tara` cuando se usa la báscula para el total,
  y ahí se avisa si no cuadra con lo registrado topping por topping.
- Se maneja **gramos y onzas** en todos los campos de peso (`OZ_TO_G = 28.349523125`).

## 5. Estado de la facturación

Ningún software puede emitir por sí solo una factura fiscalmente válida: hace
falta que el negocio esté inscrito ante la autoridad de cada país y conectado a
un proveedor certificado (SAT/FEL en Guatemala, Hacienda/DTE en El Salvador,
SAR/CAI en Honduras).

Hoy cada venta genera un **comprobante interno** con todos los campos legales
del país de esa sucursal, marcado claramente como **no fiscal**. Está diseñado
para conectar el proveedor real sin rehacer el sistema. No inventar folios
fiscales ni simular validez fiscal: el dueño aceptó explícitamente este enfoque.

## 6. Cómo probar los cambios

Todo lo entregado fue verificado antes de entregarse. Si tocas el esquema o las
políticas, vuelve a correr las pruebas.

### SQL (PostgreSQL local, sin tocar producción)

```bash
export PGBIN=/usr/lib/postgresql/16/bin   # o el que tengas
$PGBIN/initdb -D /tmp/pg/data -U postgres --auth=trust
$PGBIN/pg_ctl -D /tmp/pg/data -o '-p 5433 -k /tmp/pg' start
psql -h /tmp/pg -p 5433 -U postgres -f sql/pruebas/00_simulacion_supabase.sql
psql -h /tmp/pg -p 5433 -U postgres -f sql/01_schema.sql
psql -h /tmp/pg -p 5433 -U postgres -f sql/02_seed.sql
psql -h /tmp/pg -p 5433 -U postgres -f sql/pruebas/prueba_aislamiento.sql
```

`00_simulacion_supabase.sql` recrea lo que Supabase ya trae (schema `auth`,
tabla `auth.users`, función `auth.uid()`, roles `anon`/`authenticated`), para
poder probar RLS localmente. En las pruebas, se simula a cada usuario con
`set role authenticated; set request.jwt.claim.sub = '<uuid>';`.

Resultados esperados: 1 sucursal visible para la cajera, 2 para el propietario,
0 filas modificadas al intentar cambiar precios como cajera, venta que descuenta
stock solo en su tienda, reenvío que no duplica, y rechazo al intentar operar en
otra sucursal aun conociendo su UUID.

### Frontend (sin servidor real)

Hay pruebas con Playwright que interceptan `config.js` y el SDK de Supabase con
un doble en memoria, y manejan la app de punta a punta: entrada por rol, cálculo
del ticket, cobro con internet, cobro sin internet (verificando la cola local),
y el tema. Se levantan con `node` + `playwright` apuntando a
`file://.../web/index.html`. Lo esencial que deben seguir cumpliendo:

- Una cajera ve solo la pestaña Venta; el propietario ve las 6.
- 150g helado + 30g topping + vaso de 15g a 0.45/g = **HNL 87.75**.
- Al cobrar sin conexión: el recibo igual se muestra, avisa que quedó
  pendiente, y la venta queda en `localStorage` bajo `tutis_pending_sales`.
- El recibo NO contiene ningún enlace al sitio web.

## 7. Pendientes, en orden de valor

1. **Envío automático del cierre por correo a una hora fija.** Hoy el botón
   "Enviar por correo" abre el cliente de correo con el reporte ya escrito
   (`mailto:`), y el usuario confirma. Para que salga solo, sin intervención:
   Supabase Edge Function + pg_cron, llamando a `daily_closing()` por cada
   sucursal y enviando con un servicio de correo (Resend o similar). El dueño
   quiere **un reporte por tienda**, no solo el consolidado. El contenido
   requerido: cantidad de vasos, cantidad de cucharas, peso vendido de helado,
   peso vendido de toppings, y el cuadro de cada topping vendido con su %.
2. **Afinar el lector de báscula** al modelo que compren. Todavía no la tienen.
   Se les recomendó Torrey/CAS/OHAUS con salida serial continua ("PC mode").
   El lector actual (`web/app.js`, sección 14, Web Serial) es tolerante: toma el
   primer número de cada línea. Requiere Chrome/Edge + HTTPS; no funciona en
   Safari ni iPad.
3. **Conectar el proveedor de facturación** cuando exista el registro fiscal.
4. **Respaldos**: el plan gratuito tiene retención limitada. Si el negocio
   crece, conviene subir de plan o exportar ventas periódicamente.

## 8. Historial: qué se descartó y por qué

- Primero se construyó un **sistema de escritorio** (Flask + SQLite, entregado
  como `heladeria-app.zip`), cuando el plan era una sola tienda sin nube. Quedó
  **superado** por esta versión web al aparecer la segunda sucursal: sincronizar
  dos SQLite separadas es más frágil que una sola base compartida. Si te pasan
  ese zip, es contexto histórico, no el sistema vigente. Lo único que sobrevive
  de ahí es el motor de precios, que se portó a `web/app.js`.
- También existe un **artifact de Claude** ("Meli POS") que sirvió como
  prototipo interactivo para afinar el diseño con el dueño. No es el sistema
  real: no puede hablar con Supabase ni con hardware.

## 9. Cómo hablarle al dueño

Samuel es ingeniero en sistemas y trabaja en seguridad bancaria; entiende bien
lo técnico y agradece que se le digan los límites reales en vez de promesas.
Prefiere español. Cuando algo no se puede hacer (facturación fiscal, envío
automático sin servidor, leer básculas desde un sandbox), decirlo directo y
ofrecer la alternativa honesta — ese ha sido el patrón de todo el proyecto.
