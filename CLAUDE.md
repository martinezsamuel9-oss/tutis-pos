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
sql/03_dashboard.sql tabla de gastos + dashboard_summary()
sql/04_logo_y_unidades.sql  logo por sucursal + unidad de peso preferida
sql/05_endurecimiento.sql   validación en process_sale + rastro de auditoría
sql/06_ventas_por_hora.sql  dashboard_summary devuelve además ventas por hora
sql/07_cierre_automatico.sql daily_closing_all() + bitácora de correos
sql/08_fidelizacion.sql     clientes, puntos, canje y carnet público
sql/09_wallet_avisos.sql    avisos a Wallet cuando cambia un saldo (pg_net)
sql/10_peso_fijo.sql        el peso lo pone la báscula: PIN de gerente, autorizaciones,
                            clasificación de cada venta y pedidos anulados
sql/11_huella.sql           autorizar con la huella del teléfono de la gerente (passkeys)
cierre-diario/      Worker programado que manda el cierre (ver su LEEME.md)
wallet/             Worker de pases de Apple/Google Wallet en wallet.slabblu.com (ver su LEEME.md)
wallet/secretos/    llave y certificado de Apple — GITIGNORADO, nunca al repo
sql/pruebas/        prueba_aislamiento.sql (13) + prueba_seguridad.sql (48 ataques)
                    + prueba_fidelizacion.sql (19) + prueba_pesos.sql (48)
                    + prueba_huella.sql (12)
                    + datos_de_demostracion.sql (14 días de ventas, borrables)
web/index.html      estructura y pestañas (sin scripts en línea: hay CSP)
web/app.js          toda la lógica (17 secciones numeradas)
web/bascula.js      protocolo de la báscula (CAS PD-II en NCI); se prueba en Node
web/libro-ventas.js libro de ventas en el formato ICG (Excel .xlsx hecho a mano); se prueba en Node
caja/               modo kiosko de Chrome + cómo configurar la báscula (ver su LEEME.md)
pruebas-web/        pruebas de la pantalla de venta con Playwright y báscula simulada
web/styles.css      estilos, modo día/noche
web/config.js       credenciales — ÚNICO archivo que el dueño edita
web/sw.js           service worker: app shell offline
web/carnet.html     carnet digital PÚBLICO de la clienta (+ carnet.js/.css)
web/vendor/qrcode.min.js  qrcode-generator 2.0.4 (MIT), servido local por la CSP
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
| `cajera` | solo su sucursal | cobrar (vía RPC), ver catálogo, inscribir y buscar clientes, canjear puntos |
| `gerente` | solo su sucursal | todo lo anterior + dashboard, gastos, clientes y ajustes de puntos, inventario, toppings, precios, reportes, configuración de SU tienda |
| `propietario` | todas | todo + crear sucursales + asignar roles y tiendas + reglas del programa de puntos |

`profiles.location_id` es NULL solo para el propietario. Un usuario sin
sucursal asignada (y que no sea propietario) no puede entrar — es intencional,
para que nadie vea datos por accidente al registrarse.

**Regla dura del cliente**: Tuti's Galerías no ve NADA de Tuti's Multiplaza, y
viceversa. Solo el dueño ve ambas, y necesita reportes **por tienda**, no solo
consolidados.

## 3.0 Fidelización (puntos y carnet)

**La regla del negocio (2026-10-01): "se entrega un lempira por cada dólar
gastado, o su equivalente".** Se modela con dos números, no con una fracción:

- `monto_por_punto` — lempiras que hay que gastar para ganar 1 punto. Es el
  equivalente del dólar (L 27 al arrancar). **No se actualiza solo con el
  tipo de cambio, a propósito**: es una decisión comercial.
- `valor_punto` — lo que vale un punto al canjearlo: L 1. Para la clienta,
  sus puntos SON lempiras.

Lo que no hay que deshacer:

1. **Los puntos son de la marca, no de la tienda** (lo decidió el dueño). Es la
   ÚNICA excepción al aislamiento entre sucursales: `customers` se comparte
   (nombre y saldo), pero `loyalty_transactions` lleva `location_id` y cada
   gerente solo ve los movimientos de SU tienda. Nadie ve ventas de la otra.
