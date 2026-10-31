/* ===========================================================================
   TUTI'S — Operación: inventario diario, fabricación, entradas y cuadre
   ---------------------------------------------------------------------------
   Se carga después de app.js y usa sus utilidades ($, sb, esc, money…).
   Comparte el ámbito global con app.js y clientes.js: un nombre repetido
   pisa la función de la caja sin avisar (ya pasó con pintarConteo).
   La base hace todas las cuentas (sql/23, inv_cuadre); esta pantalla solo
   muestra, y mientras se teclea el conteo repite la resta para que se vea
   el consumo al momento. Si se cambia una, se cambia la otra.

   Como el Excel de control que usan hoy:
     · máquina o topping: inicial + entradas + fabricado − merma − final = consumo
     · por unidad: inicial + entradas − venta − merma = debería haber;
       lo contado contra eso = diferencia
     · cuadre: (máquinas − froyo en otros productos) + (toppings − toppings en
       otros productos) = lo que salió de la barra libre, contra lo que la
       caja cobró por peso.
   =========================================================================== */
"use strict";

const OP = { cuadre: null, items: [], recetas: [], lineasRec: [], fabs: [], movs: [], panel: "conteo",
             loaded: false, rango: [], recSel: null, recLineas: [] };
const OP_TIPOS = { maquina: "Máquinas", base: "Bases", topping: "Barra de toppings", unidad: "Por unidad",
                   materia: "Materia prima", froyo: "Froyo servido" };
const MOV_TIPOS = { compra: "Compra", traspaso_entrada: "Traspaso que entra", sumado: "Sumado", fabricado: "Fabricado",
                    traspaso_salida: "Traspaso que sale", usado_fabricacion: "Usado en fabricación", merma: "Merma",
                    invitacion: "Invitación", venta: "Venta", ajuste: "Ajuste" };
const LADO = { izq: "izquierda", der: "derecha" };
const n3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const fmtN = (v, d = 1) => (v == null || v === "" ? "—" : Number(v).toLocaleString("es-HN", { minimumFractionDigits: 0, maximumFractionDigits: d }));

function opLoc() { return veTodas() ? ($("op-location").value || STATE.activeLocationId) : STATE.activeLocationId; }
function opFecha() { return $("op-fecha").value || localDateStr(new Date()); }
function puedeCatalogo() { return isOwner() || (rol() === "operaciones" && !!(STATE.profile && STATE.profile.todas_tiendas)); }
function opEditable() { return canOperate() && OP.cuadre && OP.cuadre.estado !== "cerrado"; }
function itemPorId(id) { return OP.items.find((i) => i.id === id); }
function opMensaje(t) { $("op-msg").textContent = t || ""; }

// Lo llama renderAll en app.js cada vez que llegan datos.
function renderOperacion() {
  $("op-location-field").hidden = !veTodas();
  if (veTodas()) {
    const sel = $("op-location"), keep = sel.value || STATE.activeLocationId;
    sel.innerHTML = STATE.locations.filter((l) => l.active).map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("");
    sel.value = keep;
  }
  if (!$("op-fecha").value) $("op-fecha").value = localDateStr(new Date());
  $("op-seg-catalogo").hidden = !canOperate() && !canAccount();
  if ($("tab-operacion").classList.contains("active") && !OP.loaded) cargarOperacion();
}
function abrirOperacion() { renderOperacion(); if (!OP.loaded) cargarOperacion(); }

async function cargarOperacion() {
  if (!sb || !navigator.onLine) { opMensaje("El inventario necesita conexión a internet."); return; }
  const loc = opLoc(), f = opFecha();
  if (!loc) return;
  opMensaje("Cargando…");
  const [cq, it, rc, rl, fb, mv] = await Promise.all([
    sb.rpc("inv_cuadre", { p_location: loc, p_fecha: f }),
    sb.from("inv_items").select("*").order("orden"),
    sb.from("recetas").select("*").order("nombre"),
    sb.from("receta_lineas").select("*"),
    sb.from("fabricaciones").select("*").eq("location_id", loc).eq("fecha", f).order("created_at"),
    sb.from("inv_movimientos").select("*").eq("location_id", loc).eq("fecha", f).order("created_at", { ascending: false }).limit(1000),
  ]);
  if (cq.error) { opMensaje(cq.error.message); return; }
  OP.cuadre = cq.data;
  OP.items = it.data || [];
  OP.recetas = rc.data || [];
  OP.lineasRec = rl.data || [];
  OP.fabs = fb.data || [];
  OP.movs = mv.data || [];
  OP.loaded = true;
  opMensaje("");
  pintarOperacion();
}

function pintarOperacion() {
  const c = OP.cuadre;
  if (!c) return;
  const est = { abierto: ["Abierto", "nuevo"], cerrado: ["Cerrado", "frecuente"], sin_conteo: ["Sin conteo", "inactivo"] }[c.estado] || [c.estado, ""];
  $("op-estado").textContent = est[0];
  $("op-estado").className = `cat-badge ${est[1]}`;
  document.querySelectorAll("#op-seg button").forEach((b) => b.classList.toggle("active", b.dataset.op === OP.panel));
  document.querySelectorAll(".op-panel").forEach((p) => { p.hidden = p.dataset.opPanel !== OP.panel; });
  pintarConteoInv();
  pintarFabricacion();
  pintarMovimientosInv();
  pintarCuadre();
  if (OP.panel === "catalogo") pintarCatalogo();
}

/* --- Conteo ------------------------------------------------------------------ */
// La misma resta que hace la base (inv_cuadre).
function calcularLinea(l, finalTxt) {
  const fin = finalTxt === "" || finalTxt == null ? null : Number(finalTxt);
  const disp = n3(Number(l.inicial) + Number(l.entradas) + Number(l.fabricado) + Number(l.ajuste) - Number(l.salidas) - Number(l.merma));
  return {
    consumo: fin == null ? null : n3(disp - fin),
    teorico: n3(disp - Number(l.venta)),
    diferencia: fin == null ? null : n3(fin - (disp - Number(l.venta))),
  };
}

