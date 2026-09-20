/* ===========================================================================
   TUTI'S — Envío automático del cierre del día
   ---------------------------------------------------------------------------
   Corre solo, todas las noches, sin que nadie lo toque. Manda a cada sucursal
   su cierre, y al propietario el de todas juntas.

   Cómo encaja con el resto:
     · La base hace las cuentas (daily_closing_all). Aquí no se calcula nada
       de dinero — si el cálculo viviera en dos lugares, un día dejarían de
       coincidir y nadie sabría cuál creer.
     · La llave de servicio vive como secreto de Cloudflare, nunca en el
       navegador ni en el repositorio.
     · Cada envío queda anotado en closing_email_log, así que se puede
       comprobar si el correo de anoche salió, y un disparo doble no manda el
       reporte dos veces.

   Si falta configurar algo, NO truena: lo escribe en la bitácora y termina.
   Un cierre que no se manda es un problema; un Worker que revienta cada noche
   es ese mismo problema más ruido.
   =========================================================================== */

const OZ_POR_GRAMO = 1 / 28.349523125;

export default {
  async scheduled(evento, env, ctx) {
    ctx.waitUntil(enviarCierre(env, new Date(evento.scheduledTime)));
  },

  // Sin dirección pública: este Worker solo existe para el reloj. Se deja
  // una sola puerta, y únicamente si se configuró un secreto para ella, para
  // poder pedir el cierre de un día a mano cuando haga falta.
  async fetch(peticion, env) {
    const url = new URL(peticion.url);
    if (url.pathname !== "/enviar" || !env.TOKEN_MANUAL) {
      return new Response("No encontrado", { status: 404 });
    }
    const dado = peticion.headers.get("x-token") || "";
    if (!comparaSegura(dado, env.TOKEN_MANUAL)) {
      return new Response("No autorizado", { status: 401 });
    }
    const dia = url.searchParams.get("dia");   // opcional: 2026-09-19
    const resultado = await enviarCierre(env, new Date(), dia);
    return Response.json(resultado);
  },
};

// Comparación que tarda lo mismo acierte o no, para que no se pueda adivinar
// el token midiendo tiempos.
function comparaSegura(a, b) {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

/* --- La fecha del negocio ---------------------------------------------------
   El reloj de Cloudflare está en UTC. Si el Worker despierta a las 04:00 UTC
   y reportara "hoy", mandaría el cierre de un día que apenas empieza. Restando
   el desfase, esas 04:00 UTC son las 22:00 del día que de verdad se cerró. */
function diaLocal(ahoraUtc, desfaseHoras) {
  const t = new Date(ahoraUtc.getTime() + desfaseHoras * 3600 * 1000);
  return t.toISOString().slice(0, 10);
}

async function enviarCierre(env, ahora, diaForzado) {
  const faltan = [];
  if (!env.SUPABASE_URL)         faltan.push("SUPABASE_URL");
  if (!env.SUPABASE_SERVICE_KEY) faltan.push("SUPABASE_SERVICE_KEY");
  if (!env.RESEND_API_KEY)       faltan.push("RESEND_API_KEY");
  if (faltan.length) {
    console.log(`Cierre no enviado: falta configurar ${faltan.join(", ")}. ` +
                `Se configura con: npx wrangler secret put <NOMBRE>`);
    return { ok: false, motivo: "configuración incompleta", faltan };
  }

  const desfase = Number(env.UTC_OFFSET_HOURS ?? -6);
  const dia = diaForzado || diaLocal(ahora, desfase);
  console.log(`Preparando el cierre del ${dia}…`);

  let cierres;
  try {
    cierres = await pedirCierres(env, dia, desfase);
  } catch (e) {
    console.error(`No se pudo leer el cierre: ${e.message}`);
    return { ok: false, motivo: e.message };
  }
  if (!cierres.length) {
    console.log("No hay sucursales activas.");
    return { ok: true, dia, enviados: 0 };
  }

  const resultados = [];

  // 1. A cada tienda, lo suyo.
  for (const c of cierres) {
    const para = (c.report_email || "").trim();
    if (!para) {
      console.log(`${c.location_name}: sin correo configurado, se omite.`);
      continue;
    }
    resultados.push(await mandarYAnotar(env, {
      dia, locationId: c.location_id, para,
      asunto: `Cierre del ${formatoFecha(dia)} — ${c.location_name}`,
      html: correoDeUnaTienda(c, dia),
    }));
  }

  // 2. Al propietario, todas juntas. Es lo que pidió: por tienda Y consolidado.
  const dueños = (env.CORREO_PROPIETARIO || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const para of dueños) {
    resultados.push(await mandarYAnotar(env, {
      dia, locationId: null, para,
      asunto: `Cierre del ${formatoFecha(dia)} — todas las tiendas`,
      html: correoConsolidado(cierres, dia),
    }));
  }

  const bien = resultados.filter((r) => r.ok).length;
  console.log(`Cierre del ${dia}: ${bien} de ${resultados.length} correo(s) enviados.`);
  return { ok: true, dia, enviados: bien, total: resultados.length, detalle: resultados };
}

/* --- Hablar con la base ---------------------------------------------------- */
async function pedirCierres(env, dia, desfase) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/daily_closing_all`, {
    method: "POST",
    headers: {
      "apikey": env.SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_day: dia, p_utc_offset_hours: desfase }),
  });
  if (!r.ok) throw new Error(`la base respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return await r.json();
}