2. **`points_balance` tiene el UPDATE revocado a nivel de columna.** Solo lo
   mueven las funciones; cada movimiento queda en `loyalty_transactions`. El
   saldo es un caché del libro, y `prueba_fidelizacion.sql` P11 lo cuadra.
3. **La pantalla manda CUÁNTOS PUNTOS canjear, nunca cuánto dinero.** El
   descuento lo calcula `process_sale` con `valor_punto`. El tope (50% de la
   venta por defecto) se recalcula en el servidor aunque la pantalla ya lo
   haya consultado.
4. **Los puntos se ganan sobre lo PAGADO, no sobre el precio de lista.** Si no,
   canjear puntos generaría puntos nuevos.
5. **Canjear requiere internet; ganar, no.** Una venta sin conexión viaja con
   el cliente pero sin canje. Si se permitiera canjear offline y la clienta
   gastara esos puntos en la otra tienda antes de sincronizar, el servidor
   rechazaría la venta y la cola la descartaría: se perdería una venta real.
6. **Los puntos NUNCA tumban una venta.** Si el cliente de una venta ya no
   existe o está inactivo y la venta solo iba a ganar puntos, se registra sin
   cliente en vez de rechazarse (pruebas P12). Solo se rechaza si pedía
   canjear, porque eso pasa en línea y la cajera tiene que enterarse.
7. **`loyalty_carnet()` es la única función del sistema que puede llamar
   `anon`.** El carnet se abre desde el teléfono de la clienta, que no tiene
   usuario. El código de 10 caracteres hace de llave, por eso devuelve solo
   nombre de pila, saldo y su valor — nunca teléfono, correo ni historial.
8. **El código del carnet no usa O, 0, I, 1 ni L.** Se dicta en voz alta.
9. **El QR codifica SOLO el código, no la URL.** Es lo que teclea un lector de
   códigos de barras en la caja, y lo que va en los pases de Wallet. La caja
   igual acepta la URL completa pegada (`codigoDesdeTexto()`).
10. **`carnet.css` necesita su propia regla `[hidden] { display:none !important }`.**
    Es una hoja aparte de la caja; sin ella los botones de Wallet aparecían
    aunque el servicio de pases no existiera, apuntando a `#`.

## 3.0.1 Pases de Wallet

Viven en `wallet/`, Worker aparte en `wallet.slabblu.com`. Su LEEME.md tiene
todo. Lo que no hay que deshacer:

1. **No usa la llave de servicio de Supabase.** Lee el carnet con
   `loyalty_carnet` y la llave pública, igual que el carnet web.
2. **La firma PKCS#7 (`src/cms.js`) está hecha a mano con WebCrypto.** Una
   librería JS pura haría la RSA en JS y pasaría los 10 ms de CPU del plan
   gratuito. Si se toca, hay que volver a verificar con `openssl cms -verify`.
   Trampa clásica: lo que se firma son los atributos codificados como SET
   (0x31), pero en el SignerInfo van con la etiqueta [0] (0xA0).
3. **Cada pase lleva `webServiceURL` desde el primero.** Un pase emitido sin él
   no se puede actualizar jamás.
4. **El token de cada pase es HMAC(código, WALLET_HMAC_SECRET).** Si el secreto
   falta o es corto, el servicio responde 503: falla cerrado. Cambiar ese
   secreto deja sin actualizaciones a los pases que ya están en los teléfonos.
5. **El certificado de Apple vence el 31/10/2027.** Pass Type ID
   `pass.com.slabblu.tutis`, Team ID `95P9N796G9`.
6. **`compatibility_date` no puede ser más nueva que lo que soporta el workerd
   local** o `wrangler dev` no arranca.

## 3.1 Dashboard y gastos

La pestaña **Dashboard** va primero, antes de Venta, y es la pantalla inicial de
gerente y propietario (la cajera sigue aterrizando en Venta y no ve la pestaña).

