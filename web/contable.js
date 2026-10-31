/* ===========================================================================
   TUTI'S — Libro contable: diario, mayor, balanza, resultados y asientos
   ---------------------------------------------------------------------------
   Se carga después de app.js, clientes.js e inventario.js y comparte con
   ellos el ámbito global: todo lo de aquí empieza con "cont" o "CONT" para
   no pisar nada (la prueba 0 de prueba_caja.mjs lo revisa).
   Las cuentas las hace la base (sql/25: cont_diario y cont_balanza); esta
   pantalla solo las muestra. El mayor y el estado de resultados se arman
   con lo que ya devolvieron el diario y la balanza.
   =========================================================================== */
"use strict";

const CONT = { panel: "diario", diario: null, balanza: null, cuentas: [], config: null, ids: {}, lineas: [], loaded: false, nueva: false };
const CONT_OFICINA = "__oficina";
const CONT_TIPOS = { activo: "Activo", pasivo: "Pasivo", patrimonio: "Patrimonio", ingreso: "Ingreso", costo: "Costo", gasto: "Gasto" };
const CONT_ORIGEN = { ventas: "Ventas", costo: "Costo de ventas", compra: "Compra", gasto: "Gasto", caja: "Caja", arqueo: "Arqueo", manual: "Manual" };
const CONT_DIARIO_MAX = 93, CONT_BALANZA_MAX = 367;