async function anotar(env, fila) {
  // Si ya se anotó ese envío hoy, el índice único lo rechaza: eso es lo que
  // evita que un disparo doble mande el correo dos veces.
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/closing_email_log`, {
    method: "POST",
    headers: {
      "apikey": env.SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(fila),
  });
  return r.ok;
}

async function yaSeEnvio(env, dia, locationId, para) {
  const filtroLoc = locationId ? `location_id=eq.${locationId}` : "location_id=is.null";
  const url = `${env.SUPABASE_URL}/rest/v1/closing_email_log` +
              `?day=eq.${dia}&${filtroLoc}&recipient=eq.${encodeURIComponent(para)}&ok=is.true&select=id&limit=1`;
  const r = await fetch(url, {
    headers: { "apikey": env.SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}` },
  });
  if (!r.ok) return false;
  return (await r.json()).length > 0;
}

async function mandarYAnotar(env, { dia, locationId, para, asunto, html }) {
  if (await yaSeEnvio(env, dia, locationId, para)) {
    console.log(`${para}: ya se le había enviado el cierre del ${dia}, se omite.`);
    return { para, ok: true, omitido: true };
  }
  let ok = false, detalle = "";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.REMITENTE, to: [para], subject: asunto, html }),
    });
    ok = r.ok;
    detalle = ok ? "enviado" : `Resend respondió ${r.status}: ${(await r.text()).slice(0, 300)}`;
  } catch (e) {
    detalle = `no se pudo enviar: ${e.message}`;
  }
  if (!ok) console.error(`${para}: ${detalle}`);
  await anotar(env, { day: dia, location_id: locationId, recipient: para, ok, detail: detalle });
  return { para, ok, detalle };
}

/* --- El correo -------------------------------------------------------------
   Arial y tablas, como el resto del sistema. Sin enlaces al sitio: el dueño
   pidió que no aparezca en lo que se imprime o se manda.
   Los estilos van dentro de cada etiqueta porque los programas de correo
   descartan las hojas de estilo. */
const esc = (v) => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const n2 = (v) => (Number(v) || 0).toFixed(2);
const dinero = (c, v) => `${esc(c || "")} ${n2(v)}`;

// Cada tienda ve los pesos en la unidad con la que trabaja, con la otra entre
// paréntesis. Es la misma regla que en pantalla.
function peso(gramos, unidad) {
  const g = Number(gramos) || 0, oz = g * OZ_POR_GRAMO;
  return unidad === "oz" ? `${n2(oz)} oz (${n2(g)} g)` : `${n2(g)} g (${n2(oz)} oz)`;
}

