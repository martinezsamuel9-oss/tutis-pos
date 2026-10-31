/* ===========================================================================
   TUTI'S — Clientes: la ficha, "¿Es cliente?" al cobrar y el módulo
   ---------------------------------------------------------------------------
   Se carga después de app.js y usa sus utilidades ($, sb, esc, money, LOY…).

   La llave del cliente es su TELÉFONO: es lo que se pregunta en la caja y lo
   que la base no deja repetir ("9988-7766", "+504 9988 7766" y "99887766"
   son el mismo). Por dentro sigue teniendo su id, así que si cambia de número
   conserva su historial, sus puntos y su carnet.

   Lo que la base cuida y esta pantalla solo muestra (sql/22):
     · Las cifras (visitas, ticket, consumo) son de las tiendas que quien mira
       puede ver: la gerente de Galerías no ve lo gastado en Multiplaza.
     · La categoría (VIP, frecuente…) es de toda la marca, como los puntos.
     · La identidad la ve la gerente en el módulo; la caja no la recibe.
   =========================================================================== */
"use strict";

const CATEGORIAS = {
  vip:         { nombre: "VIP",         clase: "vip" },
  frecuente:   { nombre: "Frecuente",   clase: "frecuente" },
  nuevo:       { nombre: "Nuevo",       clase: "nuevo" },
  ocasional:   { nombre: "Ocasional",   clase: "ocasional" },
  inactivo:    { nombre: "Inactivo",    clase: "inactivo" },
  sin_compras: { nombre: "Sin compras", clase: "sin" },
};
const SEXO = { F: "Femenino", M: "Masculino", O: "Otro" };
const DIA_SEMANA = ["", "lunes", "martes", "miércoles", "jueves", "viernes", "sábados", "domingos"];
const PREFIJO_PAIS = { HN: "504", GT: "502", SV: "503" };

function badgeCategoria(cat) {
  const c = CATEGORIAS[cat];
  return c ? `<span class="cat-badge ${c.clase}">${esc(c.nombre)}</span>` : "";
}
function pintarCategoria(el, cat) {
  const c = CATEGORIAS[cat];
  el.hidden = !c;
  if (c) { el.className = `cat-badge ${c.clase}`; el.textContent = c.nombre; }
}
function diasAviso() {
  const cfg = CLI.cfg || lsGet("tutis_clientes_cfg", null);
  return cfg ? Number(cfg.aviso_cumple_dias) : 7;
}
function textoCumple(d) {
  if (d == null || d > diasAviso()) return "";
  return d === 0 ? "¡Hoy es su cumpleaños!" : d === 1 ? "Mañana es su cumpleaños" : `Cumple años en ${d} días`;
}
const sinAcentos = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Los errores de la base, dichos para la cajera.
function mensajeCliente(error) {
  const m = (error && error.message) || "";
  if (/uq_customers_telefono/.test(m)) return "Ese teléfono ya es de otro cliente.";
  if (/uq_customers_identidad/.test(m)) return "Ese número de identidad ya es de otro cliente.";
  if (/customers_telefono_chk/.test(m)) return "Escribe un teléfono válido (8 dígitos).";
  if (/customers_identidad_chk/.test(m)) return "El número de identidad no es válido.";
  if (/customers_cumple_chk/.test(m)) return "La fecha de cumpleaños no es válida.";
  if (/network|fetch/i.test(m)) return "Sin conexión. Inténtalo cuando vuelva el internet.";
  return m || "No se pudo guardar.";
}

const CLI = { lista: [], sel: null, loaded: false, cfg: null, cumples: [] };

// Las reglas de las categorías y si la caja pregunta "¿Es cliente?". Se
// guardan en el navegador para que la caja no las pida en cada venta.
async function configClientes(forzar) {
  if (CLI.cfg && !forzar) return CLI.cfg;
  if (sb && navigator.onLine) {
    const { data } = await sb.from("clientes_config").select("*").maybeSingle();
    if (data) { CLI.cfg = data; lsSet("tutis_clientes_cfg", data); }
  }
  return CLI.cfg || lsGet("tutis_clientes_cfg", null);
}