const contN = (v) => (Number(v) || 0).toLocaleString("es-HN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const contMonto = (v) => (Number(v) ? contN(v) : "");
// Saldo con su naturaleza: D deudor, A acreedor.
const contSaldo = (v) => (Math.abs(Number(v) || 0) < 0.005 ? "0.00" : `${contN(Math.abs(v))} ${v < 0 ? "A" : "D"}`);
function contLoc() { const v = $("cont-location").value; return v === CONT_OFICINA ? null : (v || STATE.activeLocationId); }
function contPuedeOficina() { return isOwner() || (rol() === "contabilidad" && !!(STATE.profile && STATE.profile.todas_tiendas)); }
function contMoneda() {
  const l = STATE.locations.find((x) => x.id === contLoc()) || STATE.locations.find((x) => x.active) || {};
  return l.currency_code || "";
}
function contDias() { return Math.round((new Date($("cont-hasta").value) - new Date($("cont-desde").value)) / 864e5) + 1; }
function contMensaje(error) {
  const m = (error && error.message) || "";
  if (/cont_cuentas_codigo_key/.test(m)) return "Ese código ya es de otra cuenta.";
  if (/cont_cuentas_codigo_check/.test(m)) return "El código lleva solo números (hasta 10).";
  if (/cont_cuentas_nombre_check/.test(m)) return "Escribe el nombre de la cuenta.";
  if (/network|fetch/i.test(m)) return "Sin conexión. Inténtalo cuando vuelva el internet.";
  return m || "No se pudo guardar.";
}

function contLlenarFiltros() {
  const sel = $("cont-location"), keep = sel.value;
  const tiendas = veTodas() ? STATE.locations.filter((l) => l.active) : STATE.locations.filter((l) => l.id === STATE.activeLocationId);
  sel.innerHTML = tiendas.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("") +
    (contPuedeOficina() ? `<option value="${CONT_OFICINA}">Oficina (compras sin tienda)</option>` : "");
  sel.value = keep && [...sel.options].some((o) => o.value === keep) ? keep : (STATE.activeLocationId || (tiendas[0] || {}).id || "");
  if (!$("cont-desde").value) {
    const d = new Date(); $("cont-hasta").value = localDateStr(d); d.setDate(1); $("cont-desde").value = localDateStr(d);
  }
  if (!$("as-fecha").value) $("as-fecha").value = localDateStr(new Date());
}
function abrirContable() { contLlenarFiltros(); if (!CONT.loaded) cargarContable(); }

async function cargarContable() {
  if (!sb || !navigator.onLine) { $("cont-msg").textContent = "El libro contable necesita conexión a internet."; return; }
  const loc = contLoc(), desde = $("cont-desde").value, hasta = $("cont-hasta").value, dias = contDias();
  if (!desde || !hasta || dias < 1) { $("cont-msg").textContent = "Revisa las fechas."; return; }
  if (dias > CONT_BALANZA_MAX) { $("cont-msg").textContent = "La balanza y el estado de resultados van hasta un año."; return; }
  $("cont-msg").textContent = "Cargando…";
  const asientos = sb.from("cont_asientos").select("id, numero").gte("fecha", desde).lte("fecha", hasta);
  const [di, ba, cu, cf, as] = await Promise.all([
    dias <= CONT_DIARIO_MAX ? sb.rpc("cont_diario", { p_location: loc, p_desde: desde, p_hasta: hasta }) : Promise.resolve({ data: null }),
    sb.rpc("cont_balanza", { p_location: loc, p_desde: desde, p_hasta: hasta }),
    sb.from("cont_cuentas").select("*").order("codigo"),
    sb.from("cont_config").select("*").maybeSingle(),
    loc ? asientos.eq("location_id", loc) : asientos.is("location_id", null),
  ]);
  const err = di.error || ba.error;
  if (err) { $("cont-msg").textContent = contMensaje(err); return; }
  CONT.diario = di.data; CONT.balanza = ba.data;
  CONT.cuentas = cu.data || []; CONT.config = cf.data || null;
  CONT.ids = {}; (as.data || []).forEach((a) => { CONT.ids[String(a.numero)] = a.id; });
  CONT.loaded = true;
  $("cont-msg").textContent = `Montos en ${contMoneda()}.` + (CONT.diario ? "" : ` El diario y el mayor van hasta ${CONT_DIARIO_MAX} días: acorta las fechas para verlos.`);
  if (!CONT.lineas.length) CONT.lineas = [{ cuenta_id: "", detalle: "", debe: "", haber: "" }, { cuenta_id: "", detalle: "", debe: "", haber: "" }];
  pintarContable();
}

function pintarContable() {
  document.querySelectorAll("#cont-seg button").forEach((b) => b.classList.toggle("active", b.dataset.cont === CONT.panel));
  document.querySelectorAll(".cont-panel").forEach((p) => { p.hidden = p.dataset.contPanel !== CONT.panel; });
  contPintarDiario();
  contPintarMayor();
  contPintarBalanza();
  contPintarResultados();
  contPintarAsiento();
  contPintarCuentas();
}

/* --- Diario -------------------------------------------------------------------- */
function contPintarDiario() {
  const body = document.querySelector("#table-diario tbody");
  const d = CONT.diario;
  if (!d) { body.innerHTML = `<tr><td colspan="7" class="hint">El diario va hasta ${CONT_DIARIO_MAX} días.</td></tr>`; $("cont-anulados").innerHTML = ""; $("cont-diario-avisos").innerHTML = ""; return; }
  const avisos = [];
  if (Math.abs(Number(d.debe) - Number(d.haber)) > 0.005) avisos.push(`<div class="alert bad">El diario no cuadra: debe ${contN(d.debe)} y haber ${contN(d.haber)}. Avísale a soporte técnico.</div>`);
  if (Number(d.sin_cuenta)) avisos.push(`<div class="alert warn">Hay ${Number(d.sin_cuenta)} línea(s) automáticas sin cuenta: alguien quitó una cuenta que usan los asientos automáticos.</div>`);
  $("cont-diario-avisos").innerHTML = avisos.join("");
  const borra = canAccount();
  body.innerHTML = (d.asientos || []).length ? d.asientos.map((a) => a.lineas.map((l, k) => {
    const manual = a.origen === "manual";
    return `<tr class="${k === 0 ? "asiento-ini" : ""}">
      <td>${k === 0 ? esc(contFecha(a.fecha)) : ""}</td>
      <td>${k === 0 ? `<span class="hint">${esc(CONT_ORIGEN[a.origen] || a.origen)}${manual ? ` #${esc(a.ref)}` : ""}</span> ${esc(a.concepto)}` : ""}</td>
      <td>${esc(l.codigo || "")}</td><td class="${Number(l.haber) ? "cont-haber" : ""}">${esc(l.nombre || "(sin cuenta)")}</td>
      <td class="num">${contMonto(l.debe)}</td><td class="num">${contMonto(l.haber)}</td>
      <td>${k === 0 && manual && borra && CONT.ids[a.ref] ? `<button class="icon-btn delete" type="button" data-anular="${esc(CONT.ids[a.ref])}" title="Anular asiento" aria-label="Anular asiento #${esc(a.ref)}">${ICON_TRASH}</button>` : ""}</td></tr>`;
  }).join("")).join("") +
    `<tr class="total"><td></td><td><strong>Total</strong></td><td></td><td></td><td class="num"><strong>${contN(d.debe)}</strong></td><td class="num"><strong>${contN(d.haber)}</strong></td><td></td></tr>`
    : '<tr><td colspan="7" class="hint">No hay movimientos en esas fechas.</td></tr>';
  $("cont-anulados").innerHTML = (d.anulados || []).length ? `<h3>Asientos anulados</h3><ul class="hint">${d.anulados.map((x) =>
    `<li>#${esc(x.numero)} · ${esc(contFecha(x.fecha))} · ${esc(x.concepto)} — <em>${esc(x.motivo)}</em></li>`).join("")}</ul>` : "";
}
function contFecha(iso) { const [y, m, d] = String(iso).slice(0, 10).split("-"); return `${d}/${m}/${y}`; }

$("table-diario").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-anular]");
  if (!b) return;
  const motivo = prompt("¿Por qué se anula este asiento? Queda registrado con tu nombre. Un asiento anulado no se borra: sale del diario y queda en la lista de anulados.");
  if (motivo === null) return;
  const { error } = await sb.rpc("cont_anular_asiento", { p_id: b.dataset.anular, p_motivo: motivo.trim() });
  if (error) { $("cont-msg").textContent = contMensaje(error); return; }
  await cargarContable();
});

