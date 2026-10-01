# Servicio de pases — Apple Wallet y Google Wallet

`wallet.slabblu.com`. Worker aparte de la caja: aquí vive la llave privada del
certificado de Apple, que no tiene nada que hacer cerca del punto de venta.

**No usa la llave de servicio de Supabase.** Solo lee del carnet lo mismo que
ve la clienta en su teléfono (`loyalty_carnet`, con la llave pública). Si este
Worker se viera comprometido, no expondría nada que el carnet web no muestre ya.

## Qué hace

| Ruta | Quién la llama | Para qué |
|---|---|---|
| `GET /apple/{código}` | la clienta, desde su carnet | descarga el `.pkpass` |
| `/apple/v1/...` | el iPhone, solo | registrar el pase y pedir la versión nueva cuando cambian los puntos |
| `GET /google/{código}` | la clienta | *(pendiente: falta la cuenta de Google)* |

## Cómo está firmado el pase

`src/cms.js` arma la firma PKCS#7 a mano y deja la operación RSA a WebCrypto,
que es nativo. Una librería en JavaScript puro haría la RSA en JS y se pasaría
de los 10 ms de CPU por solicitud del plan gratuito de Workers. La estructura
se verificó byte a byte con `openssl cms -verify` contra la raíz de Apple, y
falla — como debe — en cuanto se altera un archivo del pase.

El ZIP (`src/zip.js`) va sin compresión: Apple lo acepta y evita una librería.

## Cada pase lleva su servicio web desde el primer día

Un pase emitido sin `webServiceURL` **no se puede actualizar nunca**: la clienta
tendría que borrarlo y volver a agregarlo. Por eso va desde el primer pase,
aunque las notificaciones de cambio de puntos lleguen en la fase 2.

El token de cada pase se calcula con HMAC sobre su código y un secreto del
servidor: no se guarda en ningún lado y nadie puede fabricar el de otro carnet.
Si el secreto falta o mide menos de 32 caracteres, el servicio **no responde**
en vez de responder con tokens falsificables.

## Secretos

```bash
npx wrangler secret put APPLE_CERT_PEM   < secretos/pass-tutis-cert.pem
npx wrangler secret put APPLE_KEY_PEM    < secretos/pass-tutis.key
npx wrangler secret put APPLE_WWDR_PEM   < secretos/wwdr-g4.pem
openssl rand -hex 32 | npx wrangler secret put WALLET_HMAC_SECRET
```

`WALLET_HMAC_SECRET` no se vuelve a cambiar a la ligera: si cambia, los pases
que ya tienen las clientas dejan de poder actualizarse.

Después, en `web/config.js`, `WALLET_APPLE: true` y publicar la caja.

## Vencimiento

El certificado de Apple **vence el 31 de octubre de 2027**. Antes, se genera
uno nuevo para el mismo Pass Type ID (`pass.com.slabblu.tutis`) y se cambian
`APPLE_CERT_PEM` y `APPLE_KEY_PEM`. Los pases que ya están en los teléfonos
siguen funcionando; lo que dejaría de funcionar al vencer es emitir pases
nuevos y actualizar los existentes.

## Los puntos se actualizan solos

```
venta o ajuste → cambia customers.points_balance
  → disparador trg_wallet_aviso (sql/09) → pg_net, en segundo plano
  → POST /notificar  (X-Tutis-Secreto)
  → APNs con el certificado del pase, aviso vacío
  → el iPhone pregunta qué cambió y baja el pase nuevo
  → Wallet muestra "Ahora tienes N puntos en Tuti's"
```

- **El aviso nunca frena ni tumba una venta.** pg_net manda la llamada en
  segundo plano tras confirmarse la venta; si falla al encolar, queda una
  advertencia y la venta sigue (prueba W6).
- **Apple exige el certificado del pase para estos avisos; la llave `.p8` no
  sirve para Wallet.** El Worker lo presenta por el enlace mTLS `APNS_CERT`,
  que vive en el almacén de certificados de Cloudflare (aparte de los secretos):

  ```bash
  npx wrangler mtls-certificate upload --cert secretos/pass-tutis-cadena.pem --key secretos/pass-tutis.key --name tutis-pass-apns
  ```

  Al renovar el certificado en 2027 hay que subirlo aquí también.
- **El aviso va vacío**, como pide Apple: no tiene entrega garantizada y se
  agrupa, así que solo dice "hay algo nuevo".
- **En local no se puede probar**: el `fetch` de `wrangler dev` no habla HTTP/2
  con Apple; en producción, el borde de Cloudflare sí.
- Si Apple responde 410 (el iPhone ya no tiene el pase), se borra ese registro.
- `/notificar` exige `WALLET_NOTIFY_SECRET` (64 caracteres). El mismo valor va
  en `privado.wallet_config`, un esquema que la API no publica. El SQL que lo
  conecta se generó en `secretos/` y no entra al repositorio.
- Una venta que canjea y gana puntos manda dos avisos (dos cambios de saldo).
  Apple los agrupa; no vale la pena complicar process_sale por eso.

## Lo que falta

- **Google Wallet**: falta el Issuer ID y la cuenta de servicio.
