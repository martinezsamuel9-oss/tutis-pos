# Tuti's — Punto de venta web multi-sucursal

Sistema de punto de venta para Tuti's Frozen Yogurt, hecho para trabajar con
varias sucursales conectadas a una sola base de datos, sin instalar nada en las
computadoras de las tiendas: se abre en el navegador.

## Lo esencial en un minuto

- **Base de datos:** Supabase (PostgreSQL en la nube, plan gratuito).
- **Aplicación:** archivos HTML/CSS/JavaScript que se abren en Chrome. No hay
  servidor propio que mantener ni programa que instalar en cada tienda.
- **Aislamiento entre sucursales:** Tuti's Galerías no ve absolutamente nada de
  Tuti's Multiplaza. Eso no depende de la pantalla: está aplicado dentro de la
  base de datos, así que se cumple aunque alguien intente consultar la API por
  fuera de la aplicación.
- **Roles:** propietario (ve y administra todo), gerente de tienda (manda en su
  sucursal), cajera (solo cobra en su sucursal).
- **Sin internet:** la caja sigue cobrando. Las ventas se guardan en la tableta
  o computadora y se envían solas cuando vuelve la conexión.

## Instalación

### Paso 1 — Crear el proyecto en Supabase

1. Entra a supabase.com con tu cuenta gratuita.
2. **New project**. Ponle de nombre `tutis-pos`.
3. Región: elige `us-east-1` (la más cercana a Centroamérica de las disponibles).
4. Guarda bien la contraseña de la base de datos que te pida — la vas a
   necesitar solo si algún día te conectas directo por SQL desde fuera.
5. Espera unos minutos a que el proyecto quede listo.

> El plan gratuito permite 2 proyectos activos. Si ya tienes ArrowHealth ahí,
> este sería el segundo y entra sin costo.

### Paso 2 — Crear las tablas

1. En tu proyecto: menú izquierdo → **SQL Editor** → **New query**.
2. Abre el archivo `sql/01_schema.sql` de esta carpeta, copia TODO su contenido,
   pégalo y dale **Run**. Debe decir "Success".
3. Nueva consulta, ahora con `sql/02_seed.sql` (las 2 sucursales y el catálogo
   de arranque). **Run**.

### Paso 3 — Crear tu usuario y volverte propietario

1. Menú izquierdo → **Authentication** → **Users** → **Add user** →
   **Create new user**. Pon tu correo y una contraseña. Marca la casilla de
   confirmar el correo automáticamente si aparece.
2. Vuelve al **SQL Editor** y corre esto, cambiando el correo por el tuyo:

```sql
update public.profiles
   set role = 'propietario', location_id = null, full_name = 'Samuel Martínez'
 where id = (select id from auth.users where email = 'TU-CORREO@ejemplo.com');
```

Ese es el único usuario que hay que ascender a mano. A las gerentes y cajeras
ya las asignas desde la aplicación.

### Paso 4 — Conectar la aplicación con tu proyecto

1. En Supabase: **Settings** (engranaje) → **API**.
2. Copia el **Project URL** y la llave **anon public**.
3. Abre `web/config.js` con cualquier editor de texto y pégalos donde dice
   `TU-PROYECTO` y `TU-LLAVE-ANON-AQUI`.

La llave `anon` está hecha para ser pública: por sí sola no abre nada, porque
quien decide qué ve cada usuario son las reglas de seguridad de la base de
datos. La que **nunca** debe ir ahí es la llave `service_role`.

### Paso 5 — Publicar la aplicación

**Ya está publicada** en https://tutis.slabblu.com (Cloudflare, con HTTPS). Esa
es la dirección que abren las tiendas.

Para volver a publicar después de cambiar algo (por ejemplo, después de pegar
tus credenciales en `config.js`):

```
npm install        # solo la primera vez
npm run deploy
```

Si algún día quieres verla en tu máquina antes de publicar:

```
npm run dev        # queda en http://localhost:8788
```

El HTTPS no es un lujo: el navegador solo permite leer la báscula por USB en
sitios con HTTPS, y el modo sin conexión (service worker) tampoco funciona sin
él.

### Paso 6 — Dar de alta al personal

1. Para cada gerente o cajera: Supabase → **Authentication** → **Users** →
   **Add user** (correo y contraseña).
2. Entra a la aplicación como propietario → pestaña **Sucursales y usuarios**.
3. Ahí aparece cada persona. Asígnale su **rol** y su **sucursal**, y guarda.

Mientras no tenga sucursal asignada, el sistema no la deja entrar — a propósito,
para que nadie vea datos por accidente.

## Cómo se usa cada rol

**Cajera.** Solo ve la pestaña Venta, y solo de su tienda. Pesa el vaso, el
helado y los toppings, cobra, e imprime el comprobante. No puede cambiar precios
ni costos, ni ver reportes, ni ver la otra sucursal.

**Gerente de tienda.** Todo lo de su tienda: inventario, parametrización de
toppings, precios, reportes, cierre del día y configuración de esa sucursal.
Nada de la otra tienda.

**Propietario.** Ve las dos (o las que sean) sucursales, con reportes por tienda
y consolidados. Crea sucursales nuevas, y asigna roles y tiendas al personal.
En la pestaña Sucursales y usuarios puede elegir "Trabajar en esta" para
administrar el inventario de la tienda que necesite.

## Cuando se cae el internet