function resultadoLinea(l, finalTxt) {
  const r = calcularLinea(l, finalTxt);
  if (l.tipo === "unidad" || l.tipo === "base") {
    if (r.diferencia == null) return `<span class="hint">debería haber ${fmtN(r.teorico, 2)}</span>`;
    if (Math.abs(r.diferencia) < 0.001) return '<span class="dif-ok">Cuadra</span>';
    return `<span class="${r.diferencia < 0 ? "dif-mal" : "dif-sobra"}">${r.diferencia < 0 ? "Faltan" : "Sobran"} ${fmtN(Math.abs(r.diferencia), 2)}</span>`;
  }
  if (r.consumo == null) return '<span class="hint">—</span>';
  return `<strong>${fmtN(r.consumo, 2)}</strong>${r.consumo < 0 ? ' <span class="dif-mal">¿negativo?</span>' : ""}`;
}

function pintarConteoInv() {
  const c = OP.cuadre;
  const prev = c.hay_conteo_anterior ? `El inicial es el conteo anterior${c.desde !== c.fecha ? " (y entran los movimientos desde el " + esc(fechaLarga(c.desde)) + ")" : ""}.`
    : "No hay conteo anterior: el inicial va en 0. El primer día solo sirve de arranque.";
  $("op-conteo-sub").innerHTML = `${prev} ${c.estado === "cerrado" ? "<strong>Este día ya está cerrado.</strong>" : ""}`;
  const q = sinAcentos($("op-buscar").value.trim()), soloFaltan = $("op-solo-faltan").checked;
  const editable = opEditable();
  const grupos = {};
  (c.lineas || []).forEach((l) => {
    if (q && !sinAcentos(l.nombre).includes(q) && !sinAcentos(l.sabor || "").includes(q)) return;
    if (soloFaltan && l.final != null) return;
    (grupos[l.tipo] = grupos[l.tipo] || []).push(l);
  });
  const orden = ["maquina", "base", "topping", "unidad", "materia"];
  const html = orden.filter((t) => grupos[t]).map((t) => {
    const esMaq = t === "maquina", porUnidad = t === "unidad" || t === "base";
    const filas = grupos[t].map((l) => `<tr data-item="${esc(l.item_id)}">
        <td>${esc(l.nombre)}${l.familia && l.familia !== "normal" ? ` <span class="hint">${esc(l.familia)}</span>` : ""}</td>
        ${esMaq ? `<td><input class="op-sabor" value="${esc(l.sabor || "")}" maxlength="60" ${editable ? "" : "disabled"} aria-label="Sabor de ${esc(l.nombre)}"></td>` : ""}
        <td class="num">${l.hay_inicial ? fmtN(l.inicial, 2) : '<span class="hint">0</span>'}</td>
        <td class="num">${Number(l.entradas) ? `+${fmtN(l.entradas, 2)}` : ""}${Number(l.fabricado) ? ` <span class="hint">+${fmtN(l.fabricado, 2)} fab.</span>` : ""}${Number(l.ajuste) ? ` <span class="hint">${Number(l.ajuste) > 0 ? "+" : ""}${fmtN(l.ajuste, 2)} aj.</span>` : ""}</td>
        <td class="num">${Number(l.merma) || Number(l.salidas) ? `−${fmtN(Number(l.merma) + Number(l.salidas), 2)}` : ""}</td>
        <td class="num">${Number(l.venta) ? `−${fmtN(l.venta, 2)}` : ""}</td>
        <td><input class="op-final num" type="number" min="0" step="${l.unidad === "unid" ? "1" : "0.1"}" inputmode="decimal" value="${l.final == null ? "" : esc(l.final)}" ${editable ? "" : "disabled"} aria-label="Final de ${esc(l.nombre)}"></td>
        <td class="num op-res">${resultadoLinea(l, l.final)}</td>
      </tr>`).join("");
    const unidad = [...new Set(grupos[t].map((l) => l.unidad === "unid" ? "unidades" : l.unidad))].join(", ");
    return `<h3 class="op-grupo">${esc(OP_TIPOS[t])} <span class="hint">(${unidad})</span></h3>
      <div class="table-wrap"><table class="data op-tabla">
        <thead><tr><th>Artículo</th>${esMaq ? "<th>Sabor</th>" : ""}<th>Inicial</th><th>Entradas</th><th>Merma</th><th>${porUnidad ? "Vendido" : "En productos"}</th><th>Final</th><th>${porUnidad ? "Diferencia" : "Consumo"}</th></tr></thead>
        <tbody>${filas}</tbody></table></div>`;
  }).join("");
  $("op-conteo").innerHTML = html || '<p class="hint">Nada que mostrar con ese filtro.</p>';
  const contadas = (c.lineas || []).filter((l) => l.final != null).length;
  const diarias = (c.lineas || []).filter((l) => ["maquina", "base", "topping", "unidad"].includes(l.tipo)).length;
  $("op-conteo-msg").textContent = `${contadas} de ${diarias} artículo(s) contados.`;
  $("btn-op-guardar").hidden = $("btn-op-cerrar").hidden = !editable;
  $("btn-op-reabrir").hidden = !(c.estado === "cerrado" && canManage());
}