function formatoFecha(iso) {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

const CSS_TABLA = 'style="border-collapse:collapse;width:100%;font-family:Arial,Helvetica,sans-serif;font-size:14px"';
const TD  = 'style="padding:7px 10px;border-bottom:1px solid #DCE6E3"';
const TDN = 'style="padding:7px 10px;border-bottom:1px solid #DCE6E3;text-align:right"';
const TH  = 'style="padding:7px 10px;border-bottom:2px solid #C97A25;text-align:left;font-size:12px;color:#56717A;text-transform:uppercase"';
const THN = 'style="padding:7px 10px;border-bottom:2px solid #C97A25;text-align:right;font-size:12px;color:#56717A;text-transform:uppercase"';

function envoltura(titulo, cuerpo) {
  // Sin esta declaración de codificación, los acentos llegan rotos
  // ("GalerÃ­as"). Muchos programas de correo no adivinan bien la
  // codificación, y este reporte está lleno de acentos.
  return `<!DOCTYPE html><html lang="es"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(titulo)}</title>
  </head><body style="margin:0;padding:20px;background:#F4F7F6;font-family:Arial,Helvetica,sans-serif;color:#12303A">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:14px;padding:26px">
    <h1 style="margin:0 0 4px;font-size:19px;font-family:Arial,Helvetica,sans-serif">${esc(titulo)}</h1>
    ${cuerpo}
    <p style="margin-top:26px;font-size:11px;color:#56717A;font-family:Arial,Helvetica,sans-serif">
      Reporte generado automáticamente por el punto de venta. No es un documento fiscal.
    </p>
  </div></body></html>`;
}

function bloqueTienda(c) {
  const u = c.weight_unit === "oz" ? "oz" : "g";
  const moneda = c.currency_code;
  const filas = [
    ["Ventas registradas", String(c.ventas)],
    ["Vasos vendidos", String(c.vasos)],
    ["Cucharas vendidas", String(c.cucharas)],
    ["Peso de helado vendido", peso(c.peso_helado_g, u)],
    ["Peso de toppings vendido", peso(c.peso_toppings_g, u)],
    ["Ingresos", dinero(moneda, c.ingresos)],
    ["Costo del producto", dinero(moneda, c.costos)],
    ["Margen", dinero(moneda, c.margen)],
    ["Gastos del día", dinero(moneda, c.gastos)],
  ].map(([k, v]) => `<tr><td ${TD}>${esc(k)}</td><td ${TDN}><strong>${esc(v)}</strong></td></tr>`).join("");

  const util = Number(c.utilidad) || 0;
  const colorUtil = util >= 0 ? "#0F8A5F" : "#B14328";

  const tops = (c.toppings || []).length
    ? (c.toppings || []).map((t) =>
        `<tr><td ${TD}>${esc(t.name)}</td><td ${TDN}>${esc(peso(t.peso_g, u))}</td><td ${TDN}>${esc(n2(t.pct))}%</td></tr>`).join("")
    : `<tr><td ${TD} colspan="3" style="padding:7px 10px;color:#56717A">No se vendieron toppings ese día.</td></tr>`;

  return `
  <table ${CSS_TABLA}>${filas}
    <tr><td ${TD}><strong>Utilidad del día</strong></td>
        <td ${TDN}><strong style="color:${colorUtil};font-size:16px">${esc(dinero(moneda, util))}</strong></td></tr>
  </table>
  <h3 style="margin:22px 0 6px;font-size:14px;font-family:Arial,Helvetica,sans-serif">Toppings vendidos</h3>
  <table ${CSS_TABLA}>
    <tr><th ${TH}>Topping</th><th ${THN}>Peso</th><th ${THN}>% del total</th></tr>
    ${tops}
  </table>`;
}

function correoDeUnaTienda(c, dia) {
  return envoltura(`${c.location_name} — cierre del ${formatoFecha(dia)}`,
    `<p style="margin:0 0 18px;color:#56717A;font-size:13px;font-family:Arial,Helvetica,sans-serif">${esc(c.legal_name || "")}</p>` +
    bloqueTienda(c));
}

function correoConsolidado(cierres, dia) {
  const total = cierres.reduce((a, c) => ({
    ventas:   a.ventas   + Number(c.ventas || 0),
    ingresos: a.ingresos + Number(c.ingresos || 0),
    gastos:   a.gastos   + Number(c.gastos || 0),
    utilidad: a.utilidad + Number(c.utilidad || 0),
    vasos:    a.vasos    + Number(c.vasos || 0),
  }), { ventas: 0, ingresos: 0, gastos: 0, utilidad: 0, vasos: 0 });

  // Si las tiendas manejan monedas distintas, sumar el dinero no significa
  // nada. Se avisa en vez de mostrar un total falso — la misma regla que en
  // la aplicación.
  const monedas = [...new Set(cierres.map((c) => c.currency_code))];
  const aviso = monedas.length > 1
    ? `<p style="background:#FBF0D4;color:#8A6100;padding:10px;border-radius:8px;font-size:13px;font-family:Arial,Helvetica,sans-serif">
         Las tiendas manejan monedas distintas (${esc(monedas.join(", "))}). Los totales en dinero de abajo no son comparables; mira cada tienda por separado.</p>`
    : "";

  const resumen = cierres.map((c) =>
    `<tr><td ${TD}>${esc(c.location_name)}</td>
         <td ${TDN}>${esc(String(c.ventas))}</td>
         <td ${TDN}>${esc(dinero(c.currency_code, c.ingresos))}</td>
         <td ${TDN}>${esc(dinero(c.currency_code, c.gastos))}</td>
         <td ${TDN}><strong style="color:${Number(c.utilidad) >= 0 ? "#0F8A5F" : "#B14328"}">${esc(dinero(c.currency_code, c.utilidad))}</strong></td></tr>`).join("");

  const detalle = cierres.map((c) =>
    `<h2 style="margin:28px 0 8px;font-size:16px;border-top:1px solid #DCE6E3;padding-top:18px;font-family:Arial,Helvetica,sans-serif">${esc(c.location_name)}</h2>` +
    bloqueTienda(c)).join("");

  return envoltura(`Cierre del ${formatoFecha(dia)} — todas las tiendas`,
    aviso +
    `<table ${CSS_TABLA}>
      <tr><th ${TH}>Tienda</th><th ${THN}>Ventas</th><th ${THN}>Ingresos</th><th ${THN}>Gastos</th><th ${THN}>Utilidad</th></tr>
      ${resumen}
      <tr><td ${TD}><strong>Total</strong></td>
          <td ${TDN}><strong>${total.ventas}</strong></td>
          <td ${TDN}><strong>${esc(monedas.length === 1 ? dinero(monedas[0], total.ingresos) : "—")}</strong></td>
          <td ${TDN}><strong>${esc(monedas.length === 1 ? dinero(monedas[0], total.gastos) : "—")}</strong></td>
          <td ${TDN}><strong>${esc(monedas.length === 1 ? dinero(monedas[0], total.utilidad) : "—")}</strong></td></tr>
    </table>` + detalle);
}