/* --- Mayor --------------------------------------------------------------------- */
function contPintarMayor() {
  const sel = $("cont-mayor-cuenta"), keep = sel.value;
  const cuentas = (CONT.balanza && CONT.balanza.cuentas) || [];
  sel.innerHTML = cuentas.map((c) => `<option value="${esc(c.cuenta_id)}">${esc(c.codigo)} · ${esc(c.nombre)}</option>`).join("");
  if (keep && cuentas.some((c) => c.cuenta_id === keep)) sel.value = keep;
  const body = document.querySelector("#table-mayor tbody");
  const c = cuentas.find((x) => x.cuenta_id === sel.value);
  if (!c) { body.innerHTML = '<tr><td colspan="5" class="hint">Ninguna cuenta tiene movimientos.</td></tr>'; return; }
  if (!CONT.diario) { body.innerHTML = `<tr><td colspan="5" class="hint">El mayor va hasta ${CONT_DIARIO_MAX} días.</td></tr>`; return; }
  let saldo = Number(c.anterior);
  const filas = [`<tr><td></td><td><em>Saldo anterior</em></td><td></td><td></td><td class="num">${contSaldo(saldo)}</td></tr>`];
  CONT.diario.asientos.forEach((a) => a.lineas.filter((l) => l.cuenta_id === c.cuenta_id).forEach((l) => {
    saldo += Number(l.debe) - Number(l.haber);
    filas.push(`<tr><td>${esc(contFecha(a.fecha))}</td><td>${esc(a.concepto)}</td><td class="num">${contMonto(l.debe)}</td><td class="num">${contMonto(l.haber)}</td><td class="num">${contSaldo(saldo)}</td></tr>`);
  }));
  filas.push(`<tr class="total"><td></td><td><strong>Saldo final</strong></td><td class="num">${contN(c.debe)}</td><td class="num">${contN(c.haber)}</td><td class="num"><strong>${contSaldo(c.final)}</strong></td></tr>`);
  body.innerHTML = filas.join("");
}
$("cont-mayor-cuenta").addEventListener("change", contPintarMayor);