$("op-conteo").addEventListener("input", (e) => {
  const tr = e.target.closest("tr[data-item]");
  if (!tr || !e.target.classList.contains("op-final")) return;
  const l = (OP.cuadre.lineas || []).find((x) => x.item_id === tr.dataset.item);
  if (l) tr.querySelector(".op-res").innerHTML = resultadoLinea(l, e.target.value);
});
// Enter pasa al siguiente conteo, como en una hoja de cálculo.
$("op-conteo").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.classList.contains("op-final")) return;
  e.preventDefault();
  const todos = [...document.querySelectorAll("#op-conteo .op-final:not([disabled])")];
  const sig = todos[todos.indexOf(e.target) + 1];
  if (sig) sig.focus();
});
$("op-buscar").addEventListener("input", () => OP.cuadre && pintarConteoInv());
$("op-solo-faltan").addEventListener("change", () => OP.cuadre && pintarConteoInv());

function lineasCambiadas() {
  const cambios = [];
  document.querySelectorAll("#op-conteo tr[data-item]").forEach((tr) => {
    const l = (OP.cuadre.lineas || []).find((x) => x.item_id === tr.dataset.item);
    if (!l) return;
    const fin = tr.querySelector(".op-final").value.trim();
    const sab = tr.querySelector(".op-sabor") ? tr.querySelector(".op-sabor").value.trim() : (l.sabor || "");
    const antes = l.final == null ? "" : String(Number(l.final));
    if ((fin === "" ? "" : String(Number(fin))) !== antes || (tr.querySelector(".op-sabor") && sab !== (l.sabor || ""))) {
      if (fin !== "" && (!(Number(fin) >= 0))) throw new Error(`"${l.nombre}": el conteo no puede ser negativo.`);
      cambios.push({ item_id: l.item_id, final: fin === "" ? null : Number(fin), sabor: sab || null });
    }
  });
  return cambios;
}

async function guardarConteo() {
  let cambios;
  try { cambios = lineasCambiadas(); } catch (e) { $("op-conteo-msg").textContent = e.message; return false; }
  if (!cambios.length) return true;
  const { error } = await sb.rpc("inv_guardar_conteo", { p_location: opLoc(), p_fecha: opFecha(), p_lineas: cambios });
  if (error) { $("op-conteo-msg").textContent = error.message; return false; }
  return true;
}

$("btn-op-guardar").addEventListener("click", async () => {
  const btn = $("btn-op-guardar"); btn.disabled = true;
  const ok = await guardarConteo();
  btn.disabled = false;
  if (ok) { await cargarOperacion(); $("op-conteo-msg").textContent = "Conteo guardado. " + $("op-conteo-msg").textContent; }
});
$("btn-op-cerrar").addEventListener("click", async () => {
  if (!confirm("¿Cerrar el inventario de este día?\n\nDespués ya no se puede cambiar el conteo, ni registrar entradas, mermas o fabricación de este día. Solo la gerente o la propietaria lo pueden reabrir.")) return;
  const btn = $("btn-op-cerrar"); btn.disabled = true;
  if (!(await guardarConteo())) { btn.disabled = false; return; }
  const { error } = await sb.rpc("inv_cerrar_conteo", { p_location: opLoc(), p_fecha: opFecha() });
  btn.disabled = false;
  if (error) { await cargarOperacion(); $("op-conteo-msg").textContent = error.message; return; }
  OP.panel = "cuadre";
  await cargarOperacion();
});
$("btn-op-reabrir").addEventListener("click", async () => {
  const motivo = prompt("¿Por qué se reabre este día? Queda registrado con tu nombre.\n\nSe reabren también los días siguientes que estén cerrados, porque su inicial depende de este.");
  if (motivo === null) return;
  const { error } = await sb.rpc("inv_reabrir_conteo", { p_location: opLoc(), p_fecha: opFecha(), p_motivo: motivo.trim() });
  if (error) { $("op-conteo-msg").textContent = error.message; return; }
  await cargarOperacion();
});
$("btn-op-imprimir").addEventListener("click", () => window.print());

/* --- Fabricación ------------------------------------------------------------- */
function recetasDe(tipo) { return OP.recetas.filter((r) => r.tipo === tipo && r.activo); }
function lineasDe(recetaId) { return OP.lineasRec.filter((l) => l.receta_id === recetaId); }

function pintarFabricacion() {
  const sel = $("fab-receta"), keep = sel.value;
  sel.innerHTML = recetasDe("fabricacion").map((r) => `<option value="${esc(r.id)}">${esc(r.nombre)}</option>`).join("");
  if (keep && OP.recetas.some((r) => r.id === keep)) sel.value = keep;
  const dest = $("fab-destino"), keepD = dest.value;
  dest.innerHTML = OP.items.filter((i) => i.activo && ["maquina", "base"].includes(i.tipo))
    .map((i) => `<option value="${esc(i.id)}">${esc(i.nombre)}</option>`).join("");
  if (keepD) dest.value = keepD;
  prepararFabricacion(false);
  const editable = opEditable();
  $("btn-fab-registrar").disabled = !editable;
  const body = document.querySelector("#table-fab tbody");
  body.innerHTML = OP.fabs.length ? OP.fabs.map((f) => {
    const r = OP.recetas.find((x) => x.id === f.receta_id) || {}, d = itemPorId(f.destino_item_id) || {};
    return `<tr><td>${esc(new Date(f.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</td>
      <td>${esc(r.nombre || "")}</td><td class="num">${fmtN(f.tandas, 2)}</td><td>${esc(d.nombre || "")}</td><td>${esc(f.sabor || "")}</td>
      <td class="num">${fmtN(f.producido, 2)} ${esc(d.unidad || "")}</td><td>${f.created_by === (STATE.profile || {}).id ? "tú" : ""}</td>
      <td>${editable ? `<button class="icon-btn delete" type="button" data-borrar-fab="${esc(f.id)}" title="Eliminar" aria-label="Eliminar">${ICON_TRASH}</button>` : ""}</td></tr>`;
  }).join("") : '<tr><td colspan="8" class="hint">Nada fabricado este día.</td></tr>';
}