- Los números salen de `dashboard_summary()` en la base, una llamada por
  sucursal. El cliente suma: así el propietario ve cada tienda y el consolidado
  sin que la base sepa nada de "consolidado", y el permiso se sigue revisando
  en la base sucursal por sucursal.
- **Gastos** (`expenses`) es lo que faltaba para tener utilidad de verdad:
  `utilidad = margen del producto − gastos de operar`. La cajera no los ve ni
  los registra.
- **Las gráficas son SVG escrito a mano** (`vizBarras`, `vizBarrasH`,
  `vizBarrasDobles`, `vizApilada`, `vizLinea`). No hay librería y no la puede
  haber: la CSP es `script-src 'self'`. Si el periodo pasa de 45 días, las
  barras se agrupan por semana.
- **La paleta de gráficas NO son los colores de marca.** Los de marca no
  pasaban el validador: el verde `#2F7A62` caía bajo el piso de saturación (se
  leía gris) y el ámbar contra el rojo quedaban a ΔE 13.9 para visión normal.
  Las que están (`--viz-ok/-bad/-neutral` en `styles.css`) se validaron en
  ambos modos. El significado es fijo: **verde = dinero que se queda, rojo =
  dinero que sale, azul = volumen**. El par rojo/verde queda en el límite para
  daltonismo rojo-verde, así que donde aparecen juntos **siempre** va etiqueta
  de texto además del color — no es decoración, es lo que hace legible la
  gráfica.
- **El margen diario se grafica como `null` en los días sin ventas**, no como
  0 %. Dibujar 0 % diría que el margen se desplomó, cuando lo que pasó es que
  la tienda no vendió.
- **La proyección es una regla de tres, y lo dice en pantalla**: promedio
  diario × días del mes. Con menos de 14 días con ventas muestra una
  advertencia explícita. No se debe cambiar por un modelo que parezca más
  seguro de lo que es.

**Los gastos viven en su propia pestaña**, no en el tablero: el tablero solo
muestra el resumen y la gráfica. Tener el formulario en dos lugares invitaba a
editar lo mismo desde dos pantallas distintas. Al registrar un gasto NO se
manda `created_by`: lo pone el disparador con `auth.uid()`.

**Altas de personal desde la aplicación**: el propietario crea usuarios en la
pestaña Sucursales y usuarios. Se hace con `signUp()` sobre un **cliente de
Supabase aparte con `persistSession: false`** — con el cliente normal, el
usuario recién creado se apoderaría de la sesión y sacaría al propietario. Esto
exige que en el proyecto el registro esté habilitado y la confirmación de
correo apagada. El riesgo está contenido por diseño: quien se registre solo
nace sin sucursal, y sin sucursal la aplicación no lo deja entrar y RLS no le
muestra nada.

## 3.2 Seguridad y auditoría

Se auditó el sistema atacándolo desde la posición realista: alguien con cuenta
legítima (cajera o gerente) llamando la API directo desde la consola. Está en
`sql/pruebas/prueba_seguridad.sql` y **hay que volver a correrla si se toca el
esquema o `process_sale`**.

Lo que salió de ahí y NO se debe deshacer:

1. **`process_sale` rechaza pesos, costos y precios negativos.** Era el único
   ataque que pasaba: `weight_g = -500` hacía `stock - (-500)` y SUMABA
   inventario. Una cajera podía tapar un faltante inventando una venta
   negativa. También se rechazan pesos sobre 100 000 g.

2. **El encabezado de la venta se calcula de sus líneas, no viene del
   navegador.** Antes se podía mandar `total_price: 1` con líneas por 500.
   Reporte y detalle ya no pueden contradecirse.

   Lo que **sí** sigue viniendo del navegador es el precio de cada línea, y es
   deliberado: una venta cobrada sin internet tiene que conservar el precio
   que el cliente pagó, no el vigente al sincronizar. El control de ese riesgo
   es el rastro de auditoría más el reporte de margen, no recalcular.

3. **`expenses.created_by` lo pone un disparador con `auth.uid()`.** Antes una
   gerente podía firmar un gasto con el id de otra persona.