Esto está diseñado alrededor de que la conexión en las tiendas falla seguido:

1. El catálogo y los precios quedan guardados en el navegador de la caja, así
   que la pantalla de venta sigue funcionando completa.
2. Si cobras sin conexión, la venta **se registra igual** y el comprobante se
   imprime normal, con una nota de que está pendiente de enviarse.
3. La venta queda en una cola local. Arriba se ve cuántas están pendientes.
4. Al volver el internet se envían solas (también reintenta cada minuto).
5. Cada venta lleva un identificador único, así que aunque se reenvíe dos veces
   nunca se cobra ni se descuenta inventario dos veces.

Lo único que sí necesita internet es cambiar precios, inventario o
configuración. Cobrar, no.

**Ojo:** las ventas pendientes viven en ese navegador y en esa computadora. No
borres los datos del navegador ni cambies de equipo con ventas sin enviar.

## La báscula

La aplicación lee básculas conectadas por USB/serial directamente desde Chrome
o Edge (con el botón ⚖ junto a cada peso). Requisitos:

- Chrome o Edge en la computadora del mostrador (no funciona en Safari ni en
  iPad).
- Que el sitio esté publicado con HTTPS.
- Una báscula con **salida serial continua** (suele llamarse "PC mode",
  "continuous output" o "salida RS-232"), por cable USB o por RS-232 con
  adaptador USB.

Marcas que se consiguen en la región y traen esa salida: **Torrey**, **CAS**,
**OHAUS**. Al comprarla, pregunta explícitamente si tiene salida serial/USB a
computadora con modo continuo — hay modelos de mostrador que solo muestran el
peso en pantalla y no lo transmiten, y esos no sirven para esto.

Cuando ya la tengan, avísame la marca y el modelo: cada fabricante manda el peso
en un formato ligeramente distinto y ajusto la lectura para que sea exacta. El
lector que va incluido es tolerante (toma el primer número de cada línea que
recibe), así que con la mayoría funciona tal cual, pero conviene afinarlo.

Si la velocidad de la báscula no es 9600, se cambia en `config.js`.

## Facturación

Igual que antes: ningún software puede emitir por sí solo una factura
fiscalmente válida. Hace falta que el negocio esté inscrito ante la autoridad de
cada país y conectado a su esquema electrónico:

| País | Autoridad | Esquema |
|---|---|---|
| Guatemala | SAT | FEL |
| El Salvador | Ministerio de Hacienda | DTE |
| Honduras | SAR | CAI o Factura Electrónica |

Mientras tanto, cada venta genera un comprobante interno con todos los campos
legales que exige el país de esa sucursal, marcado claramente como no fiscal.
Cuando tengan contrato y credenciales con un proveedor certificado, se conecta
sin rehacer el sistema.

## Abrir una tercera sucursal

Desde la aplicación, como propietario: pestaña **Sucursales y usuarios** →
llena el nombre, país, moneda y precio por gramo → **Crear sucursal**. Después
"Trabajar en esta" para cargarle su inventario, y asígnale su gerente y cajeras.
No hay que tocar código ni base de datos.

## Respaldos

Supabase respalda automáticamente en el plan gratuito con retención limitada.
Si el negocio crece, vale la pena subir al plan de pago por los respaldos
diarios con más historial. Mientras tanto, desde el SQL Editor puedes exportar
las ventas a CSV cuando quieras.

## Estructura de los archivos

```
tutis-web/
  sql/
    01_schema.sql     Tablas, roles, permisos y funciones (correr primero)
    02_seed.sql       Las 2 sucursales y el catálogo de arranque
    pruebas/          Pruebas de aislamiento en un PostgreSQL local
  web/                <- esta carpeta es la que se publica
    index.html        La aplicación
    app.js            Toda la lógica: precios, venta, offline, reportes, báscula
    styles.css        Estilos (Arial, modo día/noche)
    config.js         <- el único archivo que tienes que editar
    sw.js             Modo sin conexión: guarda la app en el dispositivo
    manifest.webmanifest   Para instalarla como aplicación en la tableta
    _headers          Cabeceras de seguridad que aplica Cloudflare
    vendor/           El SDK de Supabase, servido desde aquí y no desde un CDN
    logo.png, icon-192.png, icon-512.png
  wrangler.jsonc      Configuración del despliegue en Cloudflare
  README.md
```

## Instalarla como aplicación en la tableta

Abre https://tutis.slabblu.com en Chrome y usa el menú **⋮ → Instalar** (en
Android e iPad: "Agregar a la pantalla de inicio"). Queda con su icono, a
pantalla completa y sin barra de direcciones, y **abre aunque no haya
internet**: los archivos quedan guardados en el dispositivo.

## Lo que quedó pendiente

- **Envío automático del cierre por correo.** Hoy el botón "Enviar por correo"
  abre tu programa de correo con el reporte ya escrito y solo confirmas. Para
  que salga solo todos los días a una hora fija, sin que nadie lo toque, hay que
  agregar una función programada en Supabase (Edge Function + cron) conectada a
  un servicio de correo. Es el siguiente paso natural y se puede construir sobre
  lo que ya está.
- **Afinar el lector de la báscula** al modelo que compren.
- **Conectar el proveedor de facturación** cuando esté el registro fiscal.
- **Respaldos**: el plan gratuito tiene retención limitada. Si el negocio crece,
  conviene subir de plan o exportar las ventas cada cierto tiempo.
