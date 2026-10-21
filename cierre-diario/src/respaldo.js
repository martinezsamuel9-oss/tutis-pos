/* ===========================================================================
   TUTI'S — Respaldo nocturno de la base
   ---------------------------------------------------------------------------
   El plan gratuito de Supabase no deja descargar respaldos. Este respaldo lo
   suple: cada noche, después del cierre, copia TODAS las tablas del sistema a
   un almacenamiento aparte (R2 de Cloudflare, binding RESPALDOS), fuera de
   Supabase. Si un día se pierde el proyecto, ahí están las ventas.

   Cómo queda guardado:
       2026-10-21/sales-000.json        bloques de hasta 20 000 filas
       2026-10-21/sale_lines-000.json
       …
       2026-10-21/manifiesto.json       se escribe AL FINAL: si no está, ese
                                        respaldo quedó a medias y no sirve.

   Cuánto se guarda: los últimos 7 días, los domingos de las últimas 8
   semanas y el día 1 de cada mes para siempre.

   Por qué así y no de otra forma:
     · Los datos se copian tal cual llegan, sin leerlos ni comprimirlos: el
       plan gratuito de Workers da 10 ms de CPU por ejecución, y abrir o
       comprimir megas de JSON se los comería. Copiar bytes casi no gasta CPU.
     · Lo cuenta y lo trocea la base (respaldo_conteo / respaldo_tabla, en
       sql/12): la API normal entrega 1000 filas por llamada y el plan
       gratuito permite 50 llamadas externas por ejecución.
     · No se respaldan hashes de contraseñas ni de PIN. De los usuarios va
       solo el correo; restaurar implica volver a crear sus accesos.
   =========================================================================== */

const BLOQUE = 20000;

export async function respaldar(env, dia) {
  if (!env.RESPALDOS) {
    console.log("Respaldo omitido: falta el almacenamiento RESPALDOS en wrangler.jsonc.");
    return { ok: false, motivo: "sin almacenamiento" };
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    console.log("Respaldo omitido: faltan SUPABASE_URL o SUPABASE_SERVICE_KEY.");
    return { ok: false, motivo: "configuración incompleta" };
  }
  try {
    const conteo = await rpc(env, "respaldo_conteo", {}).then((r) => r.json());
    const archivos = [];
    let bytes = 0;
    for (const [tabla, filas] of Object.entries(conteo)) {
      const bloques = Math.max(1, Math.ceil(Number(filas) / BLOQUE));
      for (let b = 0; b < bloques; b++) {
        const r = await rpc(env, "respaldo_tabla", { p_tabla: tabla, p_desde: b * BLOQUE, p_limite: BLOQUE });
        const datos = await r.arrayBuffer();
        const clave = `${dia}/${tabla}-${String(b).padStart(3, "0")}.json`;
        await env.RESPALDOS.put(clave, datos, { httpMetadata: { contentType: "application/json" } });
        archivos.push(clave); bytes += datos.byteLength;
      }
    }
    // El manifiesto va al final: es la marca de que el respaldo está completo.
    await env.RESPALDOS.put(`${dia}/manifiesto.json`, JSON.stringify({
      dia, hecho: new Date().toISOString(), filas: conteo, archivos, bytes,
    }, null, 2), { httpMetadata: { contentType: "application/json" } });
    const borrados = await podar(env.RESPALDOS, dia);
    console.log(`Respaldo del ${dia}: ${archivos.length} archivo(s), ${(bytes / 1048576).toFixed(2)} MB. Se borraron ${borrados} respaldo(s) viejos.`);
    return { ok: true, dia, archivos: archivos.length, bytes, borrados };
  } catch (e) {
    console.error(`Respaldo del ${dia} falló: ${e.message}`);
    return { ok: false, motivo: e.message };
  }
}

async function rpc(env, nombre, args) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${nombre}`, {
    method: "POST",
    headers: {
      "apikey": env.SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${nombre} respondió ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

// Qué días se conservan, contando desde `hoy` (AAAA-MM-DD).
export function seQueda(diaRespaldo, hoy) {
  const d = new Date(diaRespaldo + "T12:00:00Z"), h = new Date(hoy + "T12:00:00Z");
  const edad = Math.round((h - d) / 864e5);
  if (edad < 0) return true;
  if (edad < 7) return true;                           // la última semana completa
  if (d.getUTCDay() === 0 && edad < 56) return true;   // domingos de 8 semanas
  return d.getUTCDate() === 1;                          // el 1 de cada mes, siempre
}

async function podar(bucket, hoy) {
  const dias = [];
  let cursor;
  do {
    const l = await bucket.list({ delimiter: "/", cursor });
    l.delimitedPrefixes.forEach((p) => dias.push(p.replace(/\/$/, "")));
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  let borrados = 0;
  for (const d of dias) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || seQueda(d, hoy)) continue;
    let c;
    do {
      const l = await bucket.list({ prefix: `${d}/`, cursor: c });
      if (l.objects.length) await bucket.delete(l.objects.map((o) => o.key));
      c = l.truncated ? l.cursor : undefined;
    } while (c);
    borrados++;
  }
  return borrados;
}