4. **El rastro de auditoría (`audit_log`) es de solo lectura desde la API.** No
   hay política de insert, update ni delete: solo escriben los disparadores,
   que son `SECURITY DEFINER`. Ni el propietario puede editarlo — eso es lo
   que le da valor. Se audita lo que mueve dinero o permisos (precios, costos,
   existencias, roles, gastos y el BORRADO de ventas), pero **no el alta de
   cada venta**: la venta ya es su propio registro y duplicarla llenaría la
   base del plan gratuito sin aportar nada.

5. **El logo se valida contra `data:image/...;base64,` antes de pintarse.** Un
   `data:image/svg+xml` puede llevar scripts adentro; por eso no basta con
   escapar el atributo.

6. **El SDK de Supabase se mantiene al día** (`web/vendor/`). La versión 2.45.4
   con la que arrancó el proyecto tenía un aviso de seguridad en `auth-js`.

## 3.3 El cierre automático por correo

Vive en `cierre-diario/`, un Worker de Cloudflare con disparador de reloj.
**Su LEEME.md tiene la puesta en marcha completa.** Lo que no hay que deshacer:

1. **Es un Worker APARTE del sitio.** Si el correo falla, la caja no se
   entera. El punto de venta no puede depender del envío.
2. **Las cuentas las hace la base** (`daily_closing_all`), no el Worker. Con
   el cálculo en dos lugares, un día dejarían de coincidir.
3. **`daily_closing_core()` no pregunta permisos y por eso NADIE puede
   llamarla**, ni `authenticated` ni `anon`: se llega por `daily_closing()`,
   que sí pregunta. `daily_closing_all()` es solo para `service_role`. El
   permiso ahí no es "quién eres" sino "tienes la llave del servidor".
4. **La llave `service_role` vive ÚNICAMENTE como secreto de Cloudflare.**
   Es el único lugar del sistema donde se usa.
5. **El Worker no tiene dirección pública** (`workers_dev: false`). Guarda esa
   llave; no tiene por qué ser alcanzable desde internet.
6. **El cron va en UTC**; las tiendas están en UTC-6. `0 4 * * *` son las
   22:00 de la tienda. El Worker resta el desfase para saber qué día reportar.
7. **El correo declara `<meta charset="utf-8">`.** Sin eso los acentos llegan
   rotos ("GalerÃ­as"), y este reporte está lleno de acentos.
8. **Un correo ya enviado no se repite**: índice único por día, sucursal y
   destinatario en `closing_email_log`.

## 3.4 Lo pesado queda fijo (báscula, PIN y kiosko)

Pedido del dueño (2026-10-07): en el sistema anterior la cajera leía la CAS y
TECLEABA el peso, y se veían líneas que se ponían y se quitaban. Regla: lo
pesado no se cambia. Lo que no hay que deshacer:

1. **El peso no se teclea.** El campo de peso solo aparece en modo "a mano".
   En modo báscula hay botón *Pesar*, y solo acepta una lectura ESTABLE y de
   menos de 1 s (la PD-II avisa movimiento en sus bytes de estado).
2. **Todo se pesa sobre el mismo vaso, de forma acumulada.** Helado = primera
   lectura − tara; cada topping = lo que subió desde la lectura anterior. Por
   eso el helado va primero, y el vaso no se puede cambiar después de pesar.
3. **La tara sale del catálogo** (`supplies.tare_weight_g`), ya no hay campo
   para teclearla. Una tara inflada es peso que se le roba al cliente.
4. **Una línea pesada no se borra.** Se anula el pedido completo y queda en
   `order_voids` con nombre, motivo y peso. El pedido en curso vive en
   `localStorage` (`tutis_pedido_en_curso`): recargar la caja para tirarlo lo
   registra como anulado al volver. Las anulaciones tienen su propia cola
   offline (`tutis_pending_voids`).
5. **El servidor CLASIFICA, nunca rechaza** (`sales.weight_source`): bascula,
   bascula_no_cuadra (las líneas no suman la lectura bruta, ±1 g),
   manual_autorizado, manual_sin_autorizar, sin_dato, no_aplica. Rechazar haría
   que la cola offline descartara una venta que sí ocurrió (misma regla que
   los puntos). Las ventas anteriores a sql/10 quedan con NULL y el reporte no
   las cuenta.