/* --- Balanza ------------------------------------------------------------------- */
function contPintarBalanza() {
  const body = document.querySelector("#table-balanza tbody");
  const b = CONT.balanza;
  if (!b || !b.cuentas.length) { body.innerHTML = '<tr><td colspan="7" class="hint">No hay movimientos.</td></tr>'; return; }
  let deu = 0, acr = 0;
  body.innerHTML = b.cuentas.map((c) => {
    const f = Number(c.final);
    if (f > 0) deu += f; else acr -= f;
    return `<tr><td>${esc(c.codigo)}</td><td>${esc(c.nombre)}</td><td class="num">${contSaldo(c.anterior)}</td>
      <td class="num">${contMonto(c.debe)}</td><td class="num">${contMonto(c.haber)}</td>
      <td class="num">${f > 0.005 ? contN(f) : ""}</td><td class="num">${f < -0.005 ? contN(-f) : ""}</td></tr>`;
  }).join("") + `<tr class="total"><td></td><td><strong>Total</strong></td><td></td><td class="num"><strong>${contN(b.debe)}</strong></td>
      <td class="num"><strong>${contN(b.haber)}</strong></td><td class="num"><strong>${contN(deu)}</strong></td><td class="num"><strong>${contN(acr)}</strong></td></tr>` +
    (Math.abs(deu - acr) > 0.005 || Math.abs(Number(b.debe) - Number(b.haber)) > 0.005
      ? '<tr><td colspan="7"><div class="alert bad">La balanza no cuadra. Avísale a soporte técnico.</div></td></tr>' : "");
}

/* --- Estado de resultados ------------------------------------------------------- */
// Lo del periodo (no el saldo anterior): ingresos haber − debe; costos y gastos debe − haber.
function contResultados() {
  const cuentas = ((CONT.balanza && CONT.balanza.cuentas) || []).filter((c) => ["ingreso", "costo", "gasto"].includes(c.tipo));
  const de = (tipo) => cuentas.filter((c) => c.tipo === tipo).map((c) => ({ ...c,
    monto: r2(tipo === "ingreso" ? Number(c.haber) - Number(c.debe) : Number(c.debe) - Number(c.haber)) }))
    .filter((c) => Math.abs(c.monto) >= 0.005);
  const ing = de("ingreso"), cos = de("costo"), gas = de("gasto");
  const suma = (l) => r2(l.reduce((a, c) => a + c.monto, 0));
  const tI = suma(ing), tC = suma(cos), tG = suma(gas);
  return { ing, cos, gas, tI, tC, tG, bruta: r2(tI - tC), neta: r2(tI - tC - tG) };
}
function contPintarResultados() {
  $("cont-res-sub").textContent = `Del ${contFecha($("cont-desde").value)} al ${contFecha($("cont-hasta").value)}, en ${contMoneda()}. Antes del impuesto sobre la renta. El costo de ventas sale del costo de cada línea vendida.`;
  const r = contResultados();
  const pct = (v) => (r.tI ? ` <span class="hint">(${contN(v / r.tI * 100)} %)</span>` : "");
  const filas = (l) => l.map((c) => `<tr><td class="cont-sangria">${esc(c.codigo)} · ${esc(c.nombre)}</td><td class="num">${contN(c.monto)}</td></tr>`).join("");
  const total = (t, v, extra = "") => `<tr class="total"><td><strong>${t}</strong></td><td class="num"><strong>${contN(v)}</strong>${extra}</td></tr>`;
  const res = r.neta >= 0 ? `<span class="dif-ok">Utilidad del periodo</span>` : `<span class="dif-mal">Pérdida del periodo</span>`;
  document.querySelector("#table-resultados tbody").innerHTML =
    `<tr><th colspan="2">Ingresos</th></tr>${filas(r.ing)}${total("Ingresos netos", r.tI)}` +
    `<tr><th colspan="2">Costo de ventas</th></tr>${filas(r.cos)}${total("Utilidad bruta", r.bruta, pct(r.bruta))}` +
    `<tr><th colspan="2">Gastos</th></tr>${filas(r.gas)}${total("Total de gastos", r.tG)}` +
    `<tr class="total cont-final"><td><strong>${res}</strong></td><td class="num"><strong>${contN(r.neta)}</strong>${pct(r.neta)}</td></tr>`;
}