async function inscribirCliente(ficha) {
  if (!navigator.onLine) return { error: "Sin conexión no se puede inscribir. Cobra normal y lo inscribes después." };
  if (String(ficha.telefono || "").replace(/\D/g, "").length < 8) return { error: "Escribe el teléfono: es su número de cliente." };
  if (String(ficha.nombre || "").length < 2) return { error: "Escribe el nombre completo." };
  const { data, error } = await sb.rpc("clientes_inscribir", { p: ficha });
  if (error) return { error: mensajeCliente(error) };
  return { cliente: data };
}

/* --- "¿Es cliente?" al cobrar ----------------------------------------------
   Con internet y sin cliente elegido, antes de cobrar se pregunta una vez por
   venta. Sin internet no: buscar e inscribir necesitan la base, y la venta no
   puede esperar a la red. Devuelve true para seguir cobrando y false para
   volver al ticket (por ejemplo, para que canjee sus puntos). */
const PC = { resolver: null };

async function preguntarCliente() {
  if (LOY.cliente || LOY.preguntado || !navigator.onLine || !sb) return true;
  const cfg = await configClientes(false);
  if (cfg && cfg.preguntar_en_caja === false) return true;
  ["pc-tel", "pc-nombre", "pc-birth", "pc-sexo", "pc-ident", "pc-obs"].forEach((id) => { $(id).value = ""; });
  $("pc-resultado").innerHTML = "";
  $("pc-nuevo").hidden = true;
  $("pc-msg").textContent = "";
  $("cliente-modal").hidden = false;
  setTimeout(() => $("pc-tel").focus(), 30);
  return new Promise((resolve) => { PC.resolver = resolve; });
}

function cerrarPregunta(seguir) {
  $("cliente-modal").hidden = true;
  const r = PC.resolver; PC.resolver = null;
  if (r) r(seguir);
}

function elegirEnCaja(c) {
  seleccionarCliente(c);
  LOY.preguntado = true;
  const cfg = reglasFidelizacion();
  const puede = cfg && cfg.activo && Number(c.points_balance) >= Number(cfg.canje_minimo || 0) && Number(c.points_balance) > 0;
  if (!puede) { cerrarPregunta(true); return; }
  // Tiene puntos para canjear: se le pregunta antes de cobrar.
  $("pc-nuevo").hidden = true;
  $("pc-resultado").innerHTML = `<div class="alert">
      <strong>${esc(c.full_name)}</strong> tiene <strong>${esc(c.points_balance)} puntos</strong>
      (${money(c.points_balance * Number(cfg.valor_punto || 0))}). ¿Quiere usarlos en esta compra?</div>
    <div class="filter-bar">
      <button class="btn primary" id="btn-pc-canjear" type="button">Sí, canjear</button>
      <button class="btn" id="btn-pc-nocanje" type="button">No, cobrar ya</button>
    </div>`;
  $("btn-pc-canjear").addEventListener("click", () => {
    cerrarPregunta(false);
    $("loy-redeem").focus();
  });
  $("btn-pc-nocanje").addEventListener("click", () => cerrarPregunta(true));
}

async function buscarEnCaja() {
  const q = codigoDesdeTexto($("pc-tel").value.trim());
  const box = $("pc-resultado"), msg = $("pc-msg");
  msg.textContent = "";
  $("pc-nuevo").hidden = true;
  if (q.replace(/\W/g, "").length < 8) { msg.textContent = "Escribe el teléfono completo (8 dígitos) o el código del carnet."; return; }
  box.innerHTML = '<p class="hint">Buscando…</p>';
  const { data, error } = await sb.rpc("loyalty_buscar", { p_texto: q });
  if (error) { box.innerHTML = ""; msg.textContent = mensajeCliente(error); return; }
  const exactos = (data || []).filter((c) => c.exacto);
  if (!exactos.length) {
    box.innerHTML = "";
    $("pc-nuevo").hidden = false;
    $("pc-nombre").focus();
    return;
  }
  box.innerHTML = "";
  exactos.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "loy-result";
    const cumple = textoCumple(c.dias_para_cumple);
    b.innerHTML = `<span><strong>${esc(c.full_name)}</strong> ${badgeCategoria(c.categoria)}<br>
        <span class="hint">${esc(c.phone || "")} · ${esc(c.card_code)}${cumple ? ` · 🎂 ${esc(cumple)}` : ""}</span></span>
      <span class="num"><strong>${esc(c.points_balance)}</strong> pts</span>`;
    b.addEventListener("click", () => elegirEnCaja(c));
    box.appendChild(b);
  });
  box.insertAdjacentHTML("afterbegin", '<p class="hint">Toca al cliente para confirmar:</p>');
}