6. **El PIN se valida en el servidor**, con bcrypt, en `privado.manager_pins`
   (esquema que la API no publica; ni la gerente lee su hash). La cajera ELIGE
   a la gerente y la gerente teclea el PIN: así dos PIN iguales no se
   confunden y nadie descubre el de otra intentando ponerse el mismo.
7. **`autorizar_peso_manual` devuelve `{ok:false}` en vez de lanzar excepción
   con PIN malo.** Si lanzara, la transacción desharía también el registro del
   intento fallido y el tope (5 fallos en 15 min, por cajera Y por gerente)
   no contaría nada. Efecto conocido: una cajera puede bloquear 15 min el PIN
   de una gerente a propósito; queda anotado y puede autorizar otra persona.
8. **La autorización cubre el peso exacto y una sola venta.** process_sale la
   amarra a la venta (`sale_id`) bajo `for update`.
9. **Sin internet no hay PIN que validar:** se cobra igual y la venta queda
   `manual_sin_autorizar`, en rojo en *Reportes → Control de pesos*.
10. **El servidor no ve la báscula**, ve lo que dice el navegador. Lo que
    impide fabricar lecturas desde la consola es el **modo kiosko**
    (`caja/politicas-kiosko.reg`: sin DevTools, sin extensiones, solo la caja
    y Supabase). Engañar a la báscula por fuera (ZERO con el vaso encima, la
    mano en el plato) solo lo destapa el cuadre de inventario. Decirlo así.
11. **La CAS PD-II va en tYPE-5 (NCI General), 9600 7E1.** La caja manda `W\r`
    y la báscula contesta `<LF>peso UU<CR><LF>hh<CR><ETX>`. Si se cambia de
    modelo, se ajusta `config.js` (SCALE_*); `bascula.js` entiende también
    básculas de salida continua.

## 3.5 Huella del teléfono (passkeys)

Pedido del dueño (2026-10-07): entrar y autorizar con biométrico. Eligió
**el teléfono de cada quien** (no llaves USB ni lector en la caja) y dejar el
PIN como respaldo. Usa Passkeys de Supabase Auth (beta, mayo 2026); el SDK
2.116 de `web/vendor/` ya lo trae con `auth: { experimental: { passkey: true } }`.
Se enciende con `PASSKEYS: true` en `config.js`. Lo que no hay que deshacer:

1. **Nada de lector de huella en la caja.** Windows Hello no sabe QUIÉN puso
   el dedo, solo que es uno de los registrados en esa cuenta de Windows: la
   cajera elegiría la cuenta de la gerente y pondría su dedo. Por eso
   tampoco se ofrece registrar huella desde una computadora (`esTelefono()`),
   solo desde un teléfono.
2. **Autorizar abre una sesión APARTE** (`sbAutoriza()`, `persistSession:
   false`), la de la gerente, que se cierra con `signOut({scope:"local"})`
   enseguida. La de la cajera no se toca.
3. **`autorizar_peso_presencial` exige `amr` = passkey de hace menos de 5
   min.** Una sesión de la gerente abierta con contraseña, o vieja, no sirve.
   Quien llama es la gerente; la cajera viene como parámetro y se valida que
   sea de la tienda.
4. **`weight_authorizations.method`** dice 'pin' o 'huella', y el reporte lo
   muestra.
5. Necesita internet y Bluetooth en la computadora de la caja (el teléfono
   se enlaza por QR + Bluetooth). Sin eso queda el PIN.

## 4. Restricciones permanentes (pedidas explícitamente)

- **NUNCA incluir el sitio web `https://tutis.innova504.com/` en la factura o
  comprobante.** El dueño lo pidió dos veces, textual: "no lo agregues en la
  factura". Aplica a cualquier comprobante, recibo o impresión que se agregue
  en el futuro.
