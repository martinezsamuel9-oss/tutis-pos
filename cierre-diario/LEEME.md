# Envío automático del cierre del día

Manda cada noche, solo, sin que nadie lo toque:

- **A cada sucursal**, su cierre, al correo que tenga configurado en la
  aplicación (Configuración → Reporte de cierre).
- **Al propietario**, el de todas las tiendas juntas.

Contenido de cada reporte: ventas, vasos, cucharas, peso de helado, peso de
toppings, ingresos, costo, margen, gastos y utilidad del día, más el cuadro de
cada topping vendido con su porcentaje. Cada tienda lo recibe en la unidad con
la que trabaja (gramos u onzas), con la otra entre paréntesis.

## Cómo está armado

```
El reloj de Cloudflare (04:00 UTC = 22:00 en la tienda)
        ↓
Worker  tutis-cierre-diario
        ↓  pide las cuentas ya hechas
Supabase  daily_closing_all()
        ↓  manda los correos
Resend
        ↓  anota qué salió
Supabase  closing_email_log
```

Tres decisiones que conviene conocer antes de tocar algo:

**Es un Worker aparte del sitio.** Si el correo falla, la caja ni se entera.
El punto de venta no puede depender de que funcione el envío.

**Las cuentas las hace la base, no el Worker.** Aquí no se calcula ni un
lempira. Si el cálculo viviera en dos lugares, un día dejarían de coincidir y
nadie sabría a cuál creerle.

**No tiene dirección pública.** Guarda la llave de servicio —la que se salta
todas las reglas de seguridad de la base—, así que no debe ser alcanzable
desde internet. Solo lo despierta el reloj.

## Puesta en marcha

### 1. La base

Correr `sql/07_cierre_automatico.sql` en el SQL Editor de Supabase.

### 2. El correo de cada tienda

En la aplicación, como propietario: para cada sucursal, Configuración →
**Reporte de cierre** → el correo que debe recibirlo. Una sucursal sin correo
simplemente se omite (queda anotado en la bitácora).

### 3. Resend

1. Crear cuenta en resend.com (el plan gratuito da 3 000 correos al mes; aquí
   se usan unos 90).
2. **Domains → Add Domain** → `slabblu.com`. Resend da unos registros DNS;
   agregarlos en Cloudflare → slabblu.com → DNS. En unos minutos queda
   verificado.
3. **API Keys → Create** → permiso de solo enviar. Guardar la llave.

Sin dominio verificado, Resend rechaza los envíos.

### 4. Los secretos

Desde esta carpeta. Cada comando pide el valor y **no queda en el historial ni
en el repositorio**:

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put RESEND_API_KEY
```

- `SUPABASE_URL` — la dirección del proyecto (Settings → API → Project URL).
- `SUPABASE_SERVICE_KEY` — la llave **service_role** (Settings → API Keys).
  Es la única parte del sistema donde se usa. **Nunca** va en `web/config.js`
  ni en ningún archivo: esa llave se salta todas las políticas de seguridad.
- `RESEND_API_KEY` — la del paso 3.

### 5. El correo del propietario

En `wrangler.jsonc`, `CORREO_PROPIETARIO`. Se pueden poner varios separados
por coma. Después:

```bash
npx wrangler deploy
```

## Comprobar que funcionó

Desde la aplicación no hay pantalla todavía; se consulta en el SQL Editor:

```sql
select day, recipient, ok, detail, sent_at
  from public.closing_email_log
 order by sent_at desc limit 20;
```

O en vivo, mientras corre:

```bash
npx wrangler tail tutis-cierre-diario
```

## Cambiar la hora

`wrangler.jsonc` → `triggers.crons`. **Va siempre en UTC**, y Honduras es
UTC-6:

| Hora en la tienda | Cron |
|---|---|
| 21:00 | `0 3 * * *` |
| 22:00 | `0 4 * * *`  ← actual |
| 23:00 | `0 5 * * *` |

El Worker resta el desfase para saber qué día reportar, así que a las 22:00 del
lunes manda el cierre del lunes, no el del martes.

## Pedir un cierre a mano

Está previsto pero apagado, porque abre una dirección pública. Para usarlo:
`workers_dev: true` en `wrangler.jsonc`, publicar, crear el secreto
`TOKEN_MANUAL`, y volverlo a `false` cuando ya no haga falta.

```bash
curl -H "x-token: <TOKEN_MANUAL>" \
  "https://tutis-cierre-diario.<subdominio>.workers.dev/enviar?dia=2026-09-19"
```

## Si algo no llega

Un correo que ya salió no se vuelve a mandar aunque el proceso se dispare dos
veces: la bitácora tiene un índice único por día, sucursal y destinatario.
Para reenviar a propósito, hay que borrar esa fila de `closing_email_log`.

Si faltan secretos, el Worker **no truena**: lo anota y termina. Un cierre que
no se manda ya es un problema; un Worker reventando cada noche es ese mismo
problema más ruido.