// cambio: true cuando la persona cambió receta, tandas o destino (se recalcula lo que salió).
function prepararFabricacion(cambio) {
  const r = OP.recetas.find((x) => x.id === $("fab-receta").value);
  if (!r) { $("fab-preview").textContent = "No hay recetas de fabricación. Se crean en Catálogo y recetas."; return; }
  $("fab-destino-field").hidden = !!r.produce_item_id;
  const destino = itemPorId(r.produce_item_id || $("fab-destino").value) || {};
  $("fab-unidad").textContent = destino.unidad || "oz";
  const tandas = Number($("fab-tandas").value) || 0;
  if (cambio || !$("fab-producido").value) $("fab-producido").value = r.rinde ? n3(r.rinde * tandas) : "";
  if (cambio || !$("fab-sabor").value) {
    const linea = (OP.cuadre.lineas || []).find((l) => l.item_id === destino.id);
    $("fab-sabor").value = (linea && linea.sabor) || destino.sabor || "";
  }
  const ing = lineasDe(r.id);
  const costo = ing.reduce((a, l) => a + Number(l.cantidad) * tandas * Number((itemPorId(l.item_id) || {}).costo || 0), 0);
  const prod = Number($("fab-producido").value) || 0;
  $("fab-preview").innerHTML = `<strong>Sale del inventario:</strong> ` +
    ing.map((l) => { const i = itemPorId(l.item_id) || {}; return `${fmtN(Number(l.cantidad) * tandas, 3)} ${esc(i.unidad || "")} de ${esc(i.nombre || "?")}`; }).join(", ") +
    `. <strong>Entra:</strong> ${prod ? `${fmtN(prod, 2)} ${esc(destino.unidad || "oz")}` : "(escribe cuánto salió)"} a ${esc(destino.nombre || "—")}.` +
    (costo > 0 ? ` Costo: ${money(costo)}${prod ? ` (${money(costo / prod)} por ${esc(destino.unidad || "oz")})` : ""}.` : "") +
    (r.notas ? `<br><span class="hint">${esc(r.notas)}</span>` : "");
}
["fab-receta", "fab-tandas", "fab-destino"].forEach((id) => $(id).addEventListener("input", () => prepararFabricacion(true)));
$("fab-producido").addEventListener("input", () => prepararFabricacion(false));

$("btn-fab-registrar").addEventListener("click", async () => {
  const r = OP.recetas.find((x) => x.id === $("fab-receta").value);
  if (!r) return;
  const btn = $("btn-fab-registrar"); btn.disabled = true;
  const { data, error } = await sb.rpc("inv_fabricar", { p: {
    location_id: opLoc(), fecha: opFecha(), receta_id: r.id, tandas: Number($("fab-tandas").value) || 0,
    destino_item_id: r.produce_item_id || $("fab-destino").value, producido: Number($("fab-producido").value) || null,
    sabor: $("fab-sabor").value.trim() || null, nota: $("fab-nota").value.trim() || null,
  } });
  btn.disabled = false;
  if (error) { $("fab-msg").textContent = error.message; return; }
  $("fab-nota").value = ""; $("fab-producido").value = "";
  await cargarOperacion();
  $("fab-msg").textContent = `Registrado: ${fmtN(data.producido, 2)}${data.costo_total ? `, costo ${money(data.costo_total)}` : ""}.`;
});
$("table-fab").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-borrar-fab]");
  if (!b || !confirm("¿Borrar esta fabricación? Se deshacen también sus entradas y salidas.")) return;
  const { error } = await sb.rpc("inv_borrar_fabricacion", { p_id: b.dataset.borrarFab });
  if (error) { $("fab-msg").textContent = error.message; return; }
  await cargarOperacion();
});

/* --- Entradas y mermas ------------------------------------------------------- */
function pintarMovimientosInv() {
  const sel = $("mov-item"), keep = sel.value;
  sel.innerHTML = ["maquina", "base", "topping", "unidad", "materia"].map((t) => {
    const its = OP.items.filter((i) => i.activo && i.tipo === t);
    return its.length ? `<optgroup label="${esc(OP_TIPOS[t])}">${its.map((i) => `<option value="${esc(i.id)}">${esc(i.nombre)}</option>`).join("")}</optgroup>` : "";
  }).join("");
  if (keep) sel.value = keep;
  $("mov-unidad").textContent = (itemPorId(sel.value) || {}).unidad || "";
  $("btn-mov-registrar").disabled = !opEditable();
  const todos = $("mov-ver-ventas").checked;
  const lista = OP.movs.filter((m) => todos || (!m.sale_id && !m.fabricacion_id));
  const editable = opEditable();
  document.querySelector("#table-mov tbody").innerHTML = lista.length ? lista.map((m) => {
    const i = itemPorId(m.item_id) || {};
    const manual = !m.sale_id && !m.fabricacion_id && !m.conteo_id;
    return `<tr><td>${esc(new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</td>
      <td>${esc(i.nombre || "")}</td><td>${esc(MOV_TIPOS[m.tipo] || m.tipo)}</td>
      <td class="num ${Number(m.cantidad) < 0 ? "pts-canje" : "pts-gana"}">${Number(m.cantidad) > 0 ? "+" : ""}${fmtN(m.cantidad, 3)} ${esc(i.unidad || "")}</td>
      <td class="num">${Number(m.costo) ? money(Math.abs(m.cantidad * m.costo)) : ""}</td><td>${esc(m.nota || "")}</td>
      <td>${editable && manual ? `<button class="icon-btn delete" type="button" data-borrar-mov="${esc(m.id)}" title="Eliminar" aria-label="Eliminar">${ICON_TRASH}</button>` : ""}</td></tr>`;
  }).join("") : '<tr><td colspan="7" class="hint">Sin movimientos este día.</td></tr>';
}
$("mov-item").addEventListener("change", () => { $("mov-unidad").textContent = (itemPorId($("mov-item").value) || {}).unidad || ""; });
$("mov-ver-ventas").addEventListener("change", pintarMovimientosInv);
$("btn-mov-registrar").addEventListener("click", async () => {
  const msg = $("mov-msg");
  const cant = Number($("mov-cantidad").value);
  if (!cant) { msg.textContent = "Escribe la cantidad."; return; }
  const btn = $("btn-mov-registrar"); btn.disabled = true;
  const { error } = await sb.rpc("inv_movimiento", { p_location: opLoc(), p_fecha: opFecha(), p_item: $("mov-item").value,
    p_tipo: $("mov-tipo").value, p_cantidad: cant, p_nota: $("mov-nota").value.trim() || null });
  btn.disabled = false;
  if (error) { msg.textContent = error.message; return; }
  $("mov-cantidad").value = ""; $("mov-nota").value = "";
  await cargarOperacion();
  $("mov-msg").textContent = "Registrado.";
});
$("table-mov").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-borrar-mov]");
  if (!b || !confirm("¿Borrar este movimiento?")) return;
  const { error } = await sb.rpc("inv_borrar_movimiento", { p_id: b.dataset.borrarMov });
  if (error) { $("mov-msg").textContent = error.message; return; }
  await cargarOperacion();
});