- **Todo el texto en Arial**, tanto en pantalla como en lo que se imprime.
- **El logo de la sucursal sale en el comprobante y en los reportes impresos.**
  Se guarda como data URL dentro de `locations.logo_data_url`, NO en un bucket:
  así viaja con el catálogo que la caja cachea y el comprobante sale con logo
  aunque no haya internet, y la CSP (`img-src 'self' data:`) ya lo permite sin
  abrirle la puerta a ningún dominio. La app lo reduce a 480px antes de
  guardarlo y la base rechaza más de 300 KB.
- **Los pesos SIEMPRE se guardan en gramos.** `locations.default_weight_unit`
  solo cambia cómo se muestran y con qué unidad arrancan los campos. Si cada
  tienda guardara en su unidad, cualquier reporte consolidado estaría sumando
  peras con manzanas sin que se note. Para mostrar hay `fmtWeight()` (con la
  otra unidad entre paréntesis) y `fmtWeightShort()`.
- **Al cambiar la unidad, las filas de topping que ya están en pantalla
  conservan la suya.** Es a propósito: reinterpretar "30" de gramos a onzas
  multiplicaría el cobro por 28.
- **Modo día y modo noche**, con la elección recordada en el navegador.
- **La interfaz nunca menciona Supabase, `config.js` ni nada técnico.** El
  cliente final no tiene por qué saber con qué está hecho: cuando algo falla
  por configuración, el mensaje dice "avísale a soporte técnico".
- En las tablas, guardar y eliminar van con **iconos** (disquete y papelera),
  no con texto.
- La pantalla de venta debe mostrar **peso de helado, peso de toppings, peso de
  recipiente (vaso) y peso total**, y de dónde salió el peso (báscula o a
  mano). Con la báscula, el total es la última lectura y cuadra por
  construcción con helado + toppings + tara (ver 3.4).
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

### 5.1 Lo que se sabe del sistema actual (dicho por el negocio, 2026-10-07)

Cómo se cobra HOY, según la dueña del negocio (las reglas de operación y
precios las define ella; Samuel lleva el sistema):

- **La taza se cobra por onza del peso total**: taza + todos los sabores +
  todos los toppings normales, en una sola pesada. Es el "precio único por
  peso total" del requisito 7. En su sistema: "Oz Frozen Yogurt Mix",
  L 10.26 sin ISV (≈ L 11.80 con ISV) la onza.
- **El topping premium NUNCA va en la taza**: va aparte, en su porción. Se
  calcula a L 60 la onza, pero se vende por porción a L 60 (L 52.17 sin ISV),
  sin pesar.
- **Toppings para llevar aparte**: el normal tiene otro precio, el premium
  también.
- **Bubble Pop** se pesa aparte y se cobra por onza (L 43.48 sin ISV = L 50).
- Los precios de su sistema están SIN ISV; la factura suma el 15 %.

- El sistema que usan hoy es de ICG: **FrontRetail** en cada caja (las
  terminales) y **Manager** como administración central de las dos.
- **Una sola caja por tienda.** Cada tienda es un punto de emisión.
- El contador solo pide a la SAR el rango nuevo (CAI); el sistema imprime
  el correlativo que la SAR asignó. (Pendiente de que el contador confirme
  si cambiar de software exige avisar a la SAR como autoimpresor.)
- **Multiplaza tiene su propio CAI** y su propia fecha límite de emisión
  (Galerías: CAI 452640-F3E73E-43FBE0-63BE03-090938-BF, rango
  000-001-01-00622001 a 00702000, vence 04/12/2026). Cuando se encienda la
  facturación fiscal, el CAI, el rango y la fecha límite van POR SUCURSAL, y
  hay que avisar antes de que venzan o se agoten.
- Compras, por categoría:
  - **CTG**: gastos.
  - **CTH**: materia prima que entra **desde bodega** (hay una bodega
    central que surte a las tiendas).
  - **011C / 021C**: materia prima comprada y recibida directo por cada
    tienda, y cada tienda la ingresa. Falta confirmar cuál código es de
    cuál tienda (probable: 011C Galerías, 021C Multiplaza).

### 5.2 Libro de ventas en formato ICG