/* --- Asiento manual ------------------------------------------------------------- */
function contOpcionesCuenta(v) {
  return '<option value="">— Cuenta —</option>' + Object.entries(CONT_TIPOS).map(([t, n]) => {
    const cs = CONT.cuentas.filter((c) => c.tipo === t && (c.activa || c.id === v));
    return cs.length ? `<optgroup label="${n}">${cs.map((c) => `<option value="${esc(c.id)}"${c.id === v ? " selected" : ""}>${esc(c.codigo)} · ${esc(c.nombre)}</option>`).join("")}</optgroup>` : "";
  }).join("");
}
function contPintarAsiento() {
  document.querySelector("#table-as-lineas tbody").innerHTML = CONT.lineas.map((l, k) => `<tr data-k="${k}">
    <td><select class="as-cuenta" aria-label="Cuenta de la línea ${k + 1}">${contOpcionesCuenta(l.cuenta_id)}</select></td>
    <td><input class="as-detalle" maxlength="200" value="${esc(l.detalle)}" aria-label="Detalle de la línea ${k + 1}"></td>
    <td><input class="as-debe num" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(l.debe)}" aria-label="Debe de la línea ${k + 1}"></td>
    <td><input class="as-haber num" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(l.haber)}" aria-label="Haber de la línea ${k + 1}"></td>
    <td>${CONT.lineas.length > 2 ? `<button class="icon-btn delete" type="button" data-quitar title="Quitar línea" aria-label="Quitar línea ${k + 1}">${ICON_TRASH}</button>` : ""}</td></tr>`).join("");
  contTotalesAsiento();
}
function contTotalesAsiento() {
  const d = r2(CONT.lineas.reduce((a, l) => a + (Number(l.debe) || 0), 0)), h = r2(CONT.lineas.reduce((a, l) => a + (Number(l.haber) || 0), 0));
  $("as-totales").innerHTML = `Debe ${contN(d)} · Haber ${contN(h)} · ` +
    (d > 0 && Math.abs(d - h) < 0.005 ? '<span class="dif-ok">Cuadra</span>' : `<span class="dif-mal">Diferencia ${contN(Math.abs(d - h))}</span>`);
}
$("table-as-lineas").addEventListener("input", (e) => {
  const tr = e.target.closest("tr[data-k]");
  if (!tr) return;
  const l = CONT.lineas[Number(tr.dataset.k)];
  // Una línea va en el debe o en el haber: escribir en uno limpia el otro.
  if (e.target.classList.contains("as-debe")) { l.debe = e.target.value; if (l.debe) { l.haber = ""; tr.querySelector(".as-haber").value = ""; } }
  if (e.target.classList.contains("as-haber")) { l.haber = e.target.value; if (l.haber) { l.debe = ""; tr.querySelector(".as-debe").value = ""; } }
  if (e.target.classList.contains("as-detalle")) l.detalle = e.target.value;
  if (e.target.classList.contains("as-cuenta")) l.cuenta_id = e.target.value;
  contTotalesAsiento();
});
$("table-as-lineas").addEventListener("change", (e) => {
  const tr = e.target.closest("tr[data-k]");
  if (tr && e.target.classList.contains("as-cuenta")) CONT.lineas[Number(tr.dataset.k)].cuenta_id = e.target.value;
});
$("table-as-lineas").addEventListener("click", (e) => {
  if (!e.target.closest("[data-quitar]")) return;
  CONT.lineas.splice(Number(e.target.closest("tr").dataset.k), 1);
  contPintarAsiento();
});
$("btn-as-linea").addEventListener("click", () => { CONT.lineas.push({ cuenta_id: "", detalle: "", debe: "", haber: "" }); contPintarAsiento(); });
$("btn-as-guardar").addEventListener("click", async () => {
  const msg = $("as-msg");
  const lineas = CONT.lineas.filter((l) => l.cuenta_id || Number(l.debe) || Number(l.haber))
    .map((l) => ({ cuenta_id: l.cuenta_id, detalle: l.detalle.trim() || null, debe: Number(l.debe) || 0, haber: Number(l.haber) || 0 }));
  if (lineas.some((l) => !l.cuenta_id)) { msg.textContent = "Cada línea con monto necesita su cuenta."; return; }
  const btn = $("btn-as-guardar"); btn.disabled = true;
  const { data, error } = await sb.rpc("cont_guardar_asiento", { p: { location_id: contLoc(), fecha: $("as-fecha").value,
    concepto: $("as-concepto").value.trim(), lineas } });
  btn.disabled = false;
  if (error) { msg.textContent = contMensaje(error); return; }
  CONT.lineas = [];
  $("as-concepto").value = "";
  await cargarContable();
  $("as-msg").textContent = `Asiento #${data.numero} guardado por ${contN(data.total)}.`;
});