/* --- Cuadre ------------------------------------------------------------------- */
function fechaLarga(iso) { const [y, m, d] = String(iso).split("-"); return `${d}/${m}/${y}`; }
function textoDiferencia(oz) {
  if (oz == null) return "—";
  if (Math.abs(oz) < 0.005) return "Cuadra";
  // Vendido − consumido: si es negativo, salió de la barra más de lo que se cobró.
  return oz < 0 ? `Faltan ${fmtN(-oz, 2)} oz` : `Sobran ${fmtN(oz, 2)} oz`;
}

function pintarCuadre() {
  const c = OP.cuadre;
  $("cq-sub").textContent = `${fechaLarga(c.fecha)}${c.desde !== c.fecha ? ` (incluye desde el ${fechaLarga(c.desde)}, el día después del conteo anterior)` : ""}. Las cuentas son las de la hoja CUADRE del Excel.`;
  const avisos = [];
  if (c.estado !== "cerrado") avisos.push('<div class="alert warn">El día no está cerrado: el cuadre puede cambiar mientras se termina de contar.</div>');
  if (!c.hay_conteo_anterior) avisos.push('<div class="alert warn">No hay conteo anterior: el inicial va en 0 y este cuadre no dice nada todavía. Sirve a partir del segundo día.</div>');
  $("cq-alerta").innerHTML = avisos.join("");
  const f = c.froyo, t = c.toppings, dif = Number(c.diferencia_oz);
  const fila = (txt, v, cls = "") => `<div class="cq-fila ${cls}"><span>${txt}</span><span class="num">${v}</span></div>`;
  $("cq-resumen").innerHTML =
    `<div class="cq-bloque"><div class="chart-title">Froyo</div>` +
      fila("Consumo de las máquinas", `${fmtN(f.consumo_maquinas, 2)} oz`) +
      fila("Merma de las máquinas (goteo)", `${fmtN(f.merma_maquinas, 2)} oz`, "hint") +
      fila("− En otros productos", `${fmtN(f.en_otros, 2)} oz`) +
      fila("= Froyo de la barra libre", `<strong>${fmtN(f.barra_libre, 2)} oz</strong>`, "cq-total") + `</div>` +
    `<div class="cq-bloque"><div class="chart-title">Toppings</div>` +
      fila("Consumo de la barra", `${fmtN(t.consumo, 2)} oz`) +
      fila("− En otros productos", `${fmtN(t.en_otros, 2)} oz`) +
      fila("= Toppings de la barra libre", `<strong>${fmtN(t.barra_libre, 2)} oz</strong>`, "cq-total") + `</div>` +
    `<div class="cq-bloque"><div class="chart-title">Contra la caja</div>` +
      fila("Salió de la barra libre (froyo + toppings)", `${fmtN(c.consumo_barra, 2)} oz`) +
      fila(`Cobrado por peso (${fmtN(c.tazas, 0)} taza(s)${c.oz_por_taza ? `, ${fmtN(c.oz_por_taza, 2)} oz por taza` : ""})`, `${fmtN(c.vendido_oz, 2)} oz`) +
      fila("Diferencia", `<strong class="${dif < -0.005 ? "dif-mal" : dif > 0.005 ? "dif-sobra" : "dif-ok"}">${textoDiferencia(dif)}</strong>`, "cq-total") +
      fila("En litros · en %", `${fmtN(c.diferencia_litros, 2)} L · ${c.diferencia_pct == null ? "—" : fmtN(c.diferencia_pct, 1) + " %"}`) +
      `</div>`;
  document.querySelector("#table-cq-otros tbody").innerHTML = (c.otros_productos || []).length
    ? c.otros_productos.map((o) => `<tr><td>${esc(o.nombre)}</td><td>${o.tipo === "froyo" ? "Froyo" : "Toppings"}</td><td class="num">${fmtN(o.cantidad, 2)}</td></tr>`).join("")
    : '<tr><td colspan="3" class="hint">Ninguna venta ni fabricación usó froyo o toppings de la barra.</td></tr>';
  const unid = (c.lineas || []).filter((l) => (l.tipo === "unidad" || l.tipo === "base") && l.final != null);
  document.querySelector("#table-cq-unid tbody").innerHTML = unid.length ? unid.map((l) => {
    const d = Number(l.diferencia);
    return `<tr><td>${esc(l.nombre)}</td><td class="num">${fmtN(l.teorico, 2)}</td><td class="num">${fmtN(l.final, 2)}</td>
      <td class="num ${d < 0 ? "dif-mal" : d > 0 ? "dif-sobra" : "dif-ok"}">${Math.abs(d) < 0.001 ? "Cuadra" : (d < 0 ? "Faltan " : "Sobran ") + fmtN(Math.abs(d), 2)}</td>
      <td class="num">${Number(l.valor_diferencia) ? money(l.valor_diferencia) : ""}</td></tr>`;
  }).join("") : '<tr><td colspan="5" class="hint">Todavía no se cuentan los artículos por unidad.</td></tr>';
  if (!$("cq-desde").value) {
    const d = new Date(); $("cq-hasta").value = localDateStr(d); d.setDate(1); $("cq-desde").value = localDateStr(d);
  }
}