$("btn-pc-buscar").addEventListener("click", buscarEnCaja);
$("pc-tel").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); buscarEnCaja(); } });
$("btn-pc-volver").addEventListener("click", () => cerrarPregunta(false));
$("btn-pc-sin").addEventListener("click", () => { LOY.preguntado = true; cerrarPregunta(true); });
$("btn-pc-inscribir").addEventListener("click", async () => {
  const btn = $("btn-pc-inscribir"); btn.disabled = true;
  const r = await inscribirCliente({
    telefono: $("pc-tel").value.trim(), nombre: $("pc-nombre").value.trim(),
    cumpleanos: $("pc-birth").value || null, sexo: $("pc-sexo").value || null,
    identidad: $("pc-ident").value.trim() || null, observaciones: $("pc-obs").value.trim() || null,
  });
  btn.disabled = false;
  if (r.error) { $("pc-msg").textContent = r.error; return; }
  seleccionarCliente(r.cliente);
  LOY.preguntado = true;
  cerrarPregunta(true);
});

/* --- El módulo (gerente y propietaria) ------------------------------------- */
// La dirección del carnet. Usa el mismo sitio en el que está abierta la caja,
// así no hay que configurarla en ningún lado.
function urlCarnet(codigo) {
  // Sin ".html": el servidor redirige carnet.html → carnet, y cada salto es
  // un toque más de espera en un teléfono con poca señal.
  return `${location.origin}${location.pathname.replace(/[^/]*$/, "")}carnet?c=${encodeURIComponent(codigo)}`;
}
const MOV_LABELS = { gana: "Ganó", canje: "Canjeó", ajuste: "Ajuste", vence: "Venció" };

function llenarTiendasClientes() {
  $("cli-location-field").hidden = !veTodas();
  if (!veTodas()) return;
  const sel = $("cli-location"), keep = sel.value;
  sel.innerHTML = '<option value="">Todas las tiendas</option>' +
    STATE.locations.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("");
  sel.value = keep;
}
function clientesScope() { return veTodas() ? ($("cli-location").value || null) : null; }

async function cargarClientes() {
  if (!canManage() || !navigator.onLine) return;
  llenarTiendasClientes();
  if (!$("cli-cat").options.length || $("cli-cat").options.length === 1) {
    $("cli-cat").innerHTML = '<option value="">Todas</option>' +
      Object.entries(CATEGORIAS).map(([k, c]) => `<option value="${k}">${esc(c.nombre)}</option>`).join("");
  }
  $("cli-count").textContent = "Cargando…";
  const [r, cum] = await Promise.all([
    sb.rpc("clientes_resumen", { p_location: clientesScope() }),
    sb.rpc("clientes_cumpleanos", { p_dias: null }),
    configClientes(true),
  ]);
  if (r.error) { $("cli-count").textContent = `No se pudieron cargar: ${mensajeCliente(r.error)}`; return; }
  CLI.lista = r.data || [];
  CLI.cumples = (cum && cum.data) || [];
  CLI.loaded = true;
  pintarClientes();
  pintarKpisFidelizacion();
  pintarCumples();
  llenarReglasClientes();
  if (CLI.sel) {
    const s = CLI.lista.find((x) => x.id === CLI.sel.id);
    if (s) abrirCliente(s.id, false);
  }
}