/* --- Catálogo de cuentas ---------------------------------------------------------- */
function contPuedeCatalogo() { return contPuedeOficina(); }
function contPintarCuentas() {
  const puede = contPuedeCatalogo(), dis = puede ? "" : "disabled";
  $("btn-cta-nueva").hidden = !puede;
  const tipos = (v) => Object.entries(CONT_TIPOS).map(([k, n]) => `<option value="${k}"${k === v ? " selected" : ""}>${n}</option>`).join("");
  const fila = (c) => `<tr data-cta="${esc(c.id || "")}">
    <td><input class="cta-codigo" inputmode="numeric" maxlength="10" value="${esc(c.codigo || "")}" ${dis} aria-label="Código" style="width:110px"></td>
    <td><input class="cta-nombre" maxlength="120" value="${esc(c.nombre || "")}" ${dis} aria-label="Nombre"></td>
    <td><select class="cta-tipo" ${dis || (c.clave ? "disabled" : "")}>${tipos(c.tipo)}</select></td>
    <td>${c.clave ? '<span class="hint">automática</span>' : ""}</td>
    <td><input type="checkbox" class="cta-activa" ${c.activa !== false ? "checked" : ""} ${dis || (c.clave ? "disabled" : "")} aria-label="Activa"></td>
    <td>${puede ? `<button class="icon-btn save" type="button" data-guardar-cta title="Guardar" aria-label="Guardar">${ICON_SAVE}</button>` : ""}</td></tr>`;
  document.querySelector("#table-cuentas tbody").innerHTML = (CONT.nueva ? fila({ tipo: "gasto", activa: true }) : "") + CONT.cuentas.map(fila).join("");
  $("cont-incluir-gastos").checked = !!(CONT.config && CONT.config.incluir_gastos);
  $("cont-incluir-gastos").disabled = !puede;
}
$("btn-cta-nueva").addEventListener("click", () => { CONT.nueva = true; contPintarCuentas(); document.querySelector("#table-cuentas .cta-codigo").focus(); });
$("table-cuentas").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-guardar-cta]");
  if (!b) return;
  const tr = b.closest("tr"), v = (cls) => tr.querySelector(cls);
  const p = { id: tr.dataset.cta || null, codigo: v(".cta-codigo").value.trim(), nombre: v(".cta-nombre").value.trim(),
    tipo: v(".cta-tipo").value, activa: v(".cta-activa").checked };
  const { error } = await sb.rpc("cont_guardar_cuenta", { p });
  if (error) { $("cta-msg").textContent = contMensaje(error); return; }
  CONT.nueva = false;
  await cargarContable();
  $("cta-msg").textContent = `Cuenta ${p.codigo} guardada.`;
});
$("cont-incluir-gastos").addEventListener("change", async (e) => {
  const si = e.target.checked;
  if (si && !confirm("Los gastos de la pestaña Gastos entrarán al libro. Si esos mismos gastos también se registran como compra (CTG), saldrán dos veces. ¿Seguir?")) {
    e.target.checked = false; return;
  }
  const { error } = await sb.rpc("cont_guardar_config", { p_incluir_gastos: si });
  if (error) { $("cta-msg").textContent = contMensaje(error); e.target.checked = !si; return; }
  await cargarContable();
});