async function cargarRango() {
  const { data, error } = await sb.rpc("inv_cuadre_rango", { p_location: opLoc(), p_desde: $("cq-desde").value, p_hasta: $("cq-hasta").value });
  const body = document.querySelector("#table-cq-rango tbody");
  if (error) { body.innerHTML = `<tr><td colspan="11" class="hint">${esc(error.message)}</td></tr>`; return; }
  OP.rango = data || [];
  const tot = OP.rango.reduce((a, r) => ({ maq: a.maq + Number(r.froyo.consumo_maquinas), fb: a.fb + Number(r.froyo.barra_libre),
    tb: a.tb + Number(r.toppings.barra_libre), cb: a.cb + Number(r.consumo_barra), v: a.v + Number(r.vendido_oz),
    tz: a.tz + Number(r.tazas), d: a.d + Number(r.diferencia_oz) }), { maq: 0, fb: 0, tb: 0, cb: 0, v: 0, tz: 0, d: 0 });
  const fila = (r) => `<tr><td>${esc(fechaLarga(r.fecha))}</td><td>${r.estado === "cerrado" ? "Cerrado" : "Abierto"}</td>
    <td class="num">${fmtN(r.froyo.consumo_maquinas, 2)}</td><td class="num">${fmtN(r.froyo.barra_libre, 2)}</td><td class="num">${fmtN(r.toppings.barra_libre, 2)}</td>
    <td class="num">${fmtN(r.consumo_barra, 2)}</td><td class="num">${fmtN(r.vendido_oz, 2)}</td><td class="num">${fmtN(r.tazas, 0)}</td>
    <td class="num ${Number(r.diferencia_oz) < 0 ? "dif-mal" : "dif-sobra"}">${fmtN(r.diferencia_oz, 2)}</td><td class="num">${fmtN(r.diferencia_litros, 2)}</td>
    <td class="num">${r.diferencia_pct == null ? "—" : fmtN(r.diferencia_pct, 1)}</td></tr>`;
  body.innerHTML = OP.rango.length ? OP.rango.map(fila).join("") +
    `<tr class="total"><td><strong>Total</strong></td><td></td><td class="num">${fmtN(tot.maq, 2)}</td><td class="num">${fmtN(tot.fb, 2)}</td><td class="num">${fmtN(tot.tb, 2)}</td>
     <td class="num">${fmtN(tot.cb, 2)}</td><td class="num">${fmtN(tot.v, 2)}</td><td class="num">${fmtN(tot.tz, 0)}</td><td class="num"><strong>${fmtN(tot.d, 2)}</strong></td>
     <td class="num">${fmtN(tot.d / 33.814, 2)}</td><td class="num">${tot.v ? fmtN(tot.d / tot.v * 100, 1) : "—"}</td></tr>`
    : '<tr><td colspan="11" class="hint">No hay conteos en esas fechas.</td></tr>';
}
$("btn-cq-rango").addEventListener("click", cargarRango);
$("btn-cq-excel").addEventListener("click", async () => {
  if (!OP.rango.length) await cargarRango();
  if (!OP.rango.length) return;
  const loc = STATE.locations.find((l) => l.id === opLoc()) || {};
  const m = [[`CUADRE DE INVENTARIO — ${loc.name || ""} — del ${fechaLarga($("cq-desde").value)} al ${fechaLarga($("cq-hasta").value)}`],
    ["Día", "Estado", "Consumo máquinas (oz)", "Froyo en otros (oz)", "Froyo barra libre (oz)", "Consumo toppings (oz)",
     "Toppings en otros (oz)", "Toppings barra libre (oz)", "Consumo barra libre (oz)", "Vendido en caja (oz)", "Tazas",
     "Diferencia (oz)", "Diferencia (litros)", "Diferencia (%)"]];
  OP.rango.forEach((r) => m.push([{ fecha: r.fecha }, r.estado === "cerrado" ? "Cerrado" : "Abierto",
    Number(r.froyo.consumo_maquinas), Number(r.froyo.en_otros), Number(r.froyo.barra_libre), Number(r.toppings.consumo),
    Number(r.toppings.en_otros), Number(r.toppings.barra_libre), Number(r.consumo_barra), Number(r.vendido_oz), Number(r.tazas),
    Number(r.diferencia_oz), Number(r.diferencia_litros), r.diferencia_pct == null ? "" : Number(r.diferencia_pct)]));
  const suma = (k) => r2(OP.rango.reduce((a, r) => a + Number(k(r)), 0));
  m.push(["TOTAL", null, suma((r) => r.froyo.consumo_maquinas), suma((r) => r.froyo.en_otros), suma((r) => r.froyo.barra_libre),
    suma((r) => r.toppings.consumo), suma((r) => r.toppings.en_otros), suma((r) => r.toppings.barra_libre), suma((r) => r.consumo_barra),
    suma((r) => r.vendido_oz), suma((r) => r.tazas), suma((r) => r.diferencia_oz), r2(suma((r) => r.diferencia_oz) / 33.814)]);
  const bytes = LibroVentas.crearXlsx([{ nombre: "Cuadre", matriz: m, encabezado: 2, titulo: 1, etiquetas: false,
    anchos: [12, 10, 14, 14, 14, 14, 14, 14, 14, 14, 8, 14, 14, 12] }]);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a"); a.href = url;
  a.download = `cuadre_${loc.name || ""}_${$("cq-desde").value}_${$("cq-hasta").value}.xlsx`.replace(/[^\w.-]+/g, "-");
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

/* --- Catálogo y recetas -------------------------------------------------------- */
function pintarCatalogo() {
  const puede = puedeCatalogo();
  $("btn-cat-nuevo").hidden = $("btn-rec-nueva").hidden = !puede;
  if ($("cat-tipo").options.length <= 1) {
    $("cat-tipo").innerHTML = '<option value="">Todos</option>' + Object.entries(OP_TIPOS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  }
  const q = sinAcentos($("cat-buscar").value.trim()), tipo = $("cat-tipo").value;
  const lista = OP.items.filter((i) => (!q || sinAcentos(i.nombre).includes(q)) && (!tipo || i.tipo === tipo));
  const dis = puede ? "" : "disabled";
  const opciones = (obj, v) => Object.entries(obj).map(([k, t]) => `<option value="${k}"${k === v ? " selected" : ""}>${esc(t)}</option>`).join("");
  const fila = (i) => `<tr data-cat="${esc(i.id || "")}">
    <td><input class="c-nombre" value="${esc(i.nombre || "")}" ${dis} aria-label="Nombre"></td>
    <td><select class="c-tipo" ${dis}>${opciones(OP_TIPOS, i.tipo)}</select></td>
    <td><select class="c-unidad" ${dis}>${opciones({ oz: "oz", unid: "unid", litro: "litro", g: "g", bolsa: "bolsa" }, i.unidad)}</select></td>
    <td><input class="c-costo num" type="number" min="0" step="0.01" value="${esc(i.costo ?? 0)}" ${dis} aria-label="Costo"></td>
    <td><input class="c-familia" value="${esc(i.familia || "")}" ${dis} aria-label="Familia" size="8"></td>
    <td><input class="c-maquina num" type="number" min="1" max="20" value="${esc(i.maquina ?? "")}" ${dis} aria-label="Máquina" style="width:56px"></td>
    <td><select class="c-lado" ${dis}><option value=""></option>${opciones(LADO, i.lado)}</select></td>
    <td><input class="c-sabor" value="${esc(i.sabor || "")}" ${dis} aria-label="Sabor" size="10"></td>
    <td><input type="checkbox" class="c-diario" ${i.conteo_diario !== false ? "checked" : ""} ${dis} aria-label="Se cuenta a diario"></td>
    <td><input type="checkbox" class="c-activo" ${i.activo !== false ? "checked" : ""} ${dis} aria-label="Activo"></td>
    <td>${puede ? `<button class="icon-btn save" type="button" data-guardar-cat title="Guardar" aria-label="Guardar">${ICON_SAVE}</button>` : ""}</td></tr>`;
  document.querySelector("#table-cat tbody").innerHTML = (OP.nuevoItem ? fila({ tipo: "topping", unidad: "oz", costo: 0 }) : "") + lista.map(fila).join("");
  pintarRecetas();
}
$("cat-buscar").addEventListener("input", pintarCatalogo);
$("cat-tipo").addEventListener("change", pintarCatalogo);
$("btn-cat-nuevo").addEventListener("click", () => { OP.nuevoItem = true; pintarCatalogo(); document.querySelector("#table-cat .c-nombre").focus(); });
$("table-cat").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-guardar-cat]");
  if (!b) return;
  const tr = b.closest("tr"), v = (cls) => tr.querySelector(cls);
  const p = { id: tr.dataset.cat || null, nombre: v(".c-nombre").value.trim(), tipo: v(".c-tipo").value, unidad: v(".c-unidad").value,
    costo: Number(v(".c-costo").value) || 0, familia: v(".c-familia").value.trim() || null, maquina: v(".c-maquina").value || null,
    lado: v(".c-lado").value || null, sabor: v(".c-sabor").value.trim() || null, conteo_diario: v(".c-diario").checked, activo: v(".c-activo").checked };
  const { error } = await sb.rpc("inv_guardar_item", { p });
  if (error) { $("cat-msg").textContent = error.message; return; }
  OP.nuevoItem = false;
  await cargarOperacion();
  $("cat-msg").textContent = `"${p.nombre}" guardado.`;
});