*Reportes → Libro de ventas* descarga un .xlsx con las columnas exactas del
"Reporte fiscal de ventas" de FrontRetail (rptVentasFRetail), para el
contador. Lo que no hay que deshacer:

1. **No simula ser fiscal.** Tipo de documento "COMPROBANTE INTERNO", CAI
   vacío, correlativo = folio interno, y el título lo dice. Cuando se conecte
   la SAR, ahí entran el CAI y el correlativo de verdad.
2. **El ISV se separa del total cobrado**: gravado = total/1.15 a centavos,
   ISV = total − gravado, así cuadran factura por factura. Con las 2,415
   facturas de agosto de Galerías da lo mismo que ICG con diferencia de
   centavos (ICG arrastra fracciones de centavo).
3. **Una hoja por tienda** en el consolidado: los correlativos no se mezclan.
4. **El .xlsx se arma a mano** (ZIP sin comprimir + XML): la CSP no permite
   librerías. Todo en Arial.

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
psql -h /tmp/pg -p 5433 -U postgres -f sql/03_dashboard.sql
psql -h /tmp/pg -p 5433 -U postgres -f sql/04_logo_y_unidades.sql
psql -h /tmp/pg -p 5433 -U postgres -f sql/05_endurecimiento.sql
psql -h /tmp/pg -p 5433 -U postgres -f sql/06_ventas_por_hora.sql
psql -h /tmp/pg -p 5433 -U postgres -f sql/07_cierre_automatico.sql
psql -h /tmp/pg -p 5433 -U postgres -f sql/08_fidelizacion.sql
# 09 usa pg_net, que solo existe en Supabase: crear antes un net.http_post
# de mentira (ver prueba_wallet_avisos.sql) y quitar su "create extension".
grep -v "create extension if not exists pg_net" sql/09_wallet_avisos.sql | psql -h /tmp/pg -p 5433 -U postgres
psql -h /tmp/pg -p 5433 -U postgres -f sql/10_peso_fijo.sql
psql -h /tmp/pg -p 5433 -U postgres -f sql/11_huella.sql
psql -h /tmp/pg -p 5433 -U postgres -f sql/pruebas/prueba_aislamiento.sql
psql -h /tmp/pg -p 5433 -U postgres -f sql/pruebas/prueba_seguridad.sql
psql -h /tmp/pg -p 5433 -U postgres -f sql/pruebas/prueba_fidelizacion.sql
psql -h /tmp/pg -p 5433 -U postgres -f sql/pruebas/prueba_pesos.sql
psql -h /tmp/pg -p 5433 -U postgres -f sql/pruebas/prueba_huella.sql
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

`pruebas-web/` tiene pruebas con Playwright que cambian el SDK de Supabase por
un doble en memoria y simulan la báscula CAS por Web Serial. Manejan la caja de
punta a punta: pesar, línea fija, anular, recargar, PIN, sin internet, reporte
(cómo correrlas: su LEEME.md). Lo esencial que debe seguir cumpliéndose:

- Una cajera ve solo la pestaña Venta; el propietario ve las 6.
- 150g helado + 30g topping + vaso de 15g a 0.45/g = **HNL 87.75**.
- Al cobrar sin conexión: el recibo igual se muestra, avisa que quedó
  pendiente, y la venta queda en `localStorage` bajo `tutis_pending_sales`.
- El recibo NO contiene ningún enlace al sitio web.

## 7. Pendientes, en orden de valor

1. **Probar la báscula real.** Ya tienen una CAS PD-II; el lector
   (`web/bascula.js`) está hecho para su protocolo NCI y probado con una
   báscula simulada, no con la física. Falta: cable + adaptador USB-serial,
   ponerla en tYPE-5 y una pesada real. Requiere Chrome/Edge + HTTPS; no
   funciona en Safari ni iPad.
2. **Catálogo real**: venden por onza (yogurt ~L 11.80 con ISV), toppings
   premium a tarifa fija y Bubble Pop por onza; el modelo de precio único por
   gramo no es el suyo. Pendiente de la lista de precios vigente.
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
