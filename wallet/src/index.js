/* ===========================================================================
   TUTI'S — Servicio de pases de Wallet  (wallet.slabblu.com)
   ---------------------------------------------------------------------------
   Worker aparte, igual que el del cierre por correo: si esto falla, la caja
   no se entera. Y aparte también por seguridad: aquí vive la llave privada
   del certificado de Apple, que no tiene nada que hacer cerca del sitio de la
   caja.

   NO usa la llave de servicio de Supabase. Solo lee lo que ya es público del
   carnet (loyalty_carnet, con la llave anónima): nombre de pila, puntos y su
   valor. Si este Worker se viera comprometido, no expondría nada que el
   carnet web no muestre ya.

   Rutas:
     GET  /apple/{codigo}                 → descarga el .pkpass
     GET  /google/{codigo}                → (fase 2, falta la cuenta de Google)
     *    /apple/v1/...                   → el servicio web que Apple llama para
                                            registrar el pase y pedir su
                                            versión nueva cuando cambian los puntos
   =========================================================================== */
import { armarPkpass } from "./apple.js";
import icon   from "./img/icon.png";
import icon2  from "./img/icon@2x.png";
import icon3  from "./img/icon@3x.png";
import logo   from "./img/logo.png";
import logo2  from "./img/logo@2x.png";
import logo3  from "./img/logo@3x.png";

const IMAGENES = {
  "icon.png": new Uint8Array(icon),   "icon@2x.png": new Uint8Array(icon2), "icon@3x.png": new Uint8Array(icon3),
  "logo.png": new Uint8Array(logo),   "logo@2x.png": new Uint8Array(logo2), "logo@3x.png": new Uint8Array(logo3),
};

// El código del carnet solo puede traer las letras y números de su alfabeto.
// Todo lo demás se descarta antes de llegar a la base o a un nombre de llave.
const limpiarCodigo = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);

const texto = (msg, status = 200) => new Response(msg, {
  status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const partes = url.pathname.split("/").filter(Boolean);

    try {
      // --- Servicio web de Apple (lo llama el iPhone, no la clienta) -------
      if (partes[0] === "apple" && partes[1] === "v1") return await servicioApple(req, env, partes.slice(2), url);

      // --- Aviso de la base: cambió el saldo de un carnet ------------------
      if (req.method === "POST" && partes[0] === "notificar" && !partes[1]) return await notificar(req, env);

      // --- Descargar el pase ----------------------------------------------
      if (req.method === "GET" && partes[0] === "apple" && partes[1]) {
        return await descargarApple(env, limpiarCodigo(partes[1]));
      }
      if (req.method === "GET" && partes[0] === "google" && partes[1]) {
        return texto("El pase de Google Wallet todavía no está disponible. Mientras, tu carnet funciona igual desde el enlace que te mandamos.", 503);
      }
      return texto("No encontrado", 404);
    } catch (e) {
      console.error("Error en el servicio de pases:", e && e.stack || e);
      return texto("No se pudo generar el pase en este momento. Intenta de nuevo en un rato.", 500);
    }
  },
};

/* --- Lectura del carnet ---------------------------------------------------
   Exactamente lo mismo que ve la clienta en su carnet web, nada más. */