/* --- Excel ------------------------------------------------------------------------- */
$("btn-cont-excel").addEventListener("click", () => {
  if (!CONT.balanza) return;
  const nombre = ($("cont-location").selectedOptions[0] || {}).textContent || "";
  const per = `del ${contFecha($("cont-desde").value)} al ${contFecha($("cont-hasta").value)} — ${contMoneda()}`;
  const hojas = [];
  if (CONT.diario) {
    const m = [[`LIBRO DIARIO — ${nombre} — ${per}`], ["Fecha", "Asiento", "Código", "Cuenta", "Debe", "Haber"]];
    CONT.diario.asientos.forEach((a) => a.lineas.forEach((l) => m.push([{ fecha: a.fecha },
      `${CONT_ORIGEN[a.origen] || a.origen}${a.origen === "manual" ? " #" + a.ref : ""} · ${a.concepto}`,
      l.codigo || "", l.nombre || "(sin cuenta)", Number(l.debe) || null, Number(l.haber) || null])));
    m.push(["TOTAL", null, null, null, Number(CONT.diario.debe), Number(CONT.diario.haber)]);
    hojas.push({ nombre: "Diario", matriz: m, encabezado: 2, titulo: 1, etiquetas: false, anchos: [12, 60, 10, 38, 14, 14] });
  }
  const b = [[`BALANZA DE COMPROBACIÓN — ${nombre} — ${per}`], ["Código", "Cuenta", "Saldo anterior", "Debe", "Haber", "Saldo deudor", "Saldo acreedor"]];
  let deu = 0, acr = 0;
  CONT.balanza.cuentas.forEach((c) => {
    const f = Number(c.final); if (f > 0) deu += f; else acr -= f;
    b.push([c.codigo, c.nombre, Number(c.anterior), Number(c.debe), Number(c.haber), f > 0 ? f : null, f < 0 ? -f : null]);
  });
  b.push(["TOTAL", null, null, Number(CONT.balanza.debe), Number(CONT.balanza.haber), r2(deu), r2(acr)]);
  hojas.push({ nombre: "Balanza", matriz: b, encabezado: 2, titulo: 1, etiquetas: false, anchos: [10, 40, 16, 16, 16, 16, 16] });
  const r = contResultados();
  const e = [[`ESTADO DE RESULTADOS — ${nombre} — ${per}`], ["Concepto", "Monto"]];
  const sec = (t, l, tt, v) => { e.push([t]); l.forEach((c) => e.push([`   ${c.codigo} · ${c.nombre}`, c.monto])); e.push([tt, v]); };
  sec("Ingresos", r.ing, "Ingresos netos", r.tI);
  sec("Costo de ventas", r.cos, "Utilidad bruta", r.bruta);
  sec("Gastos", r.gas, "Total de gastos", r.tG);
  e.push([r.neta >= 0 ? "UTILIDAD DEL PERIODO" : "PÉRDIDA DEL PERIODO", r.neta]);
  hojas.push({ nombre: "Resultados", matriz: e, encabezado: 2, titulo: 1, etiquetas: false, anchos: [50, 16] });
  const bytes = LibroVentas.crearXlsx(hojas);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a"); a.href = url;
  a.download = `libro-contable_${nombre}_${$("cont-desde").value}_${$("cont-hasta").value}.xlsx`.replace(/[^\w.-]+/g, "-");
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

/* --- Navegación ---------------------------------------------------------------------- */
$("cont-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cont]");
  if (!b) return;
  CONT.panel = b.dataset.cont;
  if (CONT.loaded) pintarContable();
});
$("btn-cont-ver").addEventListener("click", cargarContable);
["cont-location", "cont-desde", "cont-hasta"].forEach((id) => $(id).addEventListener("change", cargarContable));