// Nombres con que la caja vende (productos, vasos y cucharas de la tienda).
function nombresCaja() {
  return [...(STATE.products || []).filter((p) => p.active !== false).map((p) => p.name),
          ...(STATE.supplies || []).filter((s) => s.active !== false).map((s) => s.name)];
}

function pintarRecetas() {
  const sel = $("rec-sel"), keep = OP.recSel || sel.value;
  const grupo = (tipo, t) => `<optgroup label="${t}">${OP.recetas.filter((r) => r.tipo === tipo)
    .map((r) => `<option value="${esc(r.id)}">${esc(r.nombre)}${r.activo ? "" : " (inactiva)"}</option>`).join("")}</optgroup>`;
  sel.innerHTML = '<option value="">— Elegir —</option>' + grupo("fabricacion", "Fabricación") + grupo("venta", "Venta");
  sel.value = keep || "";
  // Recetas de venta que no encuentran su producto en la caja de esta tienda.
  const caja = new Set(nombresCaja().map(sinAcentos).map((s) => s.replace(/\s+/g, " ").trim()));
  const sueltas = OP.recetas.filter((r) => r.tipo === "venta" && r.activo && !caja.has(sinAcentos(r.vende_nombre || "").replace(/\s+/g, " ").trim()));
  $("rec-avisos").innerHTML = sueltas.length ? `<div class="alert warn">Estas recetas de venta no encuentran su producto en la caja de esta tienda, así que todavía no descuentan nada:
    ${sueltas.map((r) => `<strong>${esc(r.vende_nombre)}</strong>`).join(", ")}. Cambia el nombre en la receta para que sea igual al de la caja (o crea el producto).</div>` : "";
  $("rec-nombres-caja").innerHTML = nombresCaja().map((n) => `<option value="${esc(n)}">`).join("");
  $("rec-produce").innerHTML = '<option value="">Se elige al fabricar (máquina)</option>' +
    OP.items.filter((i) => i.activo && ["base", "unidad", "topping"].includes(i.tipo)).map((i) => `<option value="${esc(i.id)}">${esc(i.nombre)}</option>`).join("");
  abrirReceta(sel.value, false);
}