function clientesFiltrados() {
  const q = sinAcentos($("cli-q").value.trim()), dig = q.replace(/\D/g, "");
  const cat = $("cli-cat").value, desde = $("cli-desde").value, cumple = $("cli-cumple").value;
  const inactivos = $("cli-inactivos").checked;
  const mes = new Date().getMonth() + 1;
  const lista = CLI.lista.filter((c) =>
    (inactivos || c.activo)
    && (!q || sinAcentos(c.nombre).includes(q) || (dig.length >= 3 && String(c.telefono || "").includes(dig))
        || sinAcentos(c.carnet) === q)
    && (!cat || c.categoria === cat)
    // "No vienen desde": vinieron alguna vez, pero no desde esa fecha.
    && (!desde || (c.ultima && localDateStr(new Date(c.ultima)) < desde))
    && (!cumple || (cumple === "mes"
        ? c.cumpleanos && Number(c.cumpleanos.slice(5, 7)) === mes
        : c.dias_para_cumple != null && c.dias_para_cumple <= Number(cumple))));
  const orden = $("cli-orden").value;
  const n = (v) => Number(v) || 0;
  const por = {
    total: (a, b) => n(b.total) - n(a.total),
    visitas: (a, b) => n(b.visitas) - n(a.visitas),
    ticket: (a, b) => n(b.ticket_promedio) - n(a.ticket_promedio),
    ultima: (a, b) => (b.dias_sin_venir ?? -1) - (a.dias_sin_venir ?? -1),
    nombre: () => 0,
  }[orden] || (() => 0);
  return lista.sort((a, b) => por(a, b) || String(a.nombre).localeCompare(String(b.nombre), "es"));
}

function haceDias(d) {
  if (d == null) return "—";
  return d === 0 ? "hoy" : d === 1 ? "ayer" : `hace ${d} días`;
}

function pintarClientes() {
  const body = document.querySelector("#table-clientes tbody");
  const lista = clientesFiltrados();
  const MAX = 500;
  body.innerHTML = lista.length ? "" :
    `<tr><td colspan="9" class="hint">${CLI.lista.length ? "Nadie cumple con esos filtros." : "Todavía no hay clientes inscritos. Se inscriben desde la pantalla de Venta."}</td></tr>`;
  lista.slice(0, MAX).forEach((c) => {
    const tr = document.createElement("tr");
    if (CLI.sel && CLI.sel.id === c.id) tr.classList.add("sel");
    tr.innerHTML = `<td>${esc(c.nombre)}${c.activo ? "" : ' <span class="hint">(inactivo)</span>'}${c.dias_para_cumple != null && c.dias_para_cumple <= diasAviso() ? ' <span title="Cumpleaños cerca">🎂</span>' : ""}</td>
      <td>${esc(c.telefono || "")}</td>
      <td>${badgeCategoria(c.categoria)}</td>
      <td class="num">${esc(c.visitas)}</td>
      <td class="num">${c.visitas ? money(c.ticket_promedio) : "—"}</td>
      <td class="num">${money(c.total)}</td>
      <td>${c.ultima ? `${esc(haceDias(c.dias_sin_venir))}` : '<span class="hint">nunca</span>'}</td>
      <td class="num">${c.cada_cuantos_dias != null ? `${esc(c.cada_cuantos_dias)} días` : "—"}</td>
      <td class="num"><strong>${esc(c.puntos)}</strong></td>`;
    tr.addEventListener("click", () => abrirCliente(c.id, true));
    body.appendChild(tr);
  });
  $("cli-count").textContent = !CLI.lista.length ? "" :
    `${lista.length} de ${CLI.lista.length} cliente(s)` + (lista.length > MAX ? ` — se muestran los primeros ${MAX}; el Excel trae todos.` : "");
}