async function leerCarnet(env, codigo) {
  if (codigo.length < 8) return null;
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/loyalty_carnet`, {
    method: "POST",
    headers: { "apikey": env.SUPABASE_ANON_KEY, "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
               "Content-Type": "application/json" },
    body: JSON.stringify({ p_code: codigo }),
  });
  if (!r.ok) throw new Error(`la base respondió ${r.status}`);
  return await r.json();   // null si el código no existe o el cliente está inactivo
}

/* --- La llave de cada pase --------------------------------------------------
   Apple pide un token por pase para autenticar las llamadas del iPhone. Se
   deriva del código con un secreto del servidor (HMAC), así que no hay que
   guardarlo en ningún lado y nadie puede fabricar el de otro carnet. */
async function tokenDePase(env, serial) {
  // Con un secreto vacío o corto, cualquiera podría calcular el token de
  // cualquier carnet. Mejor no responder que responder con algo falsificable.
  const secreto = env.WALLET_HMAC_SECRET || "";
  if (secreto.length < 32) throw new Error("WALLET_HMAC_SECRET falta o es demasiado corto");
  const llave = await crypto.subtle.importKey("raw", new TextEncoder().encode(secreto),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", llave, new TextEncoder().encode("apple:" + serial));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}
function igualSeguro(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function configAppleCompleta(env) {
  return !!(env.APPLE_CERT_PEM && env.APPLE_KEY_PEM && env.APPLE_WWDR_PEM &&
            env.APPLE_PASS_TYPE_ID && env.APPLE_TEAM_ID &&
            (env.WALLET_HMAC_SECRET || "").length >= 32);
}

async function pkpassDe(env, carnet) {
  return armarPkpass(carnet, IMAGENES,
    { certPem: env.APPLE_CERT_PEM, llavePem: env.APPLE_KEY_PEM, intermedioPem: env.APPLE_WWDR_PEM },
    { passTypeId: env.APPLE_PASS_TYPE_ID, teamId: env.APPLE_TEAM_ID,
      webServiceURL: `${env.WALLET_BASE_URL}/apple`,
      authenticationToken: await tokenDePase(env, carnet.card_code) });
}

function respuestaPkpass(bytes) {
  return new Response(bytes, { headers: {
    "Content-Type": "application/vnd.apple.pkpass",
    "Content-Disposition": 'attachment; filename="tutis.pkpass"',
    // Nunca en caché: cada descarga tiene que traer el saldo de hoy.
    "Cache-Control": "no-store",
    "Last-Modified": new Date().toUTCString(),
  } });
}

async function descargarApple(env, codigo) {
  if (!configAppleCompleta(env)) {
    console.log("Pase de Apple solicitado pero faltan secretos de configuración.");
    return texto("El pase de Apple Wallet todavía no está disponible.", 503);
  }
  const carnet = await leerCarnet(env, codigo);
  if (!carnet) return texto("No encontramos este carnet.", 404);
  return respuestaPkpass(await pkpassDe(env, carnet));
}

/* --- El servicio web de Apple ---------------------------------------------
   https://developer.apple.com/documentation/walletpasses/adding_a_web_service_to_update_passes
   Lo llama el iPhone solo: al agregar el pase se registra, y cuando le
   avisemos que cambiaron los puntos (fase 2, notificaciones) pide la versión
   nueva aquí. Va desde el primer pase porque un pase emitido sin servicio no
   se puede actualizar nunca. */
async function servicioApple(req, env, p, url) {
  if (p[0] === "log" && req.method === "POST") {
    const cuerpo = await req.text();
    console.log("Wallet (Apple) reporta:", cuerpo.slice(0, 2000));
    return new Response(null, { status: 200 });
  }

  // Sin configuración completa no hay nada que servir. 503 le dice al iPhone
  // "vuelve a intentar después", que es justo lo que queremos.
  if (!configAppleCompleta(env)) return new Response(null, { status: 503 });

  // Todo lo demás requiere el token del pase.
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("ApplePass ") ? auth.slice(10) : "";

  // /devices/{dispositivo}/registrations/{tipo}/{serial}
  if (p[0] === "devices" && p[2] === "registrations") {
    const dispositivo = String(p[1] || "").slice(0, 128);
    const tipo = p[3];
    if (tipo !== env.APPLE_PASS_TYPE_ID) return new Response(null, { status: 404 });

    // Qué pases de este iPhone cambiaron desde la última vez que preguntó
    // (sin token: así lo define Apple). El iPhone manda la marca que le dimos
    // la vez anterior en passesUpdatedSince; si no manda nada, son todos.
    if (req.method === "GET" && !p[4]) {
      const desde = Number(url.searchParams.get("passesUpdatedSince") || 0);
      const lista = await env.WALLET_REG.list({ prefix: `dev:${dispositivo}:` });
      const cambiados = [];
      let ultima = desde;
      for (const k of lista.keys) {
        const serial = k.name.split(":").pop();
        const upd = Number(await env.WALLET_REG.get(`upd:${serial}`) || 0);
        if (!desde || upd > desde) cambiados.push(serial);
        if (upd > ultima) ultima = upd;
      }
      if (!cambiados.length) return new Response(null, { status: 204 });
      return Response.json({ lastUpdated: String(ultima || Date.now()), serialNumbers: cambiados });
    }

    const serial = limpiarCodigo(p[4]);
    if (!igualSeguro(token, await tokenDePase(env, serial))) return new Response(null, { status: 401 });

    if (req.method === "POST") {
      const { pushToken } = await req.json().catch(() => ({}));
      const clave = `dev:${dispositivo}:${serial}`;
      const existia = await env.WALLET_REG.get(clave);
      await env.WALLET_REG.put(clave, JSON.stringify({ pushToken: String(pushToken || "").slice(0, 200), en: Date.now() }));
      // Índice inverso: qué dispositivos tienen este carnet. Es lo que va a
      // usar la fase 2 para avisarles cuando cambien los puntos.
      await env.WALLET_REG.put(`serial:${serial}:${dispositivo}`, "1");
      return new Response(null, { status: existia ? 200 : 201 });
    }
    if (req.method === "DELETE") {
      await env.WALLET_REG.delete(`dev:${dispositivo}:${serial}`);
      await env.WALLET_REG.delete(`serial:${serial}:${dispositivo}`);
      return new Response(null, { status: 200 });
    }
  }

  // /passes/{tipo}/{serial} → la versión más nueva del pase
  if (p[0] === "passes" && req.method === "GET") {
    if (p[1] !== env.APPLE_PASS_TYPE_ID) return new Response(null, { status: 404 });
    const serial = limpiarCodigo(p[2]);
    if (!igualSeguro(token, await tokenDePase(env, serial))) return new Response(null, { status: 401 });
    const carnet = await leerCarnet(env, serial);
    if (!carnet) return new Response(null, { status: 404 });
    return respuestaPkpass(await pkpassDe(env, carnet));
  }

  return new Response(null, { status: 404 });
}

/* --- Avisarle a los iPhone que cambió un saldo ------------------------------
   Lo llama la base (pg_net) cada vez que cambia el saldo de un carnet. Le
   manda a Apple un aviso VACÍO a cada iPhone que tiene ese pase; el iPhone
   entonces pregunta qué cambió y baja el pase nuevo él solo.

   El aviso va vacío a propósito, como pide Apple: los avisos no tienen
   entrega garantizada y se agrupan, así que no deben llevar información — solo
   "hay algo nuevo, ven a buscarlo".

   Apple exige firmar estos avisos con el MISMO certificado del pase (la llave
   .p8 no sirve para Wallet). El Worker lo presenta por el enlace mTLS
   APNS_CERT, que vive en el almacén de certificados de Cloudflare. */
async function notificar(req, env) {
  const secreto = env.WALLET_NOTIFY_SECRET || "";
  const dado = req.headers.get("X-Tutis-Secreto") || "";
  // Sin esto cualquiera podría hacernos mandar avisos a Apple en ráfaga, y
  // Apple castiga a quien abusa de su servicio.
  if (secreto.length < 32 || !igualSeguro(dado, secreto)) return new Response(null, { status: 401 });

  const { codigo } = await req.json().catch(() => ({}));
  const serial = limpiarCodigo(codigo);
  if (serial.length < 8) return new Response(null, { status: 400 });

  // La marca de "cambió" se guarda ANTES de avisar: es lo que el iPhone va a
  // comparar cuando pregunte qué pases cambiaron.
  await env.WALLET_REG.put(`upd:${serial}`, String(Date.now()));

  const lista = await env.WALLET_REG.list({ prefix: `serial:${serial}:` });
  if (!lista.keys.length) return Response.json({ serial, iphones: 0 });
  if (!env.APNS_CERT) {
    console.log(`Hay iPhones con el carnet ${serial}, pero falta el certificado para avisarle a Apple (APNS_CERT).`);
    return Response.json({ serial, iphones: lista.keys.length, avisados: 0, motivo: "sin APNS_CERT" }, { status: 503 });
  }

  const resultados = [];
  for (const k of lista.keys) {
    const dispositivo = k.name.slice(`serial:${serial}:`.length);
    const reg = await env.WALLET_REG.get(`dev:${dispositivo}:${serial}`, "json");
    if (!reg || !reg.pushToken) continue;
    resultados.push(await avisarAApple(env, reg.pushToken, dispositivo, serial));
  }
  const bien = resultados.filter((r) => r.status === 200).length;
  console.log(`Carnet ${serial}: ${bien} de ${resultados.length} iPhone(s) avisados.`);
  return Response.json({ serial, iphones: resultados.length, avisados: bien, resultados });
}

async function avisarAApple(env, pushToken, dispositivo, serial) {
  // El token de aviso lo dio el iPhone al registrarse. Solo puede ser
  // hexadecimal: cualquier otra cosa se descarta antes de armar la dirección.
  if (!/^[0-9a-fA-F]{32,200}$/.test(pushToken)) return { status: 0, detalle: "token inválido" };
  const r = await env.APNS_CERT.fetch(`https://api.push.apple.com/3/device/${pushToken}`, {
    method: "POST",
    headers: { "apns-topic": env.APPLE_PASS_TYPE_ID, "Content-Type": "application/json" },
    body: "{}",
  });
  let detalle = "";
  if (r.status !== 200) detalle = (await r.text().catch(() => "")).slice(0, 200);
  // 410: Apple dice que ese iPhone ya no tiene el pase. Se olvida, para no
  // seguir avisándole a un teléfono que no lo va a pedir nunca.
  if (r.status === 410) {
    await env.WALLET_REG.delete(`dev:${dispositivo}:${serial}`);
    await env.WALLET_REG.delete(`serial:${serial}:${dispositivo}`);
  }
  if (r.status !== 200) console.error(`Aviso a Apple para ${serial} respondió ${r.status}: ${detalle}`);
  return { status: r.status, detalle };
}