function abrirReceta(id, nueva) {
  OP.recSel = id || null;
  const r = nueva ? { tipo: "venta", activo: true, nombre: "", vende_nombre: "" } : OP.recetas.find((x) => x.id === id);
  $("rec-editor").hidden = !r;
  if (!r) return;
  $("rec-nombre").value = r.nombre || "";
  $("rec-tipo").value = r.tipo;
  $("rec-vende").value = r.vende_nombre || "";
  $("rec-rinde").value = r.rinde ?? "";
  $("rec-produce").value = r.produce_item_id || "";
  $("rec-notas").value = r.notas || "";
  $("rec-activo").checked = r.activo !== false;
  OP.recLineas = nueva ? [] : lineasDe(r.id).map((l) => ({ item_id: l.item_id, cantidad: l.cantidad }));
  pintarLineasReceta();
  const puede = puedeCatalogo();
  document.querySelectorAll("#rec-editor input, #rec-editor select, #rec-editor button").forEach((el) => { el.disabled = !puede; });
}

function pintarLineasReceta() {
  const fab = $("rec-tipo").value === "fabricacion";
  document.querySelectorAll(".rec-venta").forEach((el) => { el.hidden = fab; });
  document.querySelectorAll(".rec-fab").forEach((el) => { el.hidden = !fab; });
  const opciones = (v) => ["froyo", "topping", "unidad", "base", "materia", "maquina"].map((t) => {
    const its = OP.items.filter((i) => i.tipo === t && (i.activo || i.id === v));
    return its.length ? `<optgroup label="${esc(OP_TIPOS[t])}">${its.map((i) => `<option value="${esc(i.id)}"${i.id === v ? " selected" : ""}>${esc(i.nombre)} (${esc(i.unidad)})</option>`).join("")}</optgroup>` : "";
  }).join("");
  let total = 0;
  document.querySelector("#table-rec-lineas tbody").innerHTML = OP.recLineas.map((l, k) => {
    const i = itemPorId(l.item_id) || {}, c = Number(l.cantidad || 0) * Number(i.costo || 0);
    total += c;
    return `<tr data-k="${k}"><td><select class="rl-item"><option value=""></option>${opciones(l.item_id)}</select></td>
      <td><input class="rl-cant num" type="number" min="0" step="0.01" value="${esc(l.cantidad ?? "")}" aria-label="Cantidad"></td>
      <td class="num">${c ? money(c) : ""}</td>
      <td><button class="icon-btn delete" type="button" data-quitar-linea title="Quitar" aria-label="Quitar">${ICON_TRASH}</button></td></tr>`;
  }).join("") + (total ? `<tr><td><strong>Costo ${fab ? "por tanda" : "por unidad vendida"}</strong></td><td></td><td class="num"><strong>${money(total)}</strong></td><td></td></tr>` : "");
}
$("rec-sel").addEventListener("change", () => abrirReceta($("rec-sel").value, false));
$("btn-rec-nueva").addEventListener("click", () => { $("rec-sel").value = ""; abrirReceta(null, true); $("rec-nombre").focus(); });
$("rec-tipo").addEventListener("change", pintarLineasReceta);
$("btn-rec-linea").addEventListener("click", () => { OP.recLineas.push({ item_id: "", cantidad: "" }); pintarLineasReceta(); });
$("table-rec-lineas").addEventListener("change", (e) => {
  const tr = e.target.closest("tr[data-k]");
  if (!tr) return;
  const l = OP.recLineas[Number(tr.dataset.k)];
  if (e.target.classList.contains("rl-item")) l.item_id = e.target.value;
  if (e.target.classList.contains("rl-cant")) l.cantidad = e.target.value;
  pintarLineasReceta();
});
$("table-rec-lineas").addEventListener("click", (e) => {
  if (!e.target.closest("[data-quitar-linea]")) return;
  OP.recLineas.splice(Number(e.target.closest("tr").dataset.k), 1);
  pintarLineasReceta();
});
$("btn-rec-guardar").addEventListener("click", async () => {
  const msg = $("rec-msg");
  const lineas = OP.recLineas.filter((l) => l.item_id && Number(l.cantidad) > 0).map((l) => ({ item_id: l.item_id, cantidad: Number(l.cantidad) }));
  const p = { id: OP.recSel, nombre: $("rec-nombre").value.trim(), tipo: $("rec-tipo").value, vende_nombre: $("rec-vende").value.trim() || null,
    rinde: $("rec-rinde").value || null, produce_item_id: $("rec-produce").value || null, notas: $("rec-notas").value.trim() || null,
    activo: $("rec-activo").checked, lineas };
  if (p.tipo === "venta") { p.rinde = null; p.produce_item_id = null; } else p.vende_nombre = null;
  const { data, error } = await sb.rpc("inv_guardar_receta", { p });
  if (error) { msg.textContent = error.message; return; }
  OP.recSel = data;
  await cargarOperacion();
  $("rec-msg").textContent = "Receta guardada.";
});

/* --- Navegación ---------------------------------------------------------------- */
$("op-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-op]");
  if (!b) return;
  OP.panel = b.dataset.op;
  if (OP.cuadre) pintarOperacion();
});
$("op-fecha").addEventListener("change", () => { OP.rango = []; cargarOperacion(); });
$("op-location").addEventListener("change", () => { OP.rango = []; cargarOperacion(); });