// Se llama también desde app.js al guardar las reglas de puntos.
function pintarKpisFidelizacion() {
  const cfg = reglasFidelizacion();
  const activos = CLI.lista.filter((c) => c.activo);
  const cuenta = (cat) => activos.filter((c) => c.categoria === cat).length;
  const saldo = activos.reduce((a, c) => a + Number(c.puntos || 0), 0);
  const visitas = activos.reduce((a, c) => a + Number(c.visitas || 0), 0);
  const total = activos.reduce((a, c) => a + Number(c.total || 0), 0);
  const vp = cfg ? Number(cfg.valor_punto) : 0;
  const ccfg = CLI.cfg || {};
  const kpi = (l, v, sub) => `<div class="kpi"><div class="kpi-label">${l}</div>
    <div class="kpi-value num">${v}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  $("cli-kpis").innerHTML =
    kpi("Clientes", activos.length.toLocaleString("es")) +
    kpi("VIP", cuenta("vip"), ccfg.vip_monto_90d ? `gastaron ${money(ccfg.vip_monto_90d)} o vinieron ${ccfg.vip_visitas_90d} veces en 90 días` : "") +
    kpi("Frecuentes", cuenta("frecuente")) +
    kpi("Inactivos", cuenta("inactivo"), ccfg.inactivo_dias ? `más de ${ccfg.inactivo_dias} días sin venir` : "") +
    kpi("Ticket promedio", visitas ? money(total / visitas) : "—", `${visitas.toLocaleString("es")} visita(s) con cliente`) +
    kpi("Cumpleaños cerca", CLI.cumples.length, `en los próximos ${diasAviso()} días`) +
    // Esto es una deuda: lo que la marca tendría que regalar en descuentos si
    // todos canjearan hoy. Conviene verlo crecer con calma.
    kpi("Puntos en circulación", saldo.toLocaleString("es"), `valen ${money(saldo * vp)} si todos canjean hoy`) +
    kpi("Programa de puntos", cfg ? (cfg.activo ? "Activo" : "Pausado") : "—",
        cfg ? `1 punto por cada ${money(cfg.monto_por_punto)} · cada punto vale ${money(cfg.valor_punto)}` : "");
}

function enlaceWhatsapp(tel, texto) {
  const d = String(tel || "").replace(/\D/g, "");
  if (d.length < 8) return "";
  const loc = activeLocation();
  const pref = d.length === 8 ? (PREFIJO_PAIS[(loc && loc.country_code) || "HN"] || "504") : "";
  return `https://wa.me/${pref}${d}?text=${encodeURIComponent(texto)}`;
}

function pintarCumples() {
  $("cli-cumples-card").hidden = !CLI.cumples.length;
  $("cli-cumples-sub").textContent = `Los próximos ${diasAviso()} días. Un mensaje o unos puntos de regalo hacen que vuelvan.`;
  $("cli-cumples").innerHTML = CLI.cumples.map((c) => {
    const cuando = c.dias === 0 ? "<strong>hoy</strong>" : c.dias === 1 ? "mañana" : `en ${c.dias} días`;
    const wa = enlaceWhatsapp(c.telefono, `¡Feliz cumpleaños, ${String(c.nombre).split(" ")[0]}! De parte de todo el equipo de Tuti's 🍦`);
    return `<div class="cumple-row">
      <span>🎂 <strong>${esc(c.nombre)}</strong> ${badgeCategoria(c.categoria)} · cumple ${esc(c.cumple)} ${cuando}</span>
      <span>${esc(c.telefono || "")}${wa ? ` · <a href="${esc(wa)}" target="_blank" rel="noopener">Escribirle por WhatsApp</a>` : ""}</span>
    </div>`;
  }).join("");
}

async function abrirCliente(id, desplazar) {
  const c = CLI.lista.find((x) => x.id === id);
  if (!c) return;
  CLI.sel = c;
  pintarClientes();
  const cfg = reglasFidelizacion();
  $("cli-detail").hidden = false;
  $("cli-d-name").textContent = c.nombre;
  const cumple = c.cumpleanos ? ` · cumpleaños ${c.cumpleanos.slice(8, 10)}/${c.cumpleanos.slice(5, 7)}` : "";
  $("cli-d-meta").textContent = `Tel. ${c.telefono || "—"} · carnet ${c.carnet} · inscrito el ${new Date(c.inscrito).toLocaleDateString()}${cumple}`;
  pintarCategoria($("cli-d-cat"), c.categoria);
  $("cli-d-points").textContent = c.puntos;
  $("cli-d-value").textContent = cfg ? `puntos · valen ${money(c.puntos * Number(cfg.valor_punto))}` : "puntos";
  const kpi = (l, v, sub) => `<div class="kpi"><div class="kpi-label">${l}</div>
    <div class="kpi-value num">${v}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  $("cli-d-kpis").innerHTML =
    kpi("Visitas", c.visitas, c.primera ? `desde el ${new Date(c.primera).toLocaleDateString()}` : "") +
    kpi("Total gastado", money(c.total)) +
    kpi("Ticket promedio", c.visitas ? money(c.ticket_promedio) : "—") +
    kpi("Última visita", c.ultima ? haceDias(c.dias_sin_venir) : "nunca", c.ultima ? new Date(c.ultima).toLocaleDateString() : "") +
    kpi("Viene cada", c.cada_cuantos_dias != null ? `${c.cada_cuantos_dias} días` : "—", c.visitas > 1 ? "en promedio" : "hace falta más de una visita") +
    kpi("Últimos 90 días", money(c.monto_90), `${c.visitas_90} visita(s)`);
  $("cli-e-name").value = c.nombre || "";
  $("cli-e-phone").value = c.telefono || "";
  $("cli-e-email").value = c.correo || "";
  $("cli-e-birth").value = c.cumpleanos || "";
  $("cli-e-sexo").value = c.sexo || "";
  $("cli-e-ident").value = c.identidad || "";
  $("cli-e-obs").value = c.observaciones || "";
  $("cli-e-active").checked = !!c.activo;
  $("cli-d-link").value = urlCarnet(c.carnet);
  $("cli-e-msg").textContent = ""; $("cli-adj-msg").textContent = "";
  $("cli-adj-pts").value = ""; $("cli-adj-note").value = "";
  if (desplazar) $("cli-detail").scrollIntoView({ behavior: "smooth", block: "start" });

  // El detalle y los movimientos: la base devuelve solo lo de las tiendas
  // que este usuario puede ver.
  const [det, mov] = await Promise.all([
    sb.rpc("cliente_detalle", { p_customer: id, p_location: clientesScope() }),
    sb.from("loyalty_transactions")
      .select("created_at, kind, points, amount, note, location_id, locations(name)")
      .eq("customer_id", id).order("created_at", { ascending: false }).limit(100),
  ]);
  if (!CLI.sel || CLI.sel.id !== id) return;   // ya abrieron a otra persona
  pintarDetalle(det.data || {});
  pintarMovimientos(mov.data || []);
}

function pintarDetalle(d) {
  const consumo = d.consumo || [], ultimas = d.ultimas || [];
  const cb = document.querySelector("#table-cli-consumo tbody");
  cb.innerHTML = consumo.length ? consumo.map((x) => `<tr>
      <td>${esc(x.nombre)}</td>
      <td class="num">${esc(x.veces)}</td>
      <td class="num">${x.tipo === "producto" ? esc(Number(x.unidades)) : esc(fmtWeightShort(Number(x.peso_g)))}</td>
      <td class="num">${money(x.monto)}</td></tr>`).join("")
    : '<tr><td colspan="4" class="hint">Sin compras en lo que puedes ver.</td></tr>';
  const vb = document.querySelector("#table-cli-visitas tbody");
  vb.innerHTML = ultimas.length ? ultimas.map((v) => `<tr>
      <td>${esc(new Date(v.fecha).toLocaleString())}</td>
      <td>${esc(v.tienda)}</td>
      <td class="num">${esc(v.folio ?? "")}</td>
      <td class="num">${money(v.total)}${v.puntos_canjeados ? ` <span class="hint">(canjeó ${esc(v.puntos_canjeados)})</span>` : ""}</td>
      <td>${esc(PAGO_LABELS[v.pago] || v.pago || "—")}</td></tr>`).join("")
    : '<tr><td colspan="5" class="hint">Sin visitas.</td></tr>';
  // Cuándo viene: el día, la hora y la forma de pago que más usa.
  const mayor = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1])[0];
  const dia = mayor(d.por_dia), hora = mayor(d.por_hora), pago = mayor(d.pagos);
  const partes = [];
  if (dia) partes.push(`viene más los <strong>${esc(DIA_SEMANA[dia[0]] || "")}</strong>`);
  if (hora) partes.push(`entre las <strong>${esc(hora[0])}:00 y las ${esc(Number(hora[0]) + 1)}:00</strong>`);
  if (pago) partes.push(`y paga casi siempre con <strong>${esc((PAGO_LABELS[pago[0]] || pago[0]).toLowerCase())}</strong>`);
  $("cli-d-cuando").innerHTML = partes.length ? `Suele ser así: ${partes.join(", ")}.` : "";
}

function pintarMovimientos(movs) {
  const body = document.querySelector("#table-cli-hist tbody");
  body.innerHTML = movs.length ? "" : '<tr><td colspan="6" class="hint">Sin movimientos visibles.</td></tr>';
  movs.forEach((m) => {
    const tr = document.createElement("tr");
    const cls = m.points > 0 ? "pts-gana" : "pts-canje";
    tr.innerHTML = `<td>${esc(new Date(m.created_at).toLocaleString())}</td>
      <td>${esc((m.locations && m.locations.name) || "—")}</td>
      <td>${esc(MOV_LABELS[m.kind] || m.kind)}</td>
      <td class="num ${cls}">${m.points > 0 ? "+" : ""}${esc(m.points)}</td>
      <td class="num">${m.amount != null ? money(m.amount) : ""}</td>
      <td>${esc(m.note || "")}</td>`;
    body.appendChild(tr);
  });
  $("cli-h-sub").textContent = isOwner()
    ? "Todos los movimientos, de todas las tiendas."
    : "Solo los movimientos de tu tienda. El saldo de arriba sí incluye lo de todas.";
}

["cli-q"].forEach((id) => $(id).addEventListener("input", pintarClientes));
["cli-cat", "cli-desde", "cli-cumple", "cli-orden", "cli-inactivos"].forEach((id) => $(id).addEventListener("change", pintarClientes));
$("cli-location").addEventListener("change", () => { CLI.sel = null; $("cli-detail").hidden = true; cargarClientes(); });
$("btn-cli-buscar").addEventListener("click", () => cargarClientes());

$("btn-cli-copiar").addEventListener("click", async () => {
  const v = $("cli-d-link").value;
  try { await navigator.clipboard.writeText(v); $("btn-cli-copiar").textContent = "¡Copiado!"; }
  catch (e) { $("cli-d-link").select(); }
  setTimeout(() => ($("btn-cli-copiar").textContent = "Copiar"), 1500);
});

$("btn-cli-guardar").addEventListener("click", async () => {
  if (!CLI.sel) return;
  const msg = $("cli-e-msg");
  const nombre = $("cli-e-name").value.trim();
  const tel = $("cli-e-phone").value.trim();
  if (nombre.length < 2) { msg.textContent = "El nombre no puede quedar vacío."; return; }
  if (tel.replace(/\D/g, "").length < 8) { msg.textContent = "El teléfono es su número de cliente: no puede quedar vacío."; return; }
  // El saldo, el gasto y las visitas no van aquí: la base no deja tocarlos
  // con un update directo, y la pantalla tampoco lo intenta.
  const { error } = await sb.from("customers").update({
    full_name: nombre,
    phone: tel,
    email: $("cli-e-email").value.trim() || null,
    birth_date: $("cli-e-birth").value || null,
    sexo: $("cli-e-sexo").value || null,
    identidad: $("cli-e-ident").value.trim() || null,
    observaciones: $("cli-e-obs").value.trim() || null,
    active: $("cli-e-active").checked,
  }).eq("id", CLI.sel.id);
  if (error) { msg.textContent = `No se pudo guardar: ${mensajeCliente(error)}`; return; }
  await cargarClientes();
  $("cli-e-msg").textContent = "Guardado.";
});

$("btn-cli-ajustar").addEventListener("click", async () => {
  if (!CLI.sel) return;
  const msg = $("cli-adj-msg");
  const pts = parseInt($("cli-adj-pts").value, 10);
  const nota = $("cli-adj-note").value.trim();
  if (!pts) { msg.textContent = "Escribe cuántos puntos (positivo para dar, negativo para quitar)."; return; }
  if (!nota) { msg.textContent = "Escribe la razón: queda en el registro."; return; }
  if (!confirm(`¿${pts > 0 ? "Dar" : "Quitar"} ${Math.abs(pts)} puntos a ${CLI.sel.nombre}?\n\nRazón: ${nota}`)) return;
  const { error } = await sb.rpc("loyalty_ajustar", { p_customer_id: CLI.sel.id, p_puntos: pts, p_nota: nota });
  if (error) { msg.textContent = error.message; return; }
  await cargarClientes();
  $("cli-adj-msg").textContent = "Ajuste aplicado.";
});

// La lista filtrada, en Excel: para llamar a los que no vienen, mandar
// promociones o revisar a los VIP con calma.
$("btn-cli-excel").addEventListener("click", () => {
  const lista = clientesFiltrados();
  if (!lista.length) { $("cli-count").textContent = "No hay clientes en la lista para descargar."; return; }
  const dia = (iso) => (iso ? { fecha: localDateStr(new Date(iso)) } : "");
  const sel = $("cli-location");
  const tienda = veTodas() ? (sel.options[sel.selectedIndex] || {}).textContent || "" : (activeLocation() || {}).name || "";
  const m = [
    [`CLIENTES — ${tienda} — ${new Date().toLocaleDateString()}`],
    ["Nombre", "Teléfono", "Carnet", "Categoría", "Cumpleaños", "Sexo", "Identidad", "Correo", "Visitas", "Total gastado",
      "Ticket promedio", "Primera visita", "Última visita", "Días sin venir", "Viene cada (días)", "Puntos", "Activo", "Observaciones"],
  ];
  lista.forEach((c) => m.push([c.nombre, c.telefono || "", c.carnet, (CATEGORIAS[c.categoria] || {}).nombre || "",
    c.cumpleanos ? { fecha: c.cumpleanos } : "", SEXO[c.sexo] || "", c.identidad || "", c.correo || "",
    Number(c.visitas), Number(c.total), Number(c.ticket_promedio), dia(c.primera), dia(c.ultima),
    c.dias_sin_venir ?? "", c.cada_cuantos_dias ?? "", Number(c.puntos), c.activo ? "Sí" : "No", c.observaciones || ""]));
  m.push([`${lista.length} cliente(s)`, null, null, null, null, null, null, null,
    lista.reduce((a, c) => a + Number(c.visitas), 0), r2(lista.reduce((a, c) => a + Number(c.total), 0))]);
  const bytes = LibroVentas.crearXlsx([{ nombre: "Clientes", matriz: m, encabezado: 2, titulo: 1, etiquetas: false,
    anchos: [30, 12, 13, 12, 12, 11, 17, 26, 9, 13, 13, 13, 13, 11, 11, 9, 8, 40] }]);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a"); a.href = url;
  a.download = `clientes_${tienda}_${localDateStr(new Date())}.xlsx`.replace(/[^\w.-]+/g, "-");
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

/* --- Las reglas de las categorías (solo la propietaria) -------------------- */
const CR_CAMPOS = { "cr-inactivo": "inactivo_dias", "cr-vip-monto": "vip_monto_90d", "cr-vip-visitas": "vip_visitas_90d",
                    "cr-frecuente": "frecuente_visitas_90d", "cr-nuevo": "nuevo_dias", "cr-cumple": "aviso_cumple_dias" };
function llenarReglasClientes() {
  $("cli-reglas-card").hidden = !isOwner();
  const cfg = CLI.cfg;
  if (!cfg || !isOwner()) return;
  if (document.activeElement && document.activeElement.closest("#cli-reglas-card")) return;
  Object.entries(CR_CAMPOS).forEach(([id, k]) => { $(id).value = cfg[k]; });
  $("cr-preguntar").checked = cfg.preguntar_en_caja !== false;
}
$("btn-cr-guardar").addEventListener("click", async () => {
  const msg = $("cr-msg");
  const nuevo = { preguntar_en_caja: $("cr-preguntar").checked };
  for (const [id, k] of Object.entries(CR_CAMPOS)) {
    const v = Number($(id).value);
    if (!Number.isFinite(v) || v < 0) { msg.textContent = "Revisa los números: no pueden quedar vacíos ni negativos."; return; }
    nuevo[k] = v;
  }
  const { error } = await sb.from("clientes_config").update(nuevo).eq("id", true);
  if (error) { msg.textContent = /check/i.test(error.message) ? "Algún número está fuera de rango." : `No se pudo guardar: ${error.message}`; return; }
  await cargarClientes();
  msg.textContent = "Categorías guardadas. Ya se ven en la lista.";
  setTimeout(() => (msg.textContent = ""), 2500);
});
