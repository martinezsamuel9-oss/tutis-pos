/* ===========================================================================
   TUTI'S — Punto de venta web multi-sucursal
   ---------------------------------------------------------------------------
   Cómo está organizado este archivo:
     1. Utilidades y tema (día/noche)
     2. Conexión con Supabase y sesión
     3. Estado y almacenamiento local (lo que permite cobrar sin internet)
     4. Motor de precios y costos
     5. Carga de datos según el rol
     6. Pantallas: Venta, Inventario, Toppings, Reportes, Configuración, Admin
     7. Báscula (Web Serial; el protocolo está en bascula.js)
   =========================================================================== */
"use strict";

/* ===========================================================================
   1. UTILIDADES
   =========================================================================== */
const CFG = window.TUTIS_CONFIG || {};
const OZ_TO_G = 28.349523125;
const toGrams = (v, unit) => (unit === "oz" ? (v || 0) * OZ_TO_G : (v || 0));
const toOz = (g) => g / OZ_TO_G;
const r2 = (v) => Math.round(((Number(v) || 0) + 1e-9) * 100) / 100;
const $ = (id) => document.getElementById(id);

// Los nombres de sabores, toppings, sucursales y personas los escribe una
// persona y terminan dentro de HTML. Sin esto, un nombre con "<" rompe la
// tabla, y uno escrito con mala intención por un gerente podría ejecutar
// código en la pantalla del propietario. Todo texto que venga de la base pasa
// por aquí antes de entrar a innerHTML.
function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function localDateStr(d) {
  const dt = d || new Date();
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// --- Unidad de peso preferida ----------------------------------------------
// En la base los pesos SIEMPRE son gramos. Esto es solo cómo se muestran y con
// qué unidad arrancan los campos. Si cada tienda guardara en su unidad, un
// reporte que sume dos sucursales estaría sumando peras con manzanas.
function prefUnit() {
  const loc = activeLocation();
  return (loc && loc.default_weight_unit === "oz") ? "oz" : "g";
}
function inPref(grams) {
  return prefUnit() === "oz" ? r2(toOz(grams)) : r2(grams);
}
// Muestra el peso en la unidad preferida y la otra entre paréntesis: el
// requisito original pedía gramos Y onzas, no una u otra.
function fmtWeight(grams) {
  const g = r2(grams), oz = r2(toOz(grams));
  return prefUnit() === "oz" ? `${oz} oz (${g} g)` : `${g} g (${oz} oz)`;
}
// Versión corta, para tablas donde no cabe el paréntesis.
function fmtWeightShort(grams) {
  return prefUnit() === "oz" ? `${r2(toOz(grams))} oz` : `${r2(grams)} g`;
}

// Deja los botones g/oz de un campo marcando la unidad que toca.
function markUnitButtons(containerId, unit) {
  document.querySelectorAll(`#${containerId} button`).forEach((b) => {
    b.classList.toggle("active", b.dataset.unit === unit);
  });
}

function money(v) {
  const code = (activeLocation() && activeLocation().currency_code) || "";
  return `${code} ${(Number(v) || 0).toFixed(2)}`;
}

const ICON_SAVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
// Huella digital (trazo propio, mismo estilo que los demás iconos).
const ICON_FINGER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></svg>';
const ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>';
const ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';

const PAGO_LABELS = { efectivo: "Efectivo", tarjeta: "Tarjeta", transferencia: "Transferencia", sin_dato: "Sin dato (ventas antiguas)" };

function rowActionsHtml() {
  return `<div class="row-actions">
    <button class="icon-btn save btn-save" type="button" title="Guardar">${ICON_SAVE}</button>
    <button class="icon-btn delete btn-del" type="button" title="Eliminar">${ICON_TRASH}</button>
  </div>`;
}

/* --- Tema día / noche ------------------------------------------------------ */
const THEME_KEY = "tutis-theme";
const getStoredTheme = () => { try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; } };
const setStoredTheme = (v) => { try { localStorage.setItem(THEME_KEY, v); } catch (e) {} };
const systemPrefersDark = () => !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
function effectiveTheme() {
  const s = getStoredTheme();
  return s === "light" || s === "dark" ? s : (systemPrefersDark() ? "dark" : "light");
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = $("theme-toggle");
  if (!btn) return;
  btn.innerHTML = theme === "dark" ? ICON_SUN : ICON_MOON;
  btn.title = theme === "dark" ? "Cambiar a modo día" : "Cambiar a modo noche";
}
applyTheme(effectiveTheme());
$("theme-toggle").addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  setStoredTheme(next); applyTheme(next);
});
if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!getStoredTheme()) applyTheme(effectiveTheme());
  });
}

/* ===========================================================================
   2. SUPABASE Y SESIÓN
   =========================================================================== */
const CONFIGURED = CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes("TU-PROYECTO")
                && CFG.SUPABASE_ANON_KEY && !CFG.SUPABASE_ANON_KEY.includes("TU-LLAVE");

// Entrar y autorizar con la huella del teléfono (passkeys de Supabase Auth).
// Se enciende en config.js cuando Passkeys está activado en el proyecto.
const HUELLA = !!CFG.PASSKEYS && typeof window.PublicKeyCredential !== "undefined";

let sb = null;
if (CONFIGURED) {
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, experimental: { passkey: HUELLA } },
  });
} else {
  $("login-config-warning").hidden = false;
}

/* ===========================================================================
   3. ESTADO Y ALMACENAMIENTO LOCAL
   ---------------------------------------------------------------------------
   El internet se cae seguido en las tiendas, así que el sistema nunca depende
   de la red para cobrar:
     · El catálogo (precios, toppings, vasos) se guarda en el navegador, así
       que la pantalla de venta funciona aunque no haya conexión.
     · Las ventas que no se pudieron enviar quedan en una cola local y se
       sincronizan solas al volver el internet. Cada una lleva un identificador
       único, así que reenviarla dos veces nunca la duplica.
   =========================================================================== */
const STATE = {
  session: null, profile: null,
  locations: [], activeLocationId: null,
  flavors: [], toppings: [], supplies: [], products: [], sales: [], profiles: [],
  pending: [],
};

const LS = {
  catalog: (locId) => `tutis_catalog_${locId}`,
  pending: "tutis_pending_sales",
  lastLocation: "tutis_last_location",
};

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

function activeLocation() {
  return STATE.locations.find((l) => l.id === STATE.activeLocationId) || null;
}
function isOwner()   { return STATE.profile && STATE.profile.role === "propietario"; }
function isManager() { return STATE.profile && STATE.profile.role === "gerente"; }
function canManage() { return isOwner() || isManager(); }

/* --- Cola de ventas pendientes --------------------------------------------- */
function loadPending() { STATE.pending = lsGet(LS.pending, []); }
function savePending() { lsSet(LS.pending, STATE.pending); }

function queueSale(payload) {
  STATE.pending.push(payload);
  savePending();
  updateConnBadge();
}

let lastSyncFailed = false;

async function syncPending() {
  if (sb && navigator.onLine) await syncAnulaciones();
  if (!sb || !STATE.pending.length || !navigator.onLine) return;
  const remaining = [];
  let hadNetworkFailure = false;
  for (const payload of STATE.pending) {
    try {
      const { error } = await sb.rpc("process_sale", { payload: { ...payload, synced_offline: true } });
      if (error) {
        // Un error de permisos o de datos no se arregla reintentando: lo
        // dejamos fuera de la cola pero avisamos, para no reintentar por siempre.
        if (error.code && error.code !== "PGRST301" && !/network|fetch/i.test(error.message || "")) {
          console.error("Venta rechazada al sincronizar:", error.message, payload);
          alert(`Una venta guardada sin conexión fue rechazada al sincronizar: ${error.message}`);
        } else {
          remaining.push(payload);
          hadNetworkFailure = true;
        }
      }
    } catch (e) {
      remaining.push(payload); // sigue sin haber red
      hadNetworkFailure = true;
    }
  }
  lastSyncFailed = hadNetworkFailure;
  STATE.pending = remaining;
  savePending();
  updateConnBadge();
  if (!remaining.length) await loadData();
}

function updateConnBadge() {
  const badge = $("conn-badge"), text = $("conn-text");
  const pend = STATE.pending.length;
  if (!navigator.onLine) {
    badge.classList.add("offline");
    text.textContent = pend ? `Sin conexión · ${pend} venta(s) por enviar` : "Sin conexión — puedes seguir cobrando";
  } else if (pend) {
    badge.classList.add("offline");
    // El WiFi puede estar conectado pero sin internet de verdad; en ese caso
    // no decimos "sincronizando", decimos la verdad: siguen sin enviarse.
    text.textContent = lastSyncFailed
      ? `${pend} venta(s) guardadas aquí, sin poder enviarse todavía`
      : `Sincronizando ${pend} venta(s)…`;
  } else {
    badge.classList.remove("offline");
    text.textContent = "En línea";
  }
}

window.addEventListener("online", () => { updateConnBadge(); syncPending(); if (typeof pintarClienteSeleccionado === "function") pintarClienteSeleccionado(); });
window.addEventListener("offline", () => { updateConnBadge(); if (typeof pintarClienteSeleccionado === "function") pintarClienteSeleccionado(); });
setInterval(() => { if (navigator.onLine) syncPending(); }, 60000);

/* ===========================================================================
   4. MOTOR DE PRECIOS Y COSTOS
   ---------------------------------------------------------------------------
   Al cliente se le cobra un precio único por gramo del total (vaso + helado +
   toppings). Internamente se calcula el costo real de cada componente, porque
   no todos los toppings cuestan lo mismo. Los toppings "tier 2" llevan un
   recargo por gramo para que no se coman el margen.
   =========================================================================== */
function computeSale({ pricePerGram, includeCupWeight, iceCream, toppings, cup, spoon, marginTargetPct, products = [] }) {
  const lines = [];
  const tareG = cup ? (cup.tare_weight_g || 0) : 0;
  const toppingsWeightSum = toppings.reduce((s, t) => s + t.weight_g, 0);
  const grossWeightG = tareG + (iceCream.weight_g || 0) + toppingsWeightSum;

  let totalPrice = 0, totalCost = 0;
  const alerts = [];

  if (cup) {
    const priceContribution = includeCupWeight ? tareG * pricePerGram : 0;
    lines.push({ item_type: "vaso", ref_id: cup.id, name: cup.name, weight_g: tareG,
                 cost: cup.cost_per_unit || 0, price_contribution: priceContribution, is_premium_surcharge: false });
    totalCost += cup.cost_per_unit || 0;
    totalPrice += priceContribution;
  }
  if (spoon) {
    lines.push({ item_type: "cuchara", ref_id: spoon.id, name: spoon.name, weight_g: 0,
                 cost: spoon.cost_per_unit || 0, price_contribution: 0, is_premium_surcharge: false });
    totalCost += spoon.cost_per_unit || 0;
  }
  if (iceCream.weight_g > 0) {
    const price = iceCream.weight_g * pricePerGram;
    const cost = iceCream.weight_g * (iceCream.cost_per_gram || 0);
    lines.push({ item_type: "helado", ref_id: iceCream.id, name: iceCream.name, weight_g: iceCream.weight_g,
                 cost, price_contribution: price, is_premium_surcharge: false });
    totalPrice += price; totalCost += cost;
  }
  for (const t of toppings) {
    const base = t.weight_g * pricePerGram;
    const surcharge = t.tier === 2 ? t.weight_g * (t.surcharge_per_gram || 0) : 0;
    const priceContribution = base + surcharge;
    const cost = t.weight_g * (t.cost_per_gram || 0);
    lines.push({ item_type: "topping", ref_id: t.id, name: t.name, weight_g: t.weight_g,
                 cost, price_contribution: priceContribution, is_premium_surcharge: t.tier === 2 });
    totalPrice += priceContribution; totalCost += cost;

    const lineMarginPct = priceContribution > 0 ? (100 * (priceContribution - cost)) / priceContribution : 0;
    if (cost > priceContribution) {
      alerts.push(`El topping "${t.name}" cuesta más de lo que aporta al precio. Súbelo a tier 2 o aumenta su recargo.`);
    } else if (t.weight_g > 0 && lineMarginPct < marginTargetPct) {
      alerts.push(`El margen del topping "${t.name}" (${r2(lineMarginPct)}%) está bajo la meta (${marginTargetPct}%).`);
    }
  }

  // Productos de precio fijo: precio por unidad, sin peso.
  for (const p of products) {
    const price = r2(p.qty * p.price), cost = r2(p.qty * p.cost);
    lines.push({ item_type: "producto", ref_id: p.id, name: p.name, quantity: p.qty, weight_g: 0,
                 cost, price_contribution: price, is_premium_surcharge: false });
    totalPrice += price; totalCost += cost;
  }

  const margin = totalPrice - totalCost;
  const marginPct = totalPrice > 0 ? (100 * margin) / totalPrice : 0;
  if (totalPrice > 0 && marginPct < marginTargetPct) {
    alerts.push(`Margen de la venta (${r2(marginPct)}%) por debajo de la meta (${marginTargetPct}%).`);
  }

  return {
    lines, gross_weight_g: r2(grossWeightG), total_price: r2(totalPrice), total_cost: r2(totalCost),
    margin: r2(margin), margin_pct: r2(marginPct), alerts,
  };
}

function suggestToppingTier(costPerGram, pricePerGram, marginTargetPct) {
  if (!(pricePerGram > 0)) {
    return { tier: 1, surcharge: 0, reason: "Configura primero un precio por gramo mayor a cero." };
  }
  const marginPctWithout = (100 * (pricePerGram - costPerGram)) / pricePerGram;
  if (marginPctWithout >= marginTargetPct) {
    return { tier: 1, surcharge: 0, reason: `Con el precio base deja ${r2(marginPctWithout)}% — puede ir en tier 1.` };
  }
  const requiredPrice = costPerGram / (1 - marginTargetPct / 100);
  return {
    tier: 2, surcharge: r2(Math.max(0, requiredPrice - pricePerGram)),
    reason: `Con el precio base solo deja ${r2(marginPctWithout)}% — necesita tier 2 con recargo.`,
  };
}

/* ===========================================================================
   5. AUTENTICACIÓN
   =========================================================================== */
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!sb) return;
  const btn = $("login-btn"), err = $("login-error");
  err.hidden = true; btn.disabled = true; btn.textContent = "Entrando…";
  try {
    const { error } = await sb.auth.signInWithPassword({
      email: $("login-email").value.trim(),
      password: $("login-password").value,
    });
    if (error) throw error;
    await startSession();
  } catch (ex) {
    err.textContent = /Invalid login/i.test(ex.message || "")
      ? "Correo o contraseña incorrectos."
      : `No se pudo entrar: ${ex.message}`;
    err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = "Entrar";
  }
});

/* --- Huella del teléfono (passkeys) ----------------------------------------
   Por qué el teléfono de cada quien y no un lector en la caja: un lector de
   Windows no sabe QUIÉN puso el dedo, solo que es uno de los registrados en
   esa computadora. En una caja compartida, la cajera elegiría la cuenta de
   la gerente y pondría su propio dedo. El teléfono es de una sola persona.
   Por eso tampoco se registra la huella desde la computadora de la caja. */
function textoErrorHuella(e) {
  const m = (e && (e.message || e.name)) || "";
  if (/NotAllowed|cancel|abort|timed? ?out/i.test(m)) return "Se canceló o se acabó el tiempo. Inténtalo otra vez.";
  if (/not support/i.test(m)) return "Este navegador no puede usar huella. Usa Chrome.";
  return m || "No se pudo.";
}
function esTelefono() {
  return !!(navigator.userAgentData && navigator.userAgentData.mobile)
    || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
}

if (HUELLA) $("login-passkey-area").hidden = false;
$("btn-login-passkey").addEventListener("click", async () => {
  if (!sb) return;
  const btn = $("btn-login-passkey"), err = $("login-error");
  err.hidden = true; btn.disabled = true;
  try {
    const { error } = await sb.auth.signInWithPasskey();
    if (error) throw error;
    await startSession();
  } catch (ex) {
    err.textContent = `No se pudo entrar con huella: ${textoErrorHuella(ex)}`;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

async function pintarHuellas() {
  const tb = document.querySelector("#table-huellas tbody");
  tb.innerHTML = '<tr><td colspan="2" class="hint">Cargando…</td></tr>';
  const { data, error } = await sb.auth.passkey.list();
  if (error) { tb.innerHTML = `<tr><td colspan="2" class="hint">${esc(textoErrorHuella(error))}</td></tr>`; return; }
  const lista = Array.isArray(data) ? data : (data && (data.passkeys || data.items)) || [];
  tb.innerHTML = lista.length ? "" : '<tr><td colspan="2" class="hint">Todavía no tienes ningún teléfono registrado.</td></tr>';
  const f = (d) => (d ? new Date(d).toLocaleDateString() : "—");
  lista.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(p.friendly_name || p.name || "Teléfono")}
        <span class="tl-meta">registrado ${esc(f(p.created_at))} · último uso ${esc(f(p.last_used_at))}</span></td>
      <td style="width:44px;"><button class="icon-btn delete" type="button" title="Borrar" aria-label="Borrar">${ICON_TRASH}</button></td>`;
    tr.querySelector("button").addEventListener("click", async () => {
      if (!confirm("¿Borrar este teléfono? Ya no podrá entrar ni autorizar con huella.")) return;
      const { error: e2 } = await sb.auth.passkey.delete({ passkeyId: p.id });
      $("huella-msg").textContent = e2 ? textoErrorHuella(e2) : "Borrado.";
      pintarHuellas();
    });
    tb.appendChild(tr);
  });
}

if (HUELLA) { $("btn-mi-huella").hidden = false; $("btn-mi-huella").innerHTML = ICON_FINGER; }
$("btn-mi-huella").addEventListener("click", () => {
  const tel = esTelefono();
  $("huella-registrar-area").hidden = !tel;
  $("huella-solo-telefono").hidden = tel;
  $("huella-msg").textContent = "";
  $("huella-modal").hidden = false;
  pintarHuellas();
});
$("btn-huella-cerrar").addEventListener("click", () => { $("huella-modal").hidden = true; });
$("btn-huella-registrar").addEventListener("click", async () => {
  const btn = $("btn-huella-registrar"); btn.disabled = true;
  $("huella-msg").textContent = "Confirma con tu huella o tu cara…";
  const { error } = await sb.auth.registerPasskey();
  btn.disabled = false;
  $("huella-msg").textContent = error ? `No se pudo registrar: ${textoErrorHuella(error)}` : "Listo: ya puedes entrar con tu huella.";
  pintarHuellas();
});

$("btn-logout").addEventListener("click", async () => {
  if (STATE.pending.length && !confirm(`Hay ${STATE.pending.length} venta(s) sin enviar. Si sales, quedan guardadas en este dispositivo hasta que alguien vuelva a entrar aquí. ¿Salir de todos modos?`)) return;
  await sb.auth.signOut();
  location.reload();
});

async function startSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { showLogin(); return; }
  STATE.session = session;

  const { data: profile, error } = await sb
    .from("profiles").select("*").eq("id", session.user.id).single();

  if (error || !profile) {
    alert("Tu usuario no tiene perfil configurado. Pídele al propietario que te asigne rol y sucursal.");
    await sb.auth.signOut(); showLogin(); return;
  }
  if (!profile.active) {
    alert("Tu usuario está desactivado. Habla con el propietario.");
    await sb.auth.signOut(); showLogin(); return;
  }
  if (profile.role !== "propietario" && !profile.location_id) {
    alert("Tu usuario todavía no tiene sucursal asignada. Pídele al propietario que te la asigne.");
    await sb.auth.signOut(); showLogin(); return;
  }

  STATE.profile = profile;
  loadPending();
  $("login-screen").hidden = true;
  $("app").hidden = false;
  applyRoleVisibility();
  await loadData();
  // Un pedido pesado que quedó a medias (se recargó la caja) se registra
  // como anulado antes de empezar a cobrar.
  await recuperarPedidoAbandonado();
  await syncPending();
  updateConnBadge();
  if (canManage()) await loadDashboard();
}

function showLogin() {
  $("login-screen").hidden = false;
  $("app").hidden = true;
}

const ROLE_RANK = { cajera: 1, gerente: 2, propietario: 3 };
function applyRoleVisibility() {
  const rank = ROLE_RANK[STATE.profile.role] || 0;
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    const need = btn.dataset.minRole;
    btn.hidden = need ? rank < ROLE_RANK[need] : false;
  });
  $("user-badge").textContent = `${STATE.profile.full_name || "Usuario"} · ${STATE.profile.role}`;
  $("owner-location-picker").hidden = !isOwner();

  // La cajera abre directo en Venta, que es lo único que le toca. Gerente y
  // propietario abren en el tablero: es la pantalla de "cómo va el negocio".
  const inicio = canManage() ? "dashboard" : "venta";
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === inicio));
  document.querySelectorAll(".tab-panel").forEach((pnl) => pnl.classList.toggle("active", pnl.id === "tab-" + inicio));
}

/* ===========================================================================
   6. CARGA DE DATOS
   =========================================================================== */
async function loadData() {
  if (!navigator.onLine) { loadFromCache(); return; }
  try {
    const { data: locations, error: locErr } = await sb.from("locations").select("*").order("name");
    if (locErr) throw locErr;
    STATE.locations = locations || [];

    if (!STATE.activeLocationId) {
      const remembered = lsGet(LS.lastLocation, null);
      STATE.activeLocationId = STATE.profile.location_id
        || (remembered && STATE.locations.some((l) => l.id === remembered) ? remembered : null)
        || (STATE.locations[0] && STATE.locations[0].id);
    }
    lsSet(LS.lastLocation, STATE.activeLocationId);

    const locId = STATE.activeLocationId;
    const [fl, tp, sp, pr] = await Promise.all([
      sb.from("flavors").select("*").eq("location_id", locId).eq("active", true).order("name"),
      sb.from("toppings").select("*").eq("location_id", locId).eq("active", true).order("name"),
      sb.from("supplies").select("*").eq("location_id", locId).eq("active", true).order("name"),
      sb.from("products").select("*").eq("location_id", locId).eq("active", true).order("family").order("sort").order("name"),
    ]);
    STATE.flavors = fl.data || [];
    STATE.toppings = tp.data || [];
    STATE.supplies = sp.data || [];
    STATE.products = pr.data || [];

    let salesQuery = sb.from("sales").select("*, locations(name)").order("created_at", { ascending: false }).limit(200);
    if (!isOwner()) salesQuery = salesQuery.eq("location_id", locId);
    const { data: sales } = await salesQuery;
    STATE.sales = sales || [];

    if (isOwner()) {
      const { data: profiles } = await sb.from("profiles").select("*").order("full_name");
      STATE.profiles = profiles || [];
    }

    cacheCatalog();
    await cargarReglasFidelizacion();
  } catch (e) {
    console.error("No se pudo cargar del servidor, usando copia local:", e);
    loadFromCache();
  }
  renderAll();
}

function cacheCatalog() {
  lsSet(LS.catalog(STATE.activeLocationId), {
    location: activeLocation(),
    flavors: STATE.flavors, toppings: STATE.toppings, supplies: STATE.supplies, products: STATE.products,
    savedAt: new Date().toISOString(),
  });
}

function loadFromCache() {
  const locId = STATE.activeLocationId || STATE.profile.location_id || lsGet(LS.lastLocation, null);
  const cached = lsGet(LS.catalog(locId), null);
  if (!cached) return;
  STATE.activeLocationId = locId;
  STATE.locations = cached.location ? [cached.location] : [];
  STATE.flavors = cached.flavors || [];
  STATE.toppings = cached.toppings || [];
  STATE.supplies = cached.supplies || [];
  STATE.products = cached.products || [];
}

function renderAll() {
  const loc = activeLocation();
  $("location-tag").textContent = loc ? loc.name : "Sin sucursal";
  fillSaleSelectors();
  pintarModo();
  renderToppingChips();
  renderOrderRows();
  renderProductos();
  renderQuote();
  if (canManage()) {
    renderInventory();
    renderProductsTable();
    renderToppingsTable();
    renderReports();
    renderClosing();
    fillConfigForm();
  }
  if (canManage()) { fillDashLocationPicker(); llenarSelectoresGastos(); }
  if (GAS.loaded) renderGastos();
  if (isOwner()) { fillReportLocationPicker(); renderAdmin(); }
  if (DASH.loaded) renderDashboard();
}

/* ===========================================================================
   7. PESTAÑAS
   =========================================================================== */
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.add("active");
    // El tablero pide números al servidor, así que no se carga hasta que
    // alguien lo abre. Después se refresca solo al cambiar los filtros.
    if (btn.dataset.tab === "dashboard" && !DASH.loaded) loadDashboard();
    if (btn.dataset.tab === "gastos" && !GAS.loaded) cargarGastos();
    if (btn.dataset.tab === "compras") { prepararCompras(); if (!CMP.loaded) cargarCompras(); }
    if (btn.dataset.tab === "clientes") { llenarReglas(); if (!CLI.loaded) cargarClientes(""); }
    if (btn.dataset.tab === "reportes") { cargarControlPesos(); prepararLibroVentas(); }
    if (btn.dataset.tab === "config") pintarEstadoPin();
  });
});

/* ===========================================================================
   8. VENTA
   =========================================================================== */
let iceUnit = "g";
const orderRows = [];
// Productos de precio fijo del pedido en curso: [{ productId, qty }]. No se
// pesan, así que se pueden quitar sin anular (no hay nada fijo que proteger).
const pedidoProductos = [];

/* --- Lo pesado queda fijo ----------------------------------------------------
   Regla del negocio (2026-10-07). En el sistema anterior la cajera leía la
   báscula y tecleaba el número; podía escribir el que quisiera. Aquí:
   · Todo se pesa sobre el MISMO vaso, sin quitarlo. Cada "Pesar" toma una
     lectura ESTABLE de la báscula y se cobra lo que esa lectura subió desde
     la anterior. El helado es la primera lectura menos la tara del vaso, y
     la tara sale del catálogo: no se teclea.
   · Una línea ya pesada no se borra ni se edita, y el vaso ya no se cambia.
     Lo único posible es anular el pedido completo, y eso queda registrado
     con nombre y motivo.
   · Si la báscula falla, se teclea el peso con el PIN de una gerente.
   · El pedido en curso se guarda en el navegador. Si alguien recarga la caja
     para desaparecer un pedido pesado, al volver queda registrado como
     anulado. */
const PESO = {
  modo: "bascula",     // "bascula" | "manual"
  capturas: [],        // lecturas en orden: {que, g, crudo, at}
  ultimoBruto: null,   // última lectura (vaso + todo lo servido), en gramos
  heladoG: 0,
};
const LS_PEDIDO = "tutis_pedido_en_curso";
const LS_ANULACIONES = "tutis_pending_voids";

function hayPesado() {
  if (PESO.modo === "bascula") return PESO.capturas.length > 0;
  return (parseFloat($("inp-ice-weight").value) || 0) > 0 || orderRows.some((r) => r.weight > 0);
}

function wireUnitToggle(containerId, getUnit, setUnit, inputId) {
  $(containerId).addEventListener("click", (e) => {
    const btn = e.target.closest("button"); if (!btn) return;
    const newUnit = btn.dataset.unit, oldUnit = getUnit();
    if (newUnit === oldUnit) return;
    document.querySelectorAll(`#${containerId} button`).forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const input = $(inputId);
    const val = parseFloat(input.value);
    if (!isNaN(val) && val > 0) {
      input.value = newUnit === "oz" ? r2(toOz(toGrams(val, oldUnit))) : r2(toGrams(val, oldUnit));
    }
    setUnit(newUnit);
    renderQuote();
  });
}
wireUnitToggle("unit-ice", () => iceUnit, (u) => (iceUnit = u), "inp-ice-weight");

function fillSaleSelectors() {
  const cupSel = $("sel-cup"), spoonSel = $("sel-spoon"), flavorSel = $("sel-flavor");
  const keep = { cup: cupSel.value, spoon: spoonSel.value, flavor: flavorSel.value };

  cupSel.innerHTML = ""; spoonSel.innerHTML = ""; flavorSel.innerHTML = "";
  STATE.supplies.filter((s) => s.kind === "vaso").forEach((s) => {
    const o = document.createElement("option");
    o.value = s.id; o.textContent = s.name;
    cupSel.appendChild(o);
  });
  STATE.supplies.filter((s) => s.kind === "cuchara").forEach((s) => {
    const o = document.createElement("option");
    o.value = s.id; o.textContent = s.name; spoonSel.appendChild(o);
  });
  STATE.flavors.forEach((f) => {
    const o = document.createElement("option");
    o.value = f.id; o.textContent = f.name; flavorSel.appendChild(o);
  });
  if (keep.cup)    cupSel.value = keep.cup;
  if (keep.spoon)  spoonSel.value = keep.spoon;
  if (keep.flavor) flavorSel.value = keep.flavor;

  aplicarUnidadPreferida();

  const loc = activeLocation();
  $("price-per-gram-hint").textContent = loc
    ? (prefUnit() === "oz"
        ? `Precio único: ${money(Number(loc.price_per_gram) * OZ_TO_G)} por onza`
        : `Precio único: ${money(loc.price_per_gram)} por gramo`)
    : "";
  pintarTara();
  pintarCuadrosVenta();
}

/* --- Cuadros táctiles ---------------------------------------------------------
   En la caja se toca con el dedo, como en ICG: cada opción es un cuadro grande.
   Los <select> siguen ahí (ocultos) y son la fuente de la verdad: el cálculo,
   el pedido guardado y las pruebas los leen. Un cuadro solo cambia el select y
   avisa con "change", así que nada de la lógica de venta cambió.
   Si el select está deshabilitado (el vaso, una vez pesado), los cuadros también. */
function pintarCuadros(selectId, cuadrosId, opciones = {}) {
  const sel = $(selectId), wrap = $(cuadrosId);
  if (!sel || !wrap) return;
  const extra = opciones.extra || [];
  const items = [...sel.options].map((o) => ({ value: o.value, label: o.textContent, sub: (opciones.sub || (() => ""))(o.value) }));
  wrap.innerHTML = "";
  [...items, ...extra].forEach((it) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tile";
    b.setAttribute("role", "radio");
    const activo = it.activo ? it.activo() : (sel.value === it.value && !(opciones.apagado && opciones.apagado()));
    b.setAttribute("aria-checked", String(!!activo));
    b.disabled = sel.disabled;
    b.innerHTML = `<span class="tile-name">${esc(it.label)}</span>${it.sub ? `<span class="tile-sub">${esc(it.sub)}</span>` : ""}`;
    b.addEventListener("click", () => {
      if (it.click) it.click();
      else {
        sel.value = it.value;
        if (opciones.alElegir) opciones.alElegir();
        sel.dispatchEvent(new Event("change"));
      }
      pintarCuadrosVenta();
    });
    wrap.appendChild(b);
  });
}

function pintarCuadrosVenta() {
  pintarCuadros("sel-cup", "tiles-cup", {
    sub: (id) => { const c = STATE.supplies.find((x) => x.id === id); return c ? `tara ${fmtWeightShort(Number(c.tare_weight_g) || 0)}` : ""; },
  });
  const spoon = $("chk-spoon");
  pintarCuadros("sel-spoon", "tiles-spoon", {
    apagado: () => !spoon.checked,
    // Elegir una cuchara la vuelve a incluir.
    alElegir: () => { spoon.checked = true; },
    extra: [{ label: "Sin cuchara", activo: () => !spoon.checked,
              click: () => { spoon.checked = false; spoon.dispatchEvent(new Event("change")); } }],
  });
  pintarCuadros("sel-flavor", "tiles-flavor");
  pintarCuadros("sel-payment", "tiles-payment");
}

// La unidad de la tienda solo importa para teclear a mano; lo que viene de
// la báscula ya llega en gramos. Solo actúa cuando la unidad cambió: si la
// cajera ya movió el botón a mano en plena venta, no se lo pisamos.
let unidadAplicada = null;
function aplicarUnidadPreferida() {
  const u = prefUnit();
  if (u === unidadAplicada) return;
  unidadAplicada = u;
  iceUnit = u;
  markUnitButtons("unit-ice", u);
}

// La tara es la del catálogo. Antes se podía teclear, y una tara inflada
// es peso que se le resta al cliente sin que nadie lo note.
function pintarTara() {
  const cup = STATE.supplies.find((s) => s.id === $("sel-cup").value);
  $("cup-tare-hint").textContent = cup
    ? `Tara del vaso: ${fmtWeight(Number(cup.tare_weight_g) || 0)}. Sale del catálogo; se descuenta sola.`
    : "";
}
$("sel-cup").addEventListener("change", () => { pintarTara(); renderQuote(); });
$("inp-ice-weight").addEventListener("input", renderQuote);
["sel-flavor", "sel-spoon", "chk-spoon"].forEach((id) => $(id).addEventListener("change", renderQuote));

// Cada familia de toppings con su color, como las familias de ICG. El color
// solo ayuda a ubicarse: el nombre y la familia siempre van escritos.
const FAMILIAS_TOPPING = ["dulce", "mani", "salsa", "jalea", "fruta", "cereal", "otro"];
function renderToppingChips() {
  const wrap = $("topping-chips");
  wrap.innerHTML = "";
  const orden = (c) => { const i = FAMILIAS_TOPPING.indexOf(c); return i < 0 ? 99 : i; };
  STATE.toppings.slice().sort((a, b) => orden(a.category) - orden(b.category) || String(a.name).localeCompare(String(b.name))).forEach((t) => {
    const chip = document.createElement("button");
    chip.type = "button";
    const fam = FAMILIAS_TOPPING.includes(t.category) ? t.category : "otro";
    chip.className = `tile topping-tile fam-${fam}` + (t.tier === 2 ? " tier2" : "");
    chip.innerHTML = `<span class="tile-name">${esc(t.name)}</span><span class="tile-sub">${esc(t.category === "mani" ? "maní" : t.category)}</span>` +
      (t.tier === 2 ? `<span class="tile-badge">premium</span>` : "");
    chip.addEventListener("click", () => {
      orderRows.push({ rowId: "r" + Date.now() + Math.random(), toppingId: t.id, weight: 0, unit: prefUnit(), pesadoG: null });
      renderOrderRows(); renderQuote();
    });
    wrap.appendChild(chip);
  });
}

function renderOrderRows() {
  const wrap = $("order-rows");
  wrap.innerHTML = "";
  const manual = PESO.modo === "manual";
  orderRows.forEach((row) => {
    const div = document.createElement("div");
    div.className = "order-row";

    const select = document.createElement("select");
    STATE.toppings.forEach((t) => {
      const o = document.createElement("option");
      o.value = t.id; o.textContent = t.name;
      if (t.id === row.toppingId) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener("change", () => { row.toppingId = select.value; guardarPedido(); renderQuote(); });

    let peso, accion;
    if (manual) {
      peso = document.createElement("input");
      peso.type = "number"; peso.min = "0"; peso.step = "0.1";
      peso.placeholder = "peso"; peso.value = row.weight || "";
      peso.addEventListener("input", () => { row.weight = parseFloat(peso.value) || 0; renderQuote(); });
      accion = document.createElement("select");
      ["g", "oz"].forEach((u) => {
        const o = document.createElement("option");
        o.value = u; o.textContent = u; if (u === row.unit) o.selected = true;
        accion.appendChild(o);
      });
      accion.addEventListener("change", () => { row.unit = accion.value; renderQuote(); });
    } else {
      peso = document.createElement("span");
      peso.className = "weigh-value num";
      peso.textContent = row.pesadoG == null ? "—" : fmtWeightShort(row.pesadoG);
      if (row.pesadoG == null) {
        accion = document.createElement("button");
        accion.type = "button"; accion.className = "btn primary touch-weigh"; accion.textContent = "⚖ Pesar";
        accion.addEventListener("click", () => pesar("topping", row, accion));
      } else {
        accion = document.createElement("span");
        accion.className = "weigh-lock"; accion.textContent = "fijo";
        accion.title = "Pesado en la báscula. No se puede cambiar.";
      }
    }

    // Lo ya pesado no se quita: se anula el pedido completo, y eso queda
    // registrado. Quitar una línea suelta es exactamente lo que se veía en
    // el sistema anterior ("1.5 Bubble Pop" y luego "-1.5 Bubble Pop").
    let removeBtn;
    if (manual || row.pesadoG == null) {
      removeBtn = document.createElement("button");
      removeBtn.className = "row-remove"; removeBtn.textContent = "✕"; removeBtn.type = "button";
      removeBtn.title = "Quitar";
      removeBtn.addEventListener("click", () => {
        const i = orderRows.indexOf(row);
        if (i >= 0) orderRows.splice(i, 1);
        renderOrderRows(); renderQuote();
      });
    } else {
      removeBtn = document.createElement("span");
    }

    div.append(select, peso, accion, removeBtn);
    wrap.appendChild(div);
  });
}

/* --- Productos de precio fijo -------------------------------------------------
   Como en ICG: arriba las familias, abajo sus productos en cuadros. Tocar un
   producto lo suma al pedido; las líneas tienen − y + para la cantidad. */
let familiaProducto = null;
function renderProductos() {
  const card = $("products-card");
  if (!card) return;
  card.hidden = !STATE.products.length;
  if (!STATE.products.length) return;
  const familias = [...new Set(STATE.products.map((p) => p.family))];
  if (!familias.includes(familiaProducto)) familiaProducto = familias[0];

  const fam = $("product-families");
  fam.innerHTML = "";
  familias.forEach((f, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = `tile fam-tab fam-color-${i % 8}`;
    b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(f === familiaProducto));
    b.innerHTML = `<span class="tile-name">${esc(f)}</span>`;
    b.addEventListener("click", () => { familiaProducto = f; renderProductos(); });
    fam.appendChild(b);
  });

  const tiles = $("product-tiles");
  tiles.innerHTML = "";
  STATE.products.filter((p) => p.family === familiaProducto).forEach((p) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "tile product-tile";
    const agotado = p.stock_qty != null && Number(p.stock_qty) <= 0;
    b.innerHTML = `<span class="tile-price num">${money(p.price)}</span><span class="tile-name">${esc(p.name)}</span>` +
      (agotado ? `<span class="tile-sub">sin existencias</span>` : "");
    b.addEventListener("click", () => {
      const x = pedidoProductos.find((y) => y.productId === p.id);
      if (x) x.qty += 1; else pedidoProductos.push({ productId: p.id, qty: 1 });
      renderProductos(); renderQuote();
    });
    tiles.appendChild(b);
  });

  const rows = $("product-rows");
  rows.innerHTML = "";
  pedidoProductos.forEach((x) => {
    const p = STATE.products.find((y) => y.id === x.productId);
    if (!p) return;
    const div = document.createElement("div");
    div.className = "product-row";
    div.innerHTML = `<span class="pr-name">${esc(p.name)}</span>
      <button type="button" class="btn ghost pr-btn" aria-label="Quitar uno">−</button>
      <span class="pr-qty num">${x.qty}</span>
      <button type="button" class="btn ghost pr-btn" aria-label="Agregar uno">+</button>
      <span class="pr-total num">${money(r2(x.qty * Number(p.price)))}</span>`;
    const [menos, mas] = div.querySelectorAll(".pr-btn");
    menos.addEventListener("click", () => {
      x.qty -= 1;
      if (x.qty <= 0) pedidoProductos.splice(pedidoProductos.indexOf(x), 1);
      renderProductos(); renderQuote();
    });
    mas.addEventListener("click", () => { x.qty += 1; renderProductos(); renderQuote(); });
    rows.appendChild(div);
  });
}

function buildPlan() {
  const loc = activeLocation();
  if (!loc) return null;
  const flavor = STATE.flavors.find((f) => f.id === $("sel-flavor").value);
  const cupRow = STATE.supplies.find((s) => s.id === $("sel-cup").value);
  const spoonRow = $("chk-spoon").checked ? STATE.supplies.find((s) => s.id === $("sel-spoon").value) : null;
  const productos = pedidoProductos.map((x) => {
    const p = STATE.products.find((y) => y.id === x.productId);
    return p ? { id: p.id, name: p.name, qty: x.qty, price: Number(p.price) || 0, cost: Number(p.cost) || 0, stock_qty: p.stock_qty } : null;
  }).filter(Boolean);
  if ((!flavor || !cupRow) && !productos.length) return null;

  const manual = PESO.modo === "manual";
  const cupWeightG = cupRow ? Number(cupRow.tare_weight_g) || 0 : 0;
  const iceWeightG = manual ? toGrams(parseFloat($("inp-ice-weight").value) || 0, iceUnit) : PESO.heladoG;

  const toppings = orderRows.map((row) => {
    const t = STATE.toppings.find((x) => x.id === row.toppingId);
    if (!t) return null;
    return { id: t.id, name: t.name, weight_g: manual ? toGrams(row.weight, row.unit) : (row.pesadoG || 0),
             cost_per_gram: Number(t.cost_per_gram), tier: t.tier, surcharge_per_gram: Number(t.surcharge_per_gram) };
  }).filter((t) => t && t.weight_g > 0);   // una línea todavía sin pesar no va al ticket

  // Hay taza cuando ya hay helado o toppings con peso. Una venta de solo
  // productos (un agua, un roll) no cobra vaso ni cuchara.
  const hayTaza = !!flavor && !!cupRow && (iceWeightG > 0 || toppings.length > 0);

  return {
    loc, flavorRow: flavor, cupRow, spoonRow, cupWeightG, iceWeightG, toppings, productos, hayTaza,
    args: {
      pricePerGram: Number(loc.price_per_gram),
      includeCupWeight: loc.include_cup_weight_in_price,
      marginTargetPct: Number(loc.margin_target_pct),
      iceCream: flavor ? { id: flavor.id, name: flavor.name, weight_g: hayTaza ? iceWeightG : 0, cost_per_gram: Number(flavor.cost_per_gram) }
                       : { id: null, name: "", weight_g: 0, cost_per_gram: 0 },
      toppings: hayTaza ? toppings : [],
      cup: hayTaza ? { id: cupRow.id, name: cupRow.name, tare_weight_g: cupWeightG, cost_per_unit: Number(cupRow.cost_per_unit) } : null,
      spoon: hayTaza && spoonRow ? { id: spoonRow.id, name: spoonRow.name, cost_per_unit: Number(spoonRow.cost_per_unit) } : null,
      products: productos,
    },
  };
}

/* --- Pesar ------------------------------------------------------------------ */
async function pesar(que, row, boton) {
  const plan = buildPlan();
  if (!plan || !plan.flavorRow || !plan.cupRow) { alert("Selecciona vaso y sabor."); return; }
  if (que === "topping" && !(PESO.heladoG > 0)) {
    pintarEstadoBascula("Primero pesa el helado: los toppings se pesan sobre el mismo vaso, después.", true);
    return;
  }
  if (boton) boton.disabled = true;
  let l;
  try {
    l = await balanza.capturar(4000);
  } catch (e) {
    pintarEstadoBascula(e.message, true);
    if (boton) boton.disabled = false;
    return;
  }
  if (boton) boton.disabled = false;

  const tara = plan.cupWeightG;
  const base = PESO.ultimoBruto == null ? tara : PESO.ultimoBruto;
  const neto = r2(l.gramos - base);
  if (neto <= 0) {
    pintarEstadoBascula(PESO.ultimoBruto == null
      ? `La báscula marca ${fmtWeightShort(l.gramos)}: no más que el vaso vacío (${fmtWeightShort(tara)}). ¿Está el vaso servido sobre la báscula?`
      : `La báscula marca ${fmtWeightShort(l.gramos)}: no más que la pesada anterior (${fmtWeightShort(PESO.ultimoBruto)}). Sirve el topping sobre el mismo vaso, sin quitarlo.`, true);
    return;
  }

  let nombre;
  if (que === "helado") {
    if (PESO.heladoG > 0) return;
    PESO.heladoG = neto;
    nombre = plan.flavorRow.name;
  } else {
    if (row.pesadoG != null) return;
    row.pesadoG = neto;
    const t = STATE.toppings.find((x) => x.id === row.toppingId);
    nombre = t ? t.name : "topping";
  }
  PESO.ultimoBruto = l.gramos;
  PESO.capturas.push({ que: nombre, neto_g: neto, g: l.gramos, crudo: l.crudo, at: new Date(l.at).toISOString() });
  pintarEstadoBascula(`${nombre}: ${fmtWeight(neto)} — fijo.`, false);
  guardarPedido();
  pintarModo();
  renderOrderRows();
  renderQuote();
}
$("btn-weigh-ice").addEventListener("click", () => pesar("helado", null, $("btn-weigh-ice")));

function guardarPedido() {
  if (PESO.modo !== "bascula" || !PESO.capturas.length) return;
  lsSet(LS_PEDIDO, armarAnulacion(null));
}

// Lo que se mostraría si el pedido se anulara ahora: qué se pesó y cuánto.
function armarAnulacion(motivo) {
  const plan = buildPlan();
  const items = [];
  if (plan && plan.iceWeightG > 0) items.push({ n: plan.flavorRow.name, g: r2(plan.iceWeightG) });
  if (plan) plan.toppings.forEach((t) => { if (t.weight_g > 0) items.push({ n: t.name, g: r2(t.weight_g) }); });
  const previo = lsGet(LS_PEDIDO, null);
  return {
    location_id: STATE.activeLocationId,
    client_uuid: (previo && previo.client_uuid) || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
    created_at: new Date().toISOString(),
    weighed_g: r2(items.reduce((s, i) => s + i.g, 0)),
    items,
    scale_log: PESO.modo === "bascula" ? PESO.capturas : null,
    reason: motivo,
    manual: PESO.modo === "manual",
  };
}

function limpiarPedido() {
  PESO.capturas = [];
  PESO.ultimoBruto = null;
  PESO.heladoG = 0;
  orderRows.length = 0;
  pedidoProductos.length = 0;
  $("inp-ice-weight").value = "";
  // Cada venta arranca en efectivo, como en ICG: así una tarjeta de la venta
  // anterior no se cuela en el cuadre de la siguiente.
  $("sel-payment").value = "efectivo";
  pintarTarjeta();
  try { localStorage.removeItem(LS_PEDIDO); } catch (e) {}
  pintarModo();
  renderOrderRows();
  renderProductos();
  renderQuote();
}

/* --- Anular un pedido ------------------------------------------------------- */
async function registrarAnulacion(payload) {
  const { manual, ...datos } = payload;
  if (manual) datos.reason = `[pesos a mano] ${datos.reason}`;
  try {
    if (!navigator.onLine || !sb) throw new Error("offline");
    const { error } = await sb.rpc("registrar_anulacion", { payload: datos });
    if (error) throw error;
  } catch (e) {
    // Como las ventas: si no se pudo enviar, se guarda y se manda después.
    const cola = lsGet(LS_ANULACIONES, []);
    if (!cola.some((x) => x.client_uuid === datos.client_uuid)) cola.push(datos);
    lsSet(LS_ANULACIONES, cola);
  }
}

async function syncAnulaciones() {
  const cola = lsGet(LS_ANULACIONES, []);
  if (!cola.length || !sb || !navigator.onLine) return;
  const quedan = [];
  for (const p of cola) {
    try {
      const { error } = await sb.rpc("registrar_anulacion", { payload: { ...p, synced_offline: true } });
      if (error && (/network|fetch/i.test(error.message || "") || !error.code)) quedan.push(p);
      else if (error) console.error("Anulación rechazada al sincronizar:", error.message, p);
    } catch (e) {
      quedan.push(p);
    }
  }
  lsSet(LS_ANULACIONES, quedan);
}

// Un pedido pesado que quedó a medias porque se recargó o se cerró la caja.
async function recuperarPedidoAbandonado() {
  const p = lsGet(LS_PEDIDO, null);
  if (!p || !p.items || !p.items.length) { try { localStorage.removeItem(LS_PEDIDO); } catch (e) {} return; }
  await registrarAnulacion({ ...p, reason: "La caja se recargó o se cerró con un pedido pesado sin cobrar" });
  try { localStorage.removeItem(LS_PEDIDO); } catch (e) {}
}

$("btn-void-order").addEventListener("click", async () => {
  if (!hayPesado()) { limpiarPedido(); return; }
  const motivo = prompt("¿Por qué se anula este pedido ya pesado?\nQueda registrado con tu nombre y la gerente lo verá.");
  if (motivo === null) return;
  await registrarAnulacion(armarAnulacion(motivo.trim() || "(sin motivo)"));
  limpiarPedido();
});

/* --- Pesos a mano, con PIN de la gerente -------------------------------------
   Para cuando la báscula falla: la venta no se detiene, pero la gerente ve
   los pesos tecleados y los aprueba con su PIN. El PIN se valida en el
   servidor (nunca aquí) y la autorización cubre exactamente ese peso y una
   sola venta. Sin internet no hay cómo validar el PIN: se puede cobrar
   igual, y la venta queda marcada "a mano SIN autorizar" en el reporte. */
function pintarModo() {
  const manual = PESO.modo === "manual";
  $("manual-banner").hidden = !manual;
  $("btn-manual-mode").hidden = manual;
  $("out-ice-weight").hidden = manual;
  $("btn-weigh-ice").hidden = manual || PESO.heladoG > 0;
  $("inp-ice-weight").hidden = !manual;
  $("unit-ice").hidden = !manual;
  $("out-ice-weight").textContent = PESO.heladoG > 0 ? `${fmtWeight(PESO.heladoG)} · fijo` : "—";
  $("out-ice-weight").classList.toggle("locked", PESO.heladoG > 0);
  // Con algo ya pesado, la tara no puede cambiar: cambiaría lo que se cobra.
  $("sel-cup").disabled = !manual && PESO.capturas.length > 0;
  pintarCuadrosVenta();
  $("weigh-hint").innerHTML = manual
    ? "Teclea los pesos. Al cobrar, una gerente los revisa y autoriza con su PIN."
    : "Pon el vaso con el helado en la báscula y presiona <strong>Pesar</strong>. Lo pesado queda fijo.";
}

$("btn-manual-mode").addEventListener("click", () => {
  if (PESO.capturas.length) {
    alert("Este pedido ya tiene pesos de la báscula. Cóbralo o anúlalo antes de pasar a pesos a mano.");
    return;
  }
  if (!confirm("¿Pasar a pesos a mano?\n\nAl cobrar se pedirá el PIN de una gerente, y la venta queda marcada en el reporte de control de pesos.")) return;
  PESO.modo = "manual";
  pintarModo(); renderOrderRows(); renderQuote();
});
$("btn-manual-exit").addEventListener("click", () => {
  if (hayPesado() && !confirm("Se borran los pesos tecleados de este pedido. ¿Volver a la báscula?")) return;
  PESO.modo = "bascula";
  orderRows.forEach((r) => { r.weight = 0; r.pesadoG = null; });
  $("inp-ice-weight").value = "";
  pintarModo(); renderOrderRows(); renderQuote();
});

let resolverPin = null;
function pedirAutorizacion(plan, pesadoG) {
  return new Promise(async (resolve) => {
    resolverPin = resolve;
    const lineas = [];
    if (plan.iceWeightG > 0) lineas.push([plan.flavorRow.name, plan.iceWeightG]);
    plan.toppings.forEach((t) => { if (t.weight_g > 0) lineas.push([t.name, t.weight_g]); });
    $("pin-summary").innerHTML = lineas.map(([n, g]) =>
      `<div class="ticket-line"><span>${esc(n)}</span><span class="num">${esc(fmtWeight(g))}</span></div>`).join("") +
      `<div class="ticket-line"><strong>Total tecleado</strong><strong class="num">${esc(fmtWeight(pesadoG))}</strong></div>`;
    $("pin-code").value = "";
    $("pin-msg").textContent = "Cargando…";
    $("pin-reason").value = $("pin-reason").options[0].value;
    $("pin-reason-other").hidden = true;
    $("btn-pin-ok").disabled = true;
    $("pin-passkey-area").hidden = !HUELLA;
    $("btn-pin-passkey").disabled = false;
    $("pin-modal").hidden = false;

    const { data, error } = await sb.rpc("gerentes_para_autorizar", { p_location_id: STATE.activeLocationId });
    const sel = $("pin-manager");
    sel.innerHTML = "";
    (data || []).forEach((g) => {
      const o = document.createElement("option");
      o.value = g.id; o.textContent = g.full_name; sel.appendChild(o);
    });
    if (error) {
      $("pin-msg").textContent = "No se pudo consultar quién autoriza. Revisa la conexión.";
    } else if (!(data || []).length) {
      $("pin-msg").textContent = HUELLA
        ? "Nadie de esta tienda tiene PIN todavía: autoriza con la huella."
        : "Ninguna gerente de esta tienda tiene PIN todavía. Se crea en Configuración → Mi PIN de autorización.";
    } else {
      $("pin-msg").textContent = "";
      $("btn-pin-ok").disabled = false;
      $("pin-code").focus();
    }
    $("pin-modal").dataset.peso = String(pesadoG);
  });
}
function cerrarPin(resultado) {
  $("pin-modal").hidden = true;
  $("pin-code").value = "";
  const r = resolverPin; resolverPin = null;
  if (r) r(resultado);
}
$("pin-reason").addEventListener("change", () => {
  $("pin-reason-other").hidden = $("pin-reason").value !== "otro";
  if (!$("pin-reason-other").hidden) $("pin-reason-other").focus();
});
$("btn-pin-cancel").addEventListener("click", () => cerrarPin(null));
$("pin-code").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("btn-pin-ok").click(); } });
function motivoAutorizacion() {
  return $("pin-reason").value === "otro" ? $("pin-reason-other").value.trim() : $("pin-reason").value;
}

/* Con huella: se abre una sesión APARTE para la gerente, en memoria y solo
   para esta autorización. La de la cajera no se toca, y la de la gerente se
   cierra enseguida. La base exige que esa sesión venga de una passkey usada
   hace menos de 5 minutos (ver sql/11_huella.sql). */
let clienteAutoriza = null;
function sbAutoriza() {
  if (!clienteAutoriza) {
    clienteAutoriza = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
              storageKey: "tutis-autoriza", experimental: { passkey: true } },
    });
  }
  return clienteAutoriza;
}
$("btn-pin-passkey").addEventListener("click", async () => {
  const motivo = motivoAutorizacion();
  if (motivo.length < 3) { $("pin-msg").textContent = "Escribe el motivo."; return; }
  const btn = $("btn-pin-passkey"); btn.disabled = true;
  $("pin-msg").textContent = "Que la gerente escanee el código con su teléfono y confirme con su huella…";
  const cli = sbAutoriza();
  try {
    const { data: ses, error: e1 } = await cli.auth.signInWithPasskey();
    if (e1 || !ses || !ses.session) throw e1 || new Error("No se pudo verificar la huella.");
    const { data, error } = await cli.rpc("autorizar_peso_presencial", {
      p_location_id: STATE.activeLocationId, p_requested_by: STATE.profile.id,
      p_weight_g: Number($("pin-modal").dataset.peso), p_reason: motivo,
    });
    if (error) throw error;
    cerrarPin({ id: data.id, nombre: data.authorized_by_name });
  } catch (e) {
    $("pin-msg").textContent = textoErrorHuella(e);
  } finally {
    try { await cli.auth.signOut({ scope: "local" }); } catch (e) {}
    btn.disabled = false;
  }
});

$("btn-pin-ok").addEventListener("click", async () => {
  const pin = $("pin-code").value.trim();
  const motivo = motivoAutorizacion();
  if (!/^\d{4,8}$/.test(pin)) { $("pin-msg").textContent = "El PIN son de 4 a 8 números."; return; }
  if (motivo.length < 3) { $("pin-msg").textContent = "Escribe el motivo."; return; }
  const btn = $("btn-pin-ok"); btn.disabled = true;
  $("pin-msg").textContent = "Verificando…";
  const { data, error } = await sb.rpc("autorizar_peso_manual", {
    p_location_id: STATE.activeLocationId, p_manager_id: $("pin-manager").value, p_pin: pin,
    p_weight_g: Number($("pin-modal").dataset.peso), p_reason: motivo,
  });
  btn.disabled = false;
  if (error) { $("pin-msg").textContent = error.message; return; }
  if (!data || !data.ok) { $("pin-msg").textContent = (data && data.error) || "No se pudo autorizar."; $("pin-code").value = ""; return; }
  cerrarPin({ id: data.id, nombre: data.authorized_by_name });
});

/* --- Cliente frecuente -----------------------------------------------------
   Ganar puntos funciona sin internet: el id del cliente viaja en la venta y
   el servidor los suma al sincronizar. CANJEAR no: si se canjeara sin
   conexión y mientras tanto la clienta gastara esos puntos en la otra
   tienda, el servidor rechazaría la venta entera al sincronizar, y la cola
   trata ese rechazo como definitivo — se perdería el registro de una venta
   que sí ocurrió. No se puede gastar un saldo que no se puede verificar. */
const LOY = { cliente: null, cfg: null, maxPuntos: 0, maxDescuento: 0 };

async function cargarReglasFidelizacion() {
  if (!sb || !navigator.onLine) return;
  const { data } = await sb.from("loyalty_config").select("*").maybeSingle();
  if (data) { LOY.cfg = data; lsSet("tutis_loyalty_cfg", data); }
}
function reglasFidelizacion() {
  return LOY.cfg || lsGet("tutis_loyalty_cfg", null);
}

function pintarClienteSeleccionado() {
  const c = LOY.cliente;
  $("loy-search-area").hidden = !!c;
  $("loy-selected").hidden = !c;
  const sinRed = !navigator.onLine;
  $("loy-offline-hint").hidden = !sinRed;
  if (!c) { renderQuote(); return; }
  $("loy-sel-name").textContent = c.full_name;
  $("loy-sel-code").textContent = `Carnet ${c.card_code}`;
  $("loy-sel-points").textContent = c.points_balance;
  $("loy-redeem-row").hidden = sinRed;
  renderQuote();
}

// Si lo que llega es el enlace completo del carnet (alguien lo escaneó con
// la cámara y lo pegó), se saca el código del ?c=. Un lector de códigos de
// barras USB o Bluetooth "teclea" el código y da Enter, y eso ya busca solo.
function codigoDesdeTexto(t) {
  const m = /[?&]c=([A-Za-z0-9]+)/.exec(t);
  return m ? m[1].toUpperCase() : t;
}

async function buscarCliente() {
  const q = codigoDesdeTexto($("loy-q").value.trim());
  const box = $("loy-results");
  if (q.length < 3) { box.innerHTML = '<p class="hint">Escribe al menos 3 caracteres.</p>'; return; }
  if (!navigator.onLine) { box.innerHTML = '<p class="hint">Sin conexión no se puede buscar clientes.</p>'; return; }
  box.innerHTML = '<p class="hint">Buscando…</p>';
  const { data, error } = await sb.rpc("loyalty_buscar", { p_texto: q });
  if (error) { box.innerHTML = `<p class="hint">${esc(error.message)}</p>`; return; }
  const lista = data || [];
  if (!lista.length) { box.innerHTML = '<p class="hint">No hay nadie con ese dato. Puedes inscribirlo abajo.</p>'; return; }
  // Un código de carnet exacto identifica a una sola persona: se selecciona
  // de una vez. Es lo que hace instantáneo pasar el QR por el lector.
  const exacto = lista.find((c) => c.card_code.toUpperCase() === q.toUpperCase());
  if (exacto) { seleccionarCliente(exacto); return; }
  box.innerHTML = "";
  lista.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "loy-result";
    b.innerHTML = `<span><strong>${esc(c.full_name)}</strong><br><span class="hint">${esc(c.phone || "")} · ${esc(c.card_code)}</span></span>
                   <span class="num"><strong>${esc(c.points_balance)}</strong> pts</span>`;
    b.addEventListener("click", () => seleccionarCliente(c));
    box.appendChild(b);
  });
}

function seleccionarCliente(c) {
  LOY.cliente = c;
  $("loy-redeem").value = "0";
  $("loy-results").innerHTML = "";
  $("loy-q").value = "";
  pintarClienteSeleccionado();
}

function quitarCliente() {
  LOY.cliente = null; LOY.maxPuntos = 0; LOY.maxDescuento = 0;
  $("loy-redeem").value = "0";
  $("loy-redeem-hint").textContent = "";
  pintarClienteSeleccionado();
}

$("btn-loy-buscar").addEventListener("click", buscarCliente);
$("loy-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); buscarCliente(); } });
$("btn-loy-quitar").addEventListener("click", quitarCliente);
$("btn-loy-nuevo").addEventListener("click", () => {
  const f = $("loy-new-form"); f.hidden = !f.hidden;
  if (!f.hidden) $("loy-new-name").focus();
});

$("btn-loy-guardar").addEventListener("click", async () => {
  const msg = $("loy-new-msg");
  const nombre = $("loy-new-name").value.trim();
  const tel = $("loy-new-phone").value.trim();
  if (nombre.length < 2) { msg.textContent = "Escribe el nombre completo."; return; }
  if (!navigator.onLine) { msg.textContent = "Sin conexión no se puede inscribir. Cobra normal y lo inscribes después."; return; }
  const btn = $("btn-loy-guardar"); btn.disabled = true;
  const { data, error } = await sb.rpc("loyalty_registrar", { p_full_name: nombre, p_phone: tel || null });
  btn.disabled = false;
  if (error) { msg.textContent = error.message; return; }
  msg.textContent = "";
  $("loy-new-name").value = ""; $("loy-new-phone").value = "";
  $("loy-new-form").hidden = true;
  seleccionarCliente(data);
});

// El tope de canje lo decide el servidor. Aquí solo se le pregunta para
// mostrarle a la cajera la cifra real antes de cobrar.
let canjeTimer = null;
async function consultarTopeCanje(total) {
  if (!LOY.cliente || !navigator.onLine) { LOY.maxPuntos = 0; LOY.maxDescuento = 0; return; }
  const { data } = await sb.rpc("loyalty_canje_maximo",
    { p_customer_id: LOY.cliente.id, p_total: total });
  LOY.maxPuntos = (data && data.puntos) || 0;
  LOY.maxDescuento = (data && data.descuento) || 0;
  $("loy-redeem-hint").textContent = data && data.motivo
    ? data.motivo
    : `Puede canjear hasta ${LOY.maxPuntos} puntos (${money(LOY.maxDescuento)}) en esta venta.`;
  const pedido = parseInt($("loy-redeem").value, 10) || 0;
  if (pedido > LOY.maxPuntos) $("loy-redeem").value = String(LOY.maxPuntos);
}
$("loy-redeem").addEventListener("input", () => renderQuote());
$("btn-loy-max").addEventListener("click", () => {
  $("loy-redeem").value = String(LOY.maxPuntos || 0);
  renderQuote();
});

// Lo que se ve en el ticket ANTES de cobrar. Es una vista previa con las
// mismas reglas del servidor; la cifra que manda es la que devuelve
// process_sale, y es la que sale en el comprobante.
function previaFidelizacion(totalLista) {
  const cfg = reglasFidelizacion();
  if (!LOY.cliente || !cfg || !cfg.activo) return null;
  const pedido = navigator.onLine ? Math.max(0, parseInt($("loy-redeem").value, 10) || 0) : 0;
  const canje = Math.min(pedido, LOY.maxPuntos || 0, LOY.cliente.points_balance);
  const descuento = Math.min(r2(canje * Number(cfg.valor_punto)), totalLista);
  const pagado = r2(totalLista - descuento);
  // Un punto por cada dólar COMPLETO gastado, igual que en el servidor.
  const mpp = Number(cfg.monto_por_punto) || 0;
  const gana = (pagado >= Number(cfg.compra_minima) && mpp > 0) ? Math.floor(pagado / mpp) : 0;
  return { canje, descuento, pagado, gana };
}

function renderQuote() {
  const plan = buildPlan();
  const linesEl = $("ticket-lines"), totalsEl = $("ticket-totals"), alertsEl = $("ticket-alerts");
  if (!plan) {
    linesEl.innerHTML = '<p class="hint">Selecciona vaso y sabor para empezar.</p>';
    totalsEl.innerHTML = ""; alertsEl.innerHTML = "";
    pintarTotalCobro(null);
    return;
  }

  const result = computeSale(plan.args);
  const tareG = plan.hayTaza ? plan.cupWeightG : 0, iceG = plan.hayTaza ? plan.iceWeightG : 0;
  const toppingsG = r2(result.gross_weight_g - iceG - tareG);
  const manual = PESO.modo === "manual";

  // Costo, margen y sus avisos solo los ve la propietaria (lo pidió el dueño,
  // 2026-10-21; en ICG la caja tampoco los muestra). Es solo la pantalla: el
  // costo de cada línea igual viaja en la venta, porque así se registra.
  const verCosto = isOwner();
  linesEl.innerHTML = result.lines.map((l) => `
    <div class="ticket-line">
      <span class="tl-name">${l.item_type === "producto" && l.quantity !== 1 ? `${l.quantity} × ` : ""}${esc(l.name)}
        <span class="tl-meta">${[l.weight_g ? fmtWeightShort(l.weight_g) : "", verCosto ? `costo ${money(l.cost)}` : "", l.is_premium_surcharge ? "premium" : ""].filter(Boolean).join(" · ")}</span>
      </span>
      <span class="num">${money(l.price_contribution)}</span>
    </div>`).join("");

  // Sin taza (solo productos) no hay pesos que mostrar.
  const conPesos = plan.hayTaza || hayPesado() || orderRows.length > 0;
  totalsEl.innerHTML = (conPesos ? `
    <div><span>Peso del vaso (tara)</span><span class="num">${fmtWeightShort(tareG)}</span></div>
    <div><span>Peso del helado</span><span class="num">${fmtWeightShort(iceG)}</span></div>
    <div><span>Peso de toppings</span><span class="num">${fmtWeightShort(toppingsG)}</span></div>
    <div><span>Peso total</span><span class="num">${fmtWeight(result.gross_weight_g)}</span></div>
    <div><span>Origen del peso</span><span>${manual ? "A mano — requiere PIN" : (PESO.capturas.length ? "Báscula · fijo" : "Báscula")}</span></div>` : "") + `
    ${verCosto ? `<div><span>Costo real</span><span class="num">${money(result.total_cost)}</span></div>
    <div><span>Margen</span><span class="num">${money(result.margin)} (${result.margin_pct}%)</span></div>` : ""}
    <div class="tt-total"><span>Total</span><span class="num">${money(result.total_price)}</span></div>`;

  // El tope depende del total, así que se vuelve a preguntar cuando cambia,
  // con una pequeña espera para no golpear al servidor en cada tecla.
  if (LOY.cliente && navigator.onLine) {
    clearTimeout(canjeTimer);
    canjeTimer = setTimeout(() => consultarTopeCanje(result.total_price).then(() => {
      const p2 = previaFidelizacion(result.total_price);
      pintarPreviaPuntos(p2, result.total_price);
    }), 350);
  }
  pintarPreviaPuntos(previaFidelizacion(result.total_price), result.total_price);

  const alerts = verCosto ? [...result.alerts] : [];
  // Avisos de venta para la cajera (como el "Ofrezca agua o algo para
  // llevar" de ICG): los del producto que se tocó y, con la taza ya servida,
  // el recordatorio de ofrecer una bebida si todavía no lleva productos.
  const avisos = [...new Set(plan.productos.map((p) => (STATE.products.find((x) => x.id === p.id) || {}).upsell).filter(Boolean))];
  if (plan.hayTaza && !plan.productos.length && STATE.products.length) avisos.push("Ofrézcale agua o algo para llevar.");
  alertsEl.innerHTML = avisos.map((a) => `<div class="alert ok">${esc(a)}</div>`).join("") +
                       alerts.map((a) => `<div class="alert warn">${esc(a)}</div>`).join("");
}

// El total, grande junto al botón de cobrar: con el ticket largo, la línea de
// Total puede quedar fuera de la vista, y es lo que la cajera le dice al cliente.
function pintarTotalCobro(monto, etiqueta) {
  $("charge-total-label").textContent = etiqueta || "Total";
  $("charge-total").textContent = monto == null ? "—" : money(monto);
  $("card-amount").textContent = monto == null ? "—" : money(monto);
}

// Con tarjeta, la caja muestra el monto en grande para teclearlo en el
// datáfono y pide el número de autorización del voucher al cobrar.
function pintarTarjeta() {
  const tarjeta = $("sel-payment").value === "tarjeta";
  $("card-box").hidden = !tarjeta;
  if (!tarjeta) { $("inp-card-auth").value = ""; $("inp-card-last4").value = ""; }
}
$("sel-payment").addEventListener("change", pintarTarjeta);
$("inp-card-auth").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
$("inp-card-last4").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, ""); });

function pintarPreviaPuntos(p, totalLista) {
  const el = $("ticket-totals");
  el.querySelectorAll(".tt-discount, .tt-points, .tt-pay").forEach((n) => n.remove());
  pintarTotalCobro(p && p.descuento > 0 ? p.pagado : totalLista, p && p.descuento > 0 ? "A cobrar" : "Total");
  if (!p) return;
  if (p.descuento > 0) {
    el.insertAdjacentHTML("beforeend",
      `<div class="tt-discount"><span>Descuento por ${p.canje} ${p.canje === 1 ? "punto" : "puntos"}</span><span class="num">− ${money(p.descuento)}</span></div>` +
      `<div class="tt-total tt-pay"><span>A cobrar</span><span class="num">${money(p.pagado)}</span></div>`);
  }
  if (p.gana > 0) {
    el.insertAdjacentHTML("beforeend",
      `<div class="tt-points"><span>Gana con esta compra</span><span class="num">+${p.gana} ${p.gana === 1 ? "punto" : "puntos"}</span></div>`);
  }
}

$("btn-charge").addEventListener("click", () => chargeSale(false));

async function chargeSale(force) {
  const plan = buildPlan();
  if (!plan) { alert("El pedido está vacío: pesa la taza o toca un producto."); return; }
  const manual = PESO.modo === "manual";
  if (!manual) {
    const sinPesar = orderRows.filter((r) => r.pesadoG == null)
      .map((r) => (STATE.toppings.find((t) => t.id === r.toppingId) || {}).name || "topping");
    if (sinPesar.length) { alert(`Falta pesar: ${sinPesar.join(", ")}.\n\nPésalo o quítalo de la lista.`); return; }
  }
  const result = computeSale(plan.args);
  if (result.total_price <= 0) {
    alert(plan.productos.length ? "La venta está en cero: revisa el precio de los productos."
      : manual ? "La venta está en cero: teclea el peso del helado o de los toppings." : "La venta está en cero: pesa el helado.");
    return;
  }

  const warnings = [];
  if (plan.hayTaza) {
    if (plan.flavorRow.stock_grams < plan.iceWeightG) warnings.push(`Stock insuficiente de "${plan.flavorRow.name}".`);
    plan.toppings.forEach((t) => {
      const row = STATE.toppings.find((x) => x.id === t.id);
      if (row && row.stock_grams < t.weight_g) warnings.push(`Stock insuficiente de topping "${row.name}".`);
    });
    if (plan.cupRow.stock_qty < 1) warnings.push(`No hay vasos disponibles (${plan.cupRow.name}).`);
  }
  plan.productos.forEach((p) => {
    if (p.stock_qty != null && Number(p.stock_qty) < p.qty) warnings.push(`Quedan ${Number(p.stock_qty)} de "${p.name}".`);
  });
  if (warnings.length && !force) {
    if (!confirm(warnings.join("\n") + "\n\n¿Registrar la venta de todos modos?")) return;
  }

  // Tarjeta: sin número de autorización no se cobra. Es lo que amarra la
  // venta a su voucher; sin él, una venta en efectivo podría pasarse como
  // tarjeta y el efectivo no cuadraría con nada.
  let tarjeta = {};
  if ($("sel-payment").value === "tarjeta") {
    const aut = $("inp-card-auth").value.trim().toUpperCase();
    const ult = $("inp-card-last4").value.trim();
    if (!/^[A-Z0-9]{1,12}$/.test(aut)) {
      alert(`Cobra ${$("charge-total").textContent} en el datáfono y escribe aquí el número de autorización del voucher.`);
      $("inp-card-auth").focus();
      return;
    }
    if (ult && !/^[0-9]{4}$/.test(ult)) { alert("Los últimos dígitos de la tarjeta son 4 números (o déjalo vacío)."); $("inp-card-last4").focus(); return; }
    tarjeta = { card_auth_code: aut, card_last4: ult || null };
  }

  // De dónde salió el peso. El servidor lo revisa y clasifica la venta; lo
  // que se manda aquí es la evidencia, no la conclusión.
  let peso;
  const pesadoG = plan.hayTaza ? r2(plan.iceWeightG + plan.toppings.reduce((s, t) => s + t.weight_g, 0)) : 0;
  if (!manual) {
    peso = { weight_mode: "bascula", scale_gross_g: PESO.ultimoBruto, scale_log: PESO.capturas };
  } else if (pesadoG <= 0) {
    peso = { weight_mode: "manual" };
  } else if (!navigator.onLine) {
    if (!confirm("Sin internet no se puede validar el PIN de la gerente.\n\nLa venta se registra igual, pero queda marcada como \"peso a mano SIN autorizar\" y la gerente la verá en el reporte.\n\n¿Cobrar así?")) return;
    peso = { weight_mode: "manual_sin_conexion" };
  } else {
    const auth = await pedirAutorizacion(plan, pesadoG);
    if (!auth) return;
    peso = { weight_mode: "manual", weight_auth_id: auth.id };
  }

  const btn = $("btn-charge");
  btn.disabled = true;
  const payload = {
    location_id: STATE.activeLocationId,
    client_uuid: (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
    created_at: new Date().toISOString(),
    gross_weight_g: result.gross_weight_g,
    total_price: result.total_price, total_cost: result.total_cost,
    margin: result.margin, margin_pct: result.margin_pct,
    currency_code: plan.loc.currency_code,
    payment_method: $("sel-payment").value,
    customer_name: $("inp-customer-name").value || null,
    customer_tax_id: $("inp-customer-taxid").value || null,
    lines: result.lines,
    ...peso,
    ...tarjeta,
  };

  // Al servidor se le dice QUÉ cliente y CUÁNTOS PUNTOS quiere canjear. El
  // descuento en dinero lo calcula él: si viniera de aquí, cualquiera con la
  // consola abierta se regalaría el helado.
  if (LOY.cliente) {
    payload.customer_id = LOY.cliente.id;
    if (!payload.customer_name) payload.customer_name = LOY.cliente.full_name;
    const previa = previaFidelizacion(result.total_price);
    if (previa && previa.canje > 0 && navigator.onLine) payload.redeem_points = previa.canje;
  }

  let folio = null, offline = false, servidor = null;
  try {
    if (!navigator.onLine) throw new Error("offline");
    const { data, error } = await sb.rpc("process_sale", { payload });
    if (error) {
      // Un rechazo por puntos (saldo insuficiente, tope) no es un problema de
      // red: la venta NO entró. Se avisa y no se manda a la cola, porque
      // reintentarla daría el mismo rechazo una y otra vez.
      if (payload.redeem_points && /punto|canje/i.test(error.message || "")) {
        btn.disabled = false;
        alert(`No se pudo canjear: ${error.message}\n\nQuita el canje o ajústalo y vuelve a cobrar.`);
        return;
      }
      throw error;
    }
    folio = data && data.folio;
    servidor = data;
  } catch (e) {
    // La venta ya ocurrió físicamente: el cliente pagó y se llevó su helado.
    // Así que nunca la perdemos — se guarda aquí y se envía sola al volver la red.
    offline = true;
    lastSyncFailed = true;
    queueSale(payload);
  }

  showReceipt(payload, result, folio, offline, servidor);
  discountLocalStock(plan, result);
  if (LOY.cliente) quitarCliente();

  $("inp-customer-name").value = "";
  $("inp-customer-taxid").value = "";
  limpiarPedido();
  btn.disabled = false;

  if (!offline) await loadData();
}

// Descuenta del catálogo que tenemos en memoria/caché, para que el inventario
// que ve la cajera siga siendo correcto aunque no haya internet.
function discountLocalStock(plan, result) {
  result.lines.forEach((l) => {
    if (l.item_type === "helado") {
      const f = STATE.flavors.find((x) => x.id === l.ref_id);
      if (f) f.stock_grams = r2(f.stock_grams - l.weight_g);
    } else if (l.item_type === "topping") {
      const t = STATE.toppings.find((x) => x.id === l.ref_id);
      if (t) t.stock_grams = r2(t.stock_grams - l.weight_g);
    } else if (l.item_type === "vaso" || l.item_type === "cuchara") {
      const s = STATE.supplies.find((x) => x.id === l.ref_id);
      if (s) s.stock_qty = s.stock_qty - 1;
    }
  });
  cacheCatalog();
}

function showReceipt(payload, result, folio, offline, servidor) {
  const loc = activeLocation();
  const TAX = { GT: { doc: "Factura Electrónica en Línea (FEL)", id: "NIT" },
                SV: { doc: "Documento Tributario Electrónico (DTE)", id: "NIT/DUI" },
                HN: { doc: "Factura (CAI / Factura Electrónica SAR)", id: "RTN" } };
  const t = TAX[loc.country_code] || TAX.HN;
  const items = result.lines
    .filter((l) => !(l.item_type === "cuchara" && l.price_contribution === 0))
    .map((l) => `${l.item_type === "producto" ? `${l.quantity} × ` : ""}${esc(l.name)}${l.weight_g ? "  " + fmtWeightShort(l.weight_g) : ""}   ${money(l.price_contribution)}`)
    .join("\n");

  const logoSrc = logoSeguro(loc.logo_data_url);
  const logo = logoSrc ? `<div class="doc-logo"><img src="${esc(logoSrc)}" alt=""></div>` : "";
  $("receipt-body").innerHTML = logo + `<div class="ticket" style="white-space:pre-wrap;">
${esc(loc.legal_name || loc.name)}
${esc(loc.name)}
${t.id}: ${esc(loc.tax_id_value || "(pendiente de registrar)")}
${esc(loc.address || "")}
------------------------------
${t.doc}
Comprobante interno #${folio || "(pendiente)"}
Fecha: ${new Date(payload.created_at).toLocaleString()}
Cliente: ${esc(payload.customer_name || "Consumidor Final")}
Pago: ${esc(PAGO_LABELS[payload.payment_method] || payload.payment_method || "")}${payload.card_auth_code ? ` · Aut. ${esc(payload.card_auth_code)}` : ""}${payload.card_last4 ? ` · ****${esc(payload.card_last4)}` : ""}
------------------------------
${items}
------------------------------
PESO TOTAL: ${fmtWeight(result.gross_weight_g)}
${bloquePuntosRecibo(payload, result, servidor, offline)}------------------------------
NO ES UNA FACTURA FISCAL VÁLIDA — pendiente de
conexión con proveedor certificado.
${offline ? "\n** Registrada sin conexión — se enviará al\n   servidor cuando vuelva el internet. **" : ""}
</div>`;
  $("receipt-modal").hidden = false;
}
// Las cifras de puntos del comprobante son las que devolvió el servidor, no
// la vista previa: es lo que quedó registrado.
function bloquePuntosRecibo(payload, result, servidor, offline) {
  if (!payload.customer_id) return `TOTAL: ${money(result.total_price)}\n`;
  if (offline || !servidor) {
    return `TOTAL: ${money(result.total_price)}\n` +
           `Cliente frecuente: los puntos de esta compra\nse suman al sincronizar.\n`;
  }
  let t = "";
  if (Number(servidor.discount) > 0) {
    t += `Subtotal: ${money(result.total_price)}\n`;
    t += `Canje ${servidor.points_redeemed} pts: -${money(servidor.discount)}\n`;
  }
  t += `TOTAL: ${money(servidor.total != null ? servidor.total : result.total_price)}\n`;
  if (Number(servidor.points_earned) > 0) t += `Puntos ganados: +${servidor.points_earned}\n`;
  return t;
}

$("btn-close-receipt").addEventListener("click", () => { $("receipt-modal").hidden = true; });
$("btn-print-receipt").addEventListener("click", () => window.print());

/* ===========================================================================
   9. INVENTARIO (gerente y propietario)
   =========================================================================== */
function renderInventory() {
  const fBody = document.querySelector("#table-flavors tbody");
  fBody.innerHTML = "";
  STATE.flavors.forEach((f) => {
    const tr = document.createElement("tr");
    if (Number(f.stock_grams) <= Number(f.min_stock_grams)) tr.classList.add("low-stock");
    tr.innerHTML = `<td>${esc(f.name)}</td>
      <td><input type="number" step="0.001" value="${f.cost_per_gram}" data-field="cost_per_gram"></td>
      <td><input type="number" step="0.01" value="${f.stock_grams}" data-field="stock_grams"></td>
      <td><input type="number" step="0.01" value="${f.min_stock_grams}" data-field="min_stock_grams"></td>
      <td>${rowActionsHtml()}</td>`;
    tr.querySelector(".btn-save").addEventListener("click", async () => {
      const patch = {};
      tr.querySelectorAll("[data-field]").forEach((i) => (patch[i.dataset.field] = parseFloat(i.value) || 0));
      await saveRow("flavors", f.id, patch);
    });
    tr.querySelector(".btn-del").addEventListener("click", async () => {
      if (confirm(`¿Eliminar "${f.name}"?`)) await saveRow("flavors", f.id, { active: false });
    });
    fBody.appendChild(tr);
  });

  const sBody = document.querySelector("#table-supplies tbody");
  sBody.innerHTML = "";
  STATE.supplies.forEach((s) => {
    const tr = document.createElement("tr");
    if (Number(s.stock_qty) <= Number(s.min_stock_qty)) tr.classList.add("low-stock");
    tr.innerHTML = `<td>${esc(s.name)}</td><td>${esc(s.kind)}</td>
      <td><input type="number" step="0.1" value="${s.tare_weight_g}" data-field="tare_weight_g"></td>
      <td><input type="number" step="0.01" value="${s.cost_per_unit}" data-field="cost_per_unit"></td>
      <td><input type="number" value="${s.stock_qty}" data-field="stock_qty"></td>
      <td><input type="number" value="${s.min_stock_qty}" data-field="min_stock_qty"></td>
      <td>${rowActionsHtml()}</td>`;
    tr.querySelector(".btn-save").addEventListener("click", async () => {
      const patch = {};
      tr.querySelectorAll("[data-field]").forEach((i) => (patch[i.dataset.field] = parseFloat(i.value) || 0));
      await saveRow("supplies", s.id, patch);
    });
    tr.querySelector(".btn-del").addEventListener("click", async () => {
      if (confirm(`¿Eliminar "${s.name}"?`)) await saveRow("supplies", s.id, { active: false });
    });
    sBody.appendChild(tr);
  });
}

function renderProductsTable() {
  const body = document.querySelector("#table-products tbody");
  if (!body) return;
  body.innerHTML = STATE.products.length ? "" : '<tr><td colspan="7" class="hint">Todavía no hay productos de precio fijo.</td></tr>';
  STATE.products.forEach((p) => {
    const tr = document.createElement("tr");
    if (p.stock_qty != null && Number(p.stock_qty) <= 0) tr.classList.add("low-stock");
    tr.innerHTML = `<td><input data-f="family" maxlength="40" value="${esc(p.family)}"></td>
      <td><input data-f="name" maxlength="80" value="${esc(p.name)}"></td>
      <td><input data-f="price" type="number" step="0.01" min="0" value="${esc(p.price)}"></td>
      <td><input data-f="cost" type="number" step="0.01" min="0" value="${esc(p.cost)}"></td>
      <td><input data-f="stock_qty" type="number" step="1" value="${p.stock_qty == null ? "" : esc(p.stock_qty)}" placeholder="—"></td>
      <td><input data-f="upsell" maxlength="160" value="${esc(p.upsell || "")}"></td>
      <td>${rowActionsHtml()}</td>`;
    const v = (f) => tr.querySelector(`[data-f="${f}"]`).value;
    tr.querySelector(".btn-save").addEventListener("click", async () => {
      if (!v("family").trim() || !v("name").trim()) { alert("Familia y nombre no pueden quedar vacíos."); return; }
      await saveRow("products", p.id, {
        family: v("family").trim(), name: v("name").trim(),
        price: parseFloat(v("price")) || 0, cost: parseFloat(v("cost")) || 0,
        stock_qty: v("stock_qty") === "" ? null : parseFloat(v("stock_qty")),
        upsell: v("upsell").trim() || null,
      });
    });
    tr.querySelector(".btn-del").addEventListener("click", async () => {
      if (confirm(`¿Quitar "${p.name}" de la venta?`)) await saveRow("products", p.id, { active: false });
    });
    body.appendChild(tr);
  });
  $("np-families").innerHTML = [...new Set(STATE.products.map((p) => p.family))].map((f) => `<option value="${esc(f)}">`).join("");
}

$("btn-add-product").addEventListener("click", async () => {
  const family = $("np-family").value.trim(), name = $("np-name").value.trim();
  const price = parseFloat($("np-price").value);
  if (!family || !name) { alert("Ponle familia y nombre al producto."); return; }
  if (!(price >= 0)) { alert("Pon el precio que paga el cliente (con ISV)."); return; }
  const stock = $("np-stock").value;
  const ok = await insertRow("products", {
    family, name, price, cost: parseFloat($("np-cost").value) || 0,
    stock_qty: stock === "" ? null : parseFloat(stock), upsell: $("np-upsell").value.trim() || null,
  });
  if (ok) ["np-name", "np-price", "np-cost", "np-stock", "np-upsell"].forEach((id) => ($(id).value = ""));
});

async function saveRow(table, id, patch) {
  if (!navigator.onLine) { alert("Sin conexión: los cambios de inventario y precios necesitan internet. La pantalla de venta sí sigue funcionando."); return; }
  const { error } = await sb.from(table).update(patch).eq("id", id);
  if (error) { alert(`No se pudo guardar: ${error.message}`); return; }
  await loadData();
}

async function insertRow(table, row) {
  if (!navigator.onLine) { alert("Sin conexión: para agregar productos necesitas internet."); return false; }
  const { error } = await sb.from(table).insert({ ...row, location_id: STATE.activeLocationId });
  if (error) { alert(`No se pudo agregar: ${error.message}`); return false; }
  await loadData();
  return true;
}

$("btn-add-flavor").addEventListener("click", async () => {
  const name = $("nf-name").value.trim();
  if (!name) { alert("Ponle nombre al sabor."); return; }
  const ok = await insertRow("flavors", {
    name, cost_per_gram: parseFloat($("nf-cost").value) || 0,
    stock_grams: parseFloat($("nf-stock").value) || 0, min_stock_grams: 0,
  });
  if (ok) ["nf-name", "nf-cost", "nf-stock"].forEach((id) => ($(id).value = ""));
});

$("btn-add-supply").addEventListener("click", async () => {
  const name = $("ns-name").value.trim();
  if (!name) { alert("Ponle nombre al insumo."); return; }
  const ok = await insertRow("supplies", {
    name, kind: $("ns-kind").value,
    tare_weight_g: parseFloat($("ns-tare").value) || 0,
    cost_per_unit: parseFloat($("ns-cost").value) || 0,
    stock_qty: parseInt($("ns-stock").value, 10) || 0, min_stock_qty: 0,
  });
  if (ok) ["ns-name", "ns-tare", "ns-cost", "ns-stock"].forEach((id) => ($(id).value = ""));
});

/* ===========================================================================
   10. TOPPINGS
   =========================================================================== */
function renderToppingsTable() {
  const body = document.querySelector("#table-toppings tbody");
  body.innerHTML = "";
  STATE.toppings.forEach((t) => {
    const tr = document.createElement("tr");
    if (Number(t.stock_grams) <= Number(t.min_stock_grams)) tr.classList.add("low-stock");
    tr.innerHTML = `<td>${esc(t.name)}</td><td>${esc(t.category)}</td>
      <td><input type="number" step="0.001" value="${t.cost_per_gram}" data-field="cost_per_gram"></td>
      <td><select data-field="tier"><option value="1"${t.tier === 1 ? " selected" : ""}>1</option><option value="2"${t.tier === 2 ? " selected" : ""}>2</option></select></td>
      <td><input type="number" step="0.001" value="${t.surcharge_per_gram}" data-field="surcharge_per_gram"></td>
      <td><input type="number" step="0.01" value="${t.stock_grams}" data-field="stock_grams"></td>
      <td><input type="number" step="0.01" value="${t.min_stock_grams}" data-field="min_stock_grams"></td>
      <td>${rowActionsHtml()}</td>`;
    tr.querySelector(".btn-save").addEventListener("click", async () => {
      const patch = {};
      tr.querySelectorAll("[data-field]").forEach((i) => {
        patch[i.dataset.field] = i.dataset.field === "tier" ? parseInt(i.value, 10) : (parseFloat(i.value) || 0);
      });
      await saveRow("toppings", t.id, patch);
    });
    tr.querySelector(".btn-del").addEventListener("click", async () => {
      if (confirm(`¿Eliminar "${t.name}"?`)) await saveRow("toppings", t.id, { active: false });
    });
    body.appendChild(tr);
  });
}

$("btn-add-topping").addEventListener("click", async () => {
  const name = $("nt-name").value.trim();
  if (!name) { alert("Ponle nombre al topping."); return; }
  const loc = activeLocation();
  const cost = parseFloat($("nt-cost").value) || 0;
  const s = suggestToppingTier(cost, Number(loc.price_per_gram), Number(loc.margin_target_pct));
  const ok = await insertRow("toppings", {
    name, category: $("nt-cat").value, cost_per_gram: cost,
    tier: s.tier, surcharge_per_gram: s.surcharge,
    stock_grams: parseFloat($("nt-stock").value) || 0, min_stock_grams: 0,
  });
  if (ok) {
    $("tier-suggestion").textContent = `"${name}" se agregó como tier ${s.tier}. ${s.reason}`;
    ["nt-name", "nt-cost", "nt-stock"].forEach((id) => ($(id).value = ""));
  }
});

$("btn-suggest-tiers").addEventListener("click", async () => {
  const loc = activeLocation();
  const cambios = [];
  for (const t of STATE.toppings) {
    const s = suggestToppingTier(Number(t.cost_per_gram), Number(loc.price_per_gram), Number(loc.margin_target_pct));
    if (s.tier !== t.tier || Math.abs(s.surcharge - Number(t.surcharge_per_gram)) > 0.0005) {
      cambios.push({ t, s });
    }
  }
  if (!cambios.length) { $("tier-suggestion").textContent = "Todos los toppings ya están bien configurados para tu meta de margen."; return; }
  const detalle = cambios.map((c) => `· ${c.t.name}: tier ${c.t.tier} → ${c.s.tier}, recargo ${c.s.surcharge}/g`).join("\n");
  if (!confirm(`Se sugieren estos cambios para alcanzar tu margen meta:\n\n${detalle}\n\n¿Aplicarlos?`)) return;
  for (const c of cambios) {
    await sb.from("toppings").update({ tier: c.s.tier, surcharge_per_gram: c.s.surcharge }).eq("id", c.t.id);
  }
  $("tier-suggestion").textContent = `Se actualizaron ${cambios.length} topping(s).`;
  await loadData();
});

/* ===========================================================================
   11. REPORTES Y CIERRE DEL DÍA
   =========================================================================== */
function fillReportLocationPicker() {
  const sel = $("sel-report-location");
  const keep = sel.value;
  sel.innerHTML = '<option value="__all__">Todas las sucursales (consolidado)</option>';
  STATE.locations.forEach((l) => {
    const o = document.createElement("option");
    o.value = l.id; o.textContent = l.name;
    sel.appendChild(o);
  });
  sel.value = keep || STATE.activeLocationId;
}

$("sel-report-location").addEventListener("change", () => { renderReports(); renderClosing(); cargarControlPesos(); });

function reportScopeId() {
  if (!isOwner()) return STATE.activeLocationId;
  const v = $("sel-report-location").value;
  return v === "__all__" ? null : v;
}

function scopedSales() {
  const scope = reportScopeId();
  return scope ? STATE.sales.filter((s) => s.location_id === scope) : STATE.sales;
}

// Sumar lempiras con quetzales no significa nada. Si el consolidado mezcla
// monedas (por ejemplo al abrir una sucursal en Guatemala), lo advertimos en
// vez de mostrar un total falso.
function mixedCurrencyWarning() {
  if (reportScopeId()) return "";
  const monedas = [...new Set(STATE.locations.filter((l) => l.active).map((l) => l.currency_code))];
  if (monedas.length <= 1) return "";
  return `<div class="alert warn">Las sucursales manejan monedas distintas (${esc(monedas.join(", "))}). Los totales en dinero del consolidado no son comparables: revisa cada sucursal por separado. Los pesos y las cantidades sí se pueden sumar.</div>`;
}

function renderReports() {
  const sales = scopedSales();
  const sum = sales.reduce((a, s) => ({
    n: a.n + 1,
    ing: a.ing + Number(s.total_price || 0),
    cos: a.cos + Number(s.total_cost || 0),
    mar: a.mar + Number(s.margin || 0),
  }), { n: 0, ing: 0, cos: 0, mar: 0 });
  const pct = sum.ing > 0 ? r2((100 * sum.mar) / sum.ing) : 0;

  $("report-summary").innerHTML = mixedCurrencyWarning() + `
    <div class="kpi"><div class="kpi-label"># de ventas</div><div class="kpi-value num">${sum.n}</div></div>
    <div class="kpi"><div class="kpi-label">Ingresos</div><div class="kpi-value num">${money(sum.ing)}</div></div>
    <div class="kpi"><div class="kpi-label">Costos</div><div class="kpi-value num">${money(sum.cos)}</div></div>
    <div class="kpi"><div class="kpi-label">Margen</div><div class="kpi-value num">${money(sum.mar)} (${pct}%)</div></div>`;

  const salesBody = document.querySelector("#table-sales tbody");
  const recent = sales.slice(0, 30);
  salesBody.innerHTML = recent.length ? "" : '<tr><td colspan="6" class="hint">Todavía no hay ventas registradas.</td></tr>';
  recent.forEach((s) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${s.created_at ? new Date(s.created_at).toLocaleString() : ""}</td>
      <td>${esc((s.locations && s.locations.name) || "")}</td>
      <td>${esc(s.cashier_name || "")}</td>
      <td class="num">${fmtWeightShort(s.gross_weight_g)}</td>
      <td class="num">${money(s.total_price)}</td>
      <td class="num">${money(s.margin)} (${r2(s.margin_pct)}%)</td>`;
    salesBody.appendChild(tr);
  });

  renderToppingMargins(sales);
}

async function renderToppingMargins(sales) {
  const marginsBody = document.querySelector("#table-margins tbody");
  const ids = sales.map((s) => s.id);
  if (!ids.length || !navigator.onLine) {
    marginsBody.innerHTML = '<tr><td colspan="6" class="hint">Sin datos suficientes todavía.</td></tr>';
    return;
  }
  const { data: lines } = await sb.from("sale_lines")
    .select("name, weight_g, cost, price_contribution")
    .eq("item_type", "topping").in("sale_id", ids.slice(0, 200));

  const by = {};
  (lines || []).forEach((l) => {
    by[l.name] = by[l.name] || { name: l.name, peso: 0, costo: 0, precio: 0 };
    by[l.name].peso += Number(l.weight_g);
    by[l.name].costo += Number(l.cost);
    by[l.name].precio += Number(l.price_contribution);
  });
  const rows = Object.values(by)
    .map((r) => ({ ...r, margen: r.precio - r.costo, pct: r.precio > 0 ? r2((100 * (r.precio - r.costo)) / r.precio) : 0 }))
    .sort((a, b) => a.margen - b.margen);

  marginsBody.innerHTML = rows.length ? "" : '<tr><td colspan="6" class="hint">Todavía no hay ventas con toppings.</td></tr>';
  const loc = activeLocation();
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    if (loc && r.pct < Number(loc.margin_target_pct)) tr.classList.add("low-stock");
    tr.innerHTML = `<td>${esc(r.name)}</td><td class="num">${fmtWeightShort(r.peso)}</td><td class="num">${money(r.costo)}</td>
      <td class="num">${money(r.precio)}</td><td class="num">${money(r.margen)}</td><td class="num">${r.pct}%</td>`;
    marginsBody.appendChild(tr);
  });
}

/* --- Cierre del día -------------------------------------------------------- */
let lastClosing = null;

$("closing-date").addEventListener("change", renderClosing);

async function renderClosing() {
  const dateInput = $("closing-date");
  if (!dateInput.value) dateInput.value = localDateStr();
  const scope = reportScopeId();

  // El consolidado del propietario suma el cierre de cada sucursal, pero
  // además le deja ver el detalle tienda por tienda (eso pediste: reporte
  // por tienda, no solo el total).
  const targets = scope ? [scope] : STATE.locations.map((l) => l.id);
  const results = [];
  for (const locId of targets) {
    if (!navigator.onLine) break;
    const { data, error } = await sb.rpc("daily_closing", {
      p_location_id: locId,
      p_day: dateInput.value,
      p_utc_offset_hours: CFG.UTC_OFFSET_HOURS ?? -6,
    });
    if (!error && data) {
      results.push({ ...data, locationName: (STATE.locations.find((l) => l.id === locId) || {}).name || "" });
    }
  }
  lastClosing = { day: dateInput.value, results };

  const totals = results.reduce((a, c) => ({
    ventas: a.ventas + Number(c.ventas || 0),
    vasos: a.vasos + Number(c.vasos || 0),
    cucharas: a.cucharas + Number(c.cucharas || 0),
    helado: a.helado + Number(c.peso_helado_g || 0),
    toppings: a.toppings + Number(c.peso_toppings_g || 0),
    ingresos: a.ingresos + Number(c.ingresos || 0),
  }), { ventas: 0, vasos: 0, cucharas: 0, helado: 0, toppings: 0, ingresos: 0 });

  const scopeName = scope
    ? (STATE.locations.find((l) => l.id === scope) || {}).name || ""
    : "Todas las sucursales";
  $("closing-print-head").innerHTML = logoHtml() + `<strong>${esc(scopeName)}</strong> — Cierre del día ${dateInput.value}`;

  $("closing-summary").innerHTML = mixedCurrencyWarning() + `
    <div class="kpi"><div class="kpi-label">Vasos vendidos</div><div class="kpi-value num">${totals.vasos}</div></div>
    <div class="kpi"><div class="kpi-label">Cucharas vendidas</div><div class="kpi-value num">${totals.cucharas}</div></div>
    <div class="kpi"><div class="kpi-label">Peso de helado vendido</div><div class="kpi-value num">${fmtWeightShort(totals.helado)}</div><div class="hint">${prefUnit() === "oz" ? r2(totals.helado) + " g" : r2(toOz(totals.helado)) + " oz"}</div></div>
    <div class="kpi"><div class="kpi-label">Peso de toppings vendido</div><div class="kpi-value num">${fmtWeightShort(totals.toppings)}</div><div class="hint">${prefUnit() === "oz" ? r2(totals.toppings) + " g" : r2(toOz(totals.toppings)) + " oz"}</div></div>
    <div class="kpi"><div class="kpi-label">Ventas</div><div class="kpi-value num">${totals.ventas}</div></div>
    <div class="kpi"><div class="kpi-label">Ingresos</div><div class="kpi-value num">${money(totals.ingresos)}</div></div>`;

  // Cuadre por forma de pago, sumando las tiendas si es consolidado.
  const pagos = {};
  let descuentos = 0, anulaciones = 0, anuladoG = 0;
  results.forEach((c) => {
    (c.por_pago || []).forEach((p) => {
      const x = pagos[p.metodo] || (pagos[p.metodo] = { ventas: 0, total: 0 });
      x.ventas += Number(p.ventas || 0); x.total += Number(p.total || 0);
    });
    descuentos += Number(c.descuentos || 0);
    anulaciones += Number(c.anulaciones || 0); anuladoG += Number(c.anulado_g || 0);
  });
  const orden = { efectivo: 1, tarjeta: 2, transferencia: 3 };
  const payBody = document.querySelector("#table-closing-pay tbody");
  const metodos = Object.entries(pagos).sort((a, b) => (orden[a[0]] || 9) - (orden[b[0]] || 9));
  payBody.innerHTML = metodos.length ? "" : '<tr><td colspan="3" class="hint">No hay ventas ese día.</td></tr>';
  metodos.forEach(([m, x]) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(PAGO_LABELS[m] || m)}</td><td class="num">${x.ventas}</td><td class="num">${money(r2(x.total))}</td>`;
    payBody.appendChild(tr);
  });
  if (metodos.length) {
    const tr = document.createElement("tr"); tr.className = "row-total";
    tr.innerHTML = `<td><strong>Total</strong></td><td class="num"><strong>${totals.ventas}</strong></td><td class="num"><strong>${money(r2(totals.ingresos))}</strong></td>`;
    payBody.appendChild(tr);
  }
  const notas = [];
  if (descuentos > 0) notas.push(`Descuentos por canje de puntos: ${money(r2(descuentos))} (ya restados de los totales).`);
  notas.push(anulaciones
    ? `Pedidos anulados: ${anulaciones} (${fmtWeightShort(anuladoG)} pesados). El detalle está en Control de pesos.`
    : "Pedidos anulados: ninguno.");
  $("closing-pay-note").textContent = notas.join(" ");

  // Vouchers del día. Un número repetido o una venta sin número se marcan:
  // son justo lo que hay que revisar contra el cierre de lote del datáfono.
  const vouchers = [];
  results.forEach((c) => (c.vouchers || []).forEach((v) => vouchers.push({ ...v, tienda: results.length > 1 ? c.locationName : "" })));
  vouchers.sort((a, b) => String(a.hora).localeCompare(String(b.hora)));
  const vecesAut = {};
  vouchers.forEach((v) => { if (v.autorizacion) vecesAut[v.autorizacion] = (vecesAut[v.autorizacion] || 0) + 1; });
  const vBody = document.querySelector("#table-closing-vouchers tbody");
  vBody.innerHTML = vouchers.length ? "" : '<tr><td colspan="5" class="hint">No hubo ventas con tarjeta ese día.</td></tr>';
  vouchers.forEach((v) => {
    const tr = document.createElement("tr");
    const malo = !v.autorizacion || vecesAut[v.autorizacion] > 1;
    if (malo) tr.className = "row-bad";
    tr.innerHTML = `<td>${esc(new Date(v.hora).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}${v.tienda ? ` · ${esc(v.tienda)}` : ""}</td>
      <td class="num">${esc(v.folio)}</td>
      <td>${v.autorizacion ? esc(v.autorizacion) + (vecesAut[v.autorizacion] > 1 ? " (repetida)" : "") : "SIN AUTORIZACIÓN"}</td>
      <td>${v.ultimos4 ? "****" + esc(v.ultimos4) : "—"}</td>
      <td class="num">${money(v.total)}</td>`;
    vBody.appendChild(tr);
  });

  // Tabla de toppings: si es consolidado, se juntan las tiendas y se recalcula el %.
  const agg = {};
  results.forEach((c) => (c.toppings || []).forEach((t) => {
    agg[t.name] = (agg[t.name] || 0) + Number(t.peso_g || 0);
  }));
  const totalTop = Object.values(agg).reduce((a, b) => a + b, 0);
  const rows = Object.entries(agg)
    .map(([name, peso]) => ({ name, peso, pct: totalTop > 0 ? r2((100 * peso) / totalTop) : 0 }))
    .sort((a, b) => b.peso - a.peso);

  const body = document.querySelector("#table-closing-toppings tbody");
  body.innerHTML = rows.length ? "" : '<tr><td colspan="3" class="hint">No hay ventas con toppings ese día.</td></tr>';
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(r.name)}</td><td class="num">${fmtWeightShort(r.peso)}</td><td class="num">${r.pct}%</td>`;
    body.appendChild(tr);
  });

  const loc = activeLocation();
  $("closing-email-hint").textContent = loc && loc.report_email
    ? `Se enviará a ${loc.report_email} (cámbialo en Configuración → Reporte de cierre).`
    : "No has configurado un correo para el cierre; puedes ponerlo en Configuración, o escribirlo al abrirse tu programa de correo.";
}

function closingReportText() {
  if (!lastClosing) return "";
  const L = [];
  L.push(`Cierre del día — ${lastClosing.day}`);
  L.push("");
  lastClosing.results.forEach((c) => {
    L.push(`SUCURSAL: ${c.locationName}`);
    L.push(`  Ventas registradas: ${c.ventas}`);
    L.push(`  Vasos vendidos: ${c.vasos}`);
    L.push(`  Cucharas vendidas: ${c.cucharas}`);
    L.push(`  Peso de helado vendido: ${fmtWeight(c.peso_helado_g)}`);
    L.push(`  Peso de toppings vendido: ${fmtWeight(c.peso_toppings_g)}`);
    L.push(`  Ingresos: ${c.ingresos}`);
    L.push("  Por forma de pago:");
    if (!(c.por_pago || []).length) L.push("    (sin ventas)");
    else c.por_pago.forEach((p) => L.push(`    - ${PAGO_LABELS[p.metodo] || p.metodo}: ${p.total} (${p.ventas} venta${p.ventas === 1 ? "" : "s"})`));
    if (Number(c.descuentos) > 0) L.push(`  Descuentos por puntos: ${c.descuentos}`);
    L.push(`  Pedidos anulados: ${c.anulaciones || 0}${Number(c.anulado_g) > 0 ? ` (${fmtWeightShort(c.anulado_g)})` : ""}`);
    L.push("  Toppings vendidos:");
    if (!(c.toppings || []).length) L.push("    (sin ventas de toppings)");
    else (c.toppings || []).forEach((t) => L.push(`    - ${t.name}: ${fmtWeightShort(t.peso_g)} (${t.pct}%)`));
    L.push("");
  });
  return L.join("\n");
}

$("btn-print-closing").addEventListener("click", () => window.print());
$("btn-email-closing").addEventListener("click", () => {
  const loc = activeLocation();
  const to = (loc && loc.report_email) || "";
  const subject = encodeURIComponent(`Cierre del día ${lastClosing ? lastClosing.day : ""} — Tuti's`);
  const body = encodeURIComponent(closingReportText());
  window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
});

/* ===========================================================================
   12. CONFIGURACIÓN DE LA SUCURSAL
   =========================================================================== */
const TAX_LABELS = { GT: "NIT", SV: "NIT / DUI", HN: "RTN" };

function fillConfigForm() {
  const c = activeLocation();
  if (!c) return;
  if (document.activeElement && document.activeElement.closest("#tab-config")) return;
  $("config-location-name").textContent = `Estás editando: ${c.name}`;
  $("cfg-name").value = c.name || "";
  $("cfg-legal-name").value = c.legal_name || "";
  $("cfg-country").value = c.country_code || "HN";
  $("cfg-currency").value = c.currency_code || "";
  $("cfg-taxid-label").textContent = TAX_LABELS[c.country_code] || "NIT";
  $("cfg-taxid").value = c.tax_id_value || "";
  $("cfg-purchase-series").value = c.purchase_series || "";
  $("cfg-address").value = c.address || "";
  $("cfg-price-gram").value = c.price_per_gram;
  $("cfg-price-oz-hint").textContent = `≈ ${r2(Number(c.price_per_gram) * OZ_TO_G)} por onza`;
  $("cfg-include-cup").checked = !!c.include_cup_weight_in_price;
  $("cfg-margin-target").value = c.margin_target_pct;
  $("cfg-report-email").value = c.report_email || "";
  $("cfg-weight-unit").value = c.default_weight_unit || "g";
  actualizarPistaUnidad();
  pintarLogo(c.logo_data_url);
  $("cfg-invoice-status").textContent =
    "Mientras no se conecte un proveedor certificado (FEL en Guatemala, DTE en El Salvador, SAR en Honduras), cada venta genera un comprobante interno con todos los campos legales listos, claramente marcado como no fiscal.";
}

const LOGO_MAX_PX = 480;          // suficiente para imprimir sin pesar
const LOGO_MAX_CHARS = 300000;    // el mismo tope que impone la base

function actualizarPistaUnidad() {
  const u = $("cfg-weight-unit").value;
  const precio = parseFloat($("cfg-price-gram").value) || 0;
  $("cfg-unit-hint").textContent = u === "oz"
    ? `Los pesos se mostrarán en onzas (con los gramos entre paréntesis). El precio quedará como ${r2(precio * OZ_TO_G)} por onza.`
    : "Los pesos se mostrarán en gramos (con las onzas entre paréntesis).";
}
$("cfg-weight-unit").addEventListener("change", actualizarPistaUnidad);
$("cfg-price-gram").addEventListener("input", () => {
  $("cfg-price-oz-hint").textContent = `≈ ${r2((parseFloat($("cfg-price-gram").value) || 0) * OZ_TO_G)} por onza`;
  actualizarPistaUnidad();
});

// El logo que encabeza un reporte impreso. Cuando el propietario mira el
// consolidado no hay "una" tienda, así que se usa el de la que tiene abierta.
function logoHtml() {
  const loc = activeLocation();
  const src = loc && logoSeguro(loc.logo_data_url);
  return src ? `<div class="doc-logo"><img src="${esc(src)}" alt=""></div>` : "";
}

// El logo llega de la base y termina en el src de una imagen. esc() ya impide
// que se salga del atributo, pero además exigimos que sea de verdad una
// imagen incrustada: así ni un valor escrito directo contra la API puede
// convertir ese src en otra cosa.
function logoSeguro(v) {
  return (typeof v === "string" && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v))
    ? v : null;
}

function pintarLogo(dataUrl) {
  const box = $("cfg-logo-preview");
  const src = logoSeguro(dataUrl);
  if (src) {
    box.innerHTML = `<img src="${esc(src)}" alt="Logo de la tienda">`;
    $("btn-remove-logo").hidden = false;
  } else {
    box.innerHTML = '<span class="hint">Sin logo</span>';
    $("btn-remove-logo").hidden = true;
  }
}

// Reduce la imagen antes de guardarla. Sin esto, una foto del celular de 4 MB
// se guardaría entera en la fila de la sucursal, y esa fila es lo primero que
// pide la caja al abrir: volvería lento justo el arranque.
function reducirImagen(file) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onerror = () => reject(new Error("No se pudo leer el archivo."));
    lector.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Ese archivo no parece una imagen válida."));
      img.onload = () => {
        const escala = Math.min(1, LOGO_MAX_PX / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * escala));
        const h = Math.max(1, Math.round(img.height * escala));
        const lienzo = document.createElement("canvas");
        lienzo.width = w; lienzo.height = h;
        lienzo.getContext("2d").drawImage(img, 0, 0, w, h);
        // PNG conserva la transparencia, que es lo que se quiere para un logo
        // sobre papel. Si sale muy pesado, se reintenta en JPEG con fondo.
        let out = lienzo.toDataURL("image/png");
        if (out.length > LOGO_MAX_CHARS) {
          const ctx = lienzo.getContext("2d");
          ctx.globalCompositeOperation = "destination-over";
          ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, w, h);
          out = lienzo.toDataURL("image/jpeg", 0.82);
        }
        if (out.length > LOGO_MAX_CHARS) {
          reject(new Error("Esa imagen es demasiado pesada aun después de reducirla. Usa una más sencilla."));
          return;
        }
        resolve(out);
      };
      img.src = lector.result;
    };
    lector.readAsDataURL(file);
  });
}

$("cfg-logo-file").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  const msg = $("cfg-logo-msg");
  if (!file) return;
  if (!navigator.onLine) { msg.textContent = "Sin conexión: cambiar el logo necesita internet."; return; }
  msg.textContent = "Procesando la imagen…";
  try {
    const dataUrl = await reducirImagen(file);
    const { error } = await sb.from("locations")
      .update({ logo_data_url: dataUrl }).eq("id", STATE.activeLocationId);
    if (error) throw error;
    pintarLogo(dataUrl);
    msg.textContent = `Logo guardado (${Math.round(dataUrl.length / 1024)} KB). Ya sale en los comprobantes y reportes.`;
    await loadData();
  } catch (ex) {
    msg.textContent = `No se pudo guardar el logo: ${ex.message}`;
  } finally {
    e.target.value = "";
  }
});

$("btn-remove-logo").addEventListener("click", async () => {
  if (!confirm("¿Quitar el logo de esta tienda?")) return;
  const { error } = await sb.from("locations")
    .update({ logo_data_url: null }).eq("id", STATE.activeLocationId);
  if (error) { $("cfg-logo-msg").textContent = `No se pudo quitar: ${error.message}`; return; }
  pintarLogo(null);
  $("cfg-logo-msg").textContent = "Logo quitado.";
  await loadData();
});

$("cfg-country").addEventListener("change", (e) => {
  $("cfg-taxid-label").textContent = TAX_LABELS[e.target.value] || "NIT";
});

$("btn-save-config").addEventListener("click", async () => {
  if (!navigator.onLine) { alert("Sin conexión: guardar la configuración necesita internet."); return; }
  const { error } = await sb.from("locations").update({
    name: $("cfg-name").value, legal_name: $("cfg-legal-name").value,
    country_code: $("cfg-country").value, currency_code: $("cfg-currency").value,
    tax_id_value: $("cfg-taxid").value, address: $("cfg-address").value,
    purchase_series: $("cfg-purchase-series").value.trim().toUpperCase() || null,
    price_per_gram: parseFloat($("cfg-price-gram").value) || 0,
    include_cup_weight_in_price: $("cfg-include-cup").checked,
    margin_target_pct: parseFloat($("cfg-margin-target").value) || 0,
    report_email: $("cfg-report-email").value.trim(),
    default_weight_unit: $("cfg-weight-unit").value,
  }).eq("id", STATE.activeLocationId);

  const msg = $("config-saved");
  msg.textContent = error ? `No se pudo guardar: ${error.message}` : "Configuración guardada.";
  if (!error) {
    unidadAplicada = null;   // fuerza que los campos de peso tomen la unidad nueva
    await loadData();
    setTimeout(() => (msg.textContent = ""), 2500);
  }
});

/* --- Mi PIN de autorización ---------------------------------------------------
   El PIN se manda una vez a set_manager_pin, que lo guarda con bcrypt en un
   esquema que la API no publica. Ni la gerente puede volver a leerlo. */
async function pintarEstadoPin() {
  if (!sb || !navigator.onLine) { $("pin-status").textContent = ""; return; }
  const { data, error } = await sb.rpc("tengo_pin");
  $("pin-status").textContent = error ? ""
    : data ? "Ya tienes un PIN. Si guardas uno nuevo, reemplaza al anterior."
           : "Todavía no tienes PIN: sin él no puedes autorizar pesos a mano.";
}

$("btn-save-pin").addEventListener("click", async () => {
  const a = $("cfg-pin").value.trim(), b = $("cfg-pin2").value.trim(), msg = $("pin-saved");
  if (!/^\d{4,8}$/.test(a)) { msg.textContent = "El PIN son de 4 a 8 números."; return; }
  if (a !== b) { msg.textContent = "Los dos PIN no coinciden."; return; }
  const btn = $("btn-save-pin"); btn.disabled = true;
  const { error } = await sb.rpc("set_manager_pin", { p_pin: a });
  btn.disabled = false;
  $("cfg-pin").value = ""; $("cfg-pin2").value = "";
  msg.textContent = error ? error.message : "PIN guardado.";
  if (!error) { pintarEstadoPin(); setTimeout(() => (msg.textContent = ""), 3000); }
});

/* --- Reporte: control de pesos -------------------------------------------------
   Una llamada por sucursal, igual que el tablero: el permiso se revisa en la
   base tienda por tienda. En el consolidado del propietario, cada cajera va
   con el nombre de su tienda. */
const CLASE_PESO = {
  bascula_no_cuadra: "Báscula: las líneas no suman lo pesado",
  manual_autorizado: "Peso a mano, con PIN",
  manual_sin_autorizar: "Peso a mano SIN PIN",
  sin_dato: "Sin dato de la báscula",
  anulacion: "Pedido pesado anulado",
};

async function cargarControlPesos() {
  if (!sb || !canManage()) return;
  if (!$("wc-from").value) {
    const d = new Date(); d.setDate(d.getDate() - 6);
    $("wc-from").value = localDateStr(d);
    $("wc-to").value = localDateStr();
  }
  const scope = reportScopeId();
  const locs = scope ? STATE.locations.filter((l) => l.id === scope) : STATE.locations.filter((l) => l.active);
  const varias = locs.length > 1;
  const filas = [], incidentes = [];
  $("wc-alert").innerHTML = "";
  for (const loc of locs) {
    const { data, error } = await sb.rpc("control_pesos", {
      p_location_id: loc.id, p_from: $("wc-from").value, p_to: $("wc-to").value,
      p_utc_offset_hours: CFG.UTC_OFFSET_HOURS || -6,
    });
    if (error) {
      $("wc-alert").innerHTML = `<div class="alert warn">No se pudo cargar el control de pesos. Si sigue pasando, avísale a soporte técnico.</div>`;
      return;
    }
    const pref = varias ? `${loc.name} · ` : "";
    (data.por_cajera || []).forEach((c) => filas.push({ ...c, cajera: pref + c.cajera }));
    (data.incidentes || []).forEach((i) => incidentes.push({ ...i, cajera: pref + (i.cajera || "") }));
  }

  const pct = (n, d) => (d > 0 ? ` (${Math.round((100 * n) / d)} %)` : "");
  const tb = document.querySelector("#table-wc-cashiers tbody");
  tb.innerHTML = filas.length ? "" : '<tr><td colspan="7" class="hint">No hay ventas pesadas en esas fechas.</td></tr>';
  filas.forEach((c) => {
    const v = Number(c.ventas_pesadas) || 0;
    const sinPin = Number(c.manual_sin_autorizar) || 0;
    const raras = (Number(c.no_cuadra) || 0) + (Number(c.sin_dato) || 0);
    const tr = document.createElement("tr");
    if (sinPin || raras) tr.className = "row-bad";
    tr.innerHTML = `<td>${esc(c.cajera)}</td>
      <td class="num">${v}</td>
      <td class="num">${esc(c.bascula)}${pct(Number(c.bascula) || 0, v)}</td>
      <td class="num">${esc(c.manual_autorizado)}${pct(Number(c.manual_autorizado) || 0, v)}</td>
      <td class="num">${sinPin}${pct(sinPin, v)}</td>
      <td class="num">${raras}</td>
      <td class="num">${esc(c.anulaciones)}${Number(c.gramos_anulados) > 0 ? ` · ${esc(fmtWeightShort(Number(c.gramos_anulados)))}` : ""}</td>`;
    tb.appendChild(tr);
  });

  incidentes.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  const ti = document.querySelector("#table-wc-incidents tbody");
  ti.innerHTML = incidentes.length ? "" : '<tr><td colspan="7" class="hint">Nada fuera de lo normal: todo salió de la báscula.</td></tr>';
  incidentes.slice(0, 100).forEach((i) => {
    const tr = document.createElement("tr");
    if (i.clase !== "manual_autorizado") tr.className = "row-bad";
    tr.innerHTML = `<td>${i.fecha ? esc(new Date(i.fecha).toLocaleString()) : ""}</td>
      <td class="num">${i.folio == null ? "—" : esc(i.folio)}</td>
      <td>${esc(i.cajera)}</td>
      <td>${esc(CLASE_PESO[i.clase] || i.clase)}</td>
      <td class="num">${esc(fmtWeightShort(Number(i.peso_g) || 0))}</td>
      <td>${esc(i.autorizo ? `${i.autorizo}${i.metodo === "huella" ? " (huella)" : i.metodo === "pin" ? " (PIN)" : ""}` : "—")}</td>
      <td>${esc(i.motivo || "")}</td>`;
    ti.appendChild(tr);
  });
}
$("btn-wc-load").addEventListener("click", cargarControlPesos);

/* --- Libro de ventas (formato ICG) -----------------------------------------
   Lee las ventas del rango directo de la tabla (RLS decide qué tiendas puede
   ver quien lo pide) y arma el Excel en el navegador con libro-ventas.js.
   El propietario en "todas" recibe una hoja por tienda, como ICG saca un
   reporte por punto de venta: no se mezclan correlativos de dos tiendas. */
function prepararLibroVentas() {
  if ($("lv-from").value) return;
  const hoy = new Date();
  $("lv-from").value = localDateStr(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
  $("lv-to").value = localDateStr(hoy);
}

async function ventasDelRango(locationId, desde, hasta, desfase) {
  // Medianoche de la tienda expresada en UTC.
  const inicio = new Date(Date.parse(desde + "T00:00:00Z") - desfase * 3600e3).toISOString();
  const fin = new Date(Date.parse(hasta + "T00:00:00Z") + 864e5 - desfase * 3600e3).toISOString();
  const todas = [];
  for (let pag = 0; ; pag++) {
    const { data, error } = await sb.from("sales")
      .select("created_at, folio, customer_name, customer_tax_id, total_price, discount, location_id")
      .eq("location_id", locationId).gte("created_at", inicio).lt("created_at", fin)
      .order("created_at", { ascending: true }).range(pag * 1000, pag * 1000 + 999);
    if (error) throw error;
    todas.push(...(data || []));
    if (!data || data.length < 1000) return todas;
  }
}

$("btn-lv-download").addEventListener("click", async () => {
  const msg = (t, tipo) => {
    $("lv-msg").innerHTML = !t ? "" : tipo === "info" ? `<p class="hint">${esc(t)}</p>` : `<div class="alert warn">${esc(t)}</div>`;
  };
  const desde = $("lv-from").value, hasta = $("lv-to").value;
  if (!desde || !hasta || desde > hasta) { msg("Revisa las fechas: “Desde” tiene que ser antes de “Hasta”."); return; }
  if (!sb) { msg("Para sacar el libro hace falta conexión a internet."); return; }
  const scope = reportScopeId();
  const locs = scope ? STATE.locations.filter((l) => l.id === scope) : STATE.locations.filter((l) => l.active);
  const desfase = Number(CFG.UTC_OFFSET_HOURS ?? -6);
  const btn = $("btn-lv-download"); btn.disabled = true; msg("Preparando el libro…", "info");
  try {
    const hojas = [];
    let facturas = 0;
    for (const loc of locs) {
      const ventas = await ventasDelRango(loc.id, desde, hasta, desfase);
      const h = LibroVentas.hojaLibro({ tienda: loc.name, pais: loc.country_code, desde, hasta, ventas, desfase });
      facturas += h.filas.length;
      hojas.push({ nombre: loc.name, matriz: h.matriz });
    }
    const bytes = LibroVentas.crearXlsx(hojas);
    const quien = locs.length === 1 ? locs[0].name : "todas";
    const nombre = `libro-ventas_${quien}_${desde}_${hasta}.xlsx`.replace(/[^\w.-]+/g, "-");
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = document.createElement("a"); a.href = url; a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    msg(facturas ? "" : "No hubo ventas en esas fechas; el libro sale solo con encabezado y totales en cero.", "info");
  } catch (e) {
    console.error(e);
    msg("No se pudo sacar el libro de ventas. Si sigue pasando, avísale a soporte técnico.");
  } finally { btn.disabled = false; }
});

/* ===========================================================================
   13. SUCURSALES Y USUARIOS (solo propietario)
   =========================================================================== */
function renderAdmin() {
  const locBody = document.querySelector("#table-locations tbody");
  locBody.innerHTML = "";
  STATE.locations.forEach((l) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(l.name)}</td><td>${esc(l.country_code)}</td><td>${esc(l.currency_code)}</td>
      <td class="num">${l.price_per_gram}</td>
      <td>${l.active ? "Sí" : "No"}</td>
      <td><button class="btn ghost btn-use" type="button">Trabajar en esta</button></td>`;
    tr.querySelector(".btn-use").addEventListener("click", async () => {
      STATE.activeLocationId = l.id;
      lsSet(LS.lastLocation, l.id);
      await loadData();
      alert(`Ahora estás trabajando en ${l.name}.`);
    });
    locBody.appendChild(tr);
  });

  fillNewUserLocationPicker();

  const pBody = document.querySelector("#table-profiles tbody");
  pBody.innerHTML = "";
  STATE.profiles.forEach((p) => {
    const tr = document.createElement("tr");
    const locOptions = ['<option value="">— (todas, solo propietario) —</option>']
      .concat(STATE.locations.map((l) => `<option value="${esc(l.id)}"${p.location_id === l.id ? " selected" : ""}>${esc(l.name)}</option>`))
      .join("");
    tr.innerHTML = `<td>${esc(p.full_name || "(sin nombre)")}</td>
      <td><select data-field="role">
        <option value="cajera"${p.role === "cajera" ? " selected" : ""}>cajera</option>
        <option value="gerente"${p.role === "gerente" ? " selected" : ""}>gerente</option>
        <option value="propietario"${p.role === "propietario" ? " selected" : ""}>propietario</option>
      </select></td>
      <td><select data-field="location_id">${locOptions}</select></td>
      <td><input type="checkbox" data-field="active"${p.active ? " checked" : ""}></td>
      <td>${rowActionsHtml()}</td>`;
    tr.querySelector(".btn-del").remove();
    tr.querySelector(".btn-save").addEventListener("click", async () => {
      const role = tr.querySelector('[data-field="role"]').value;
      const locId = tr.querySelector('[data-field="location_id"]').value || null;
      if (role !== "propietario" && !locId) {
        alert("Una cajera o gerente necesita una sucursal asignada.");
        return;
      }
      const { error } = await sb.from("profiles").update({
        role, location_id: role === "propietario" ? null : locId,
        active: tr.querySelector('[data-field="active"]').checked,
      }).eq("id", p.id);
      if (error) { alert(`No se pudo guardar: ${error.message}`); return; }
      await loadData();
    });
    pBody.appendChild(tr);
  });
}

function fillNewUserLocationPicker() {
  const sel = $("nu-location");
  const keep = sel.value;
  sel.innerHTML = '<option value="">— (todas: solo para propietario) —</option>';
  STATE.locations.forEach((l) => {
    const o = document.createElement("option");
    o.value = l.id; o.textContent = l.name; sel.appendChild(o);
  });
  sel.value = keep || STATE.activeLocationId || "";
}

// Crear la cuenta con el cliente normal metería a la persona recién creada en
// la sesión del navegador y sacaría al propietario de la suya. Por eso se usa
// un cliente aparte que no guarda sesión: crea el usuario y se olvida de él.
let sbSignup = null;
function signupClient() {
  if (!sbSignup) {
    sbSignup = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return sbSignup;
}

$("btn-add-user").addEventListener("click", async () => {
  const msg = $("nu-msg");
  const nombre = $("nu-name").value.trim();
  const correo = $("nu-email").value.trim().toLowerCase();
  const clave  = $("nu-password").value;
  const rol    = $("nu-role").value;
  const locId  = $("nu-location").value || null;

  if (!nombre) { msg.textContent = "Ponle el nombre completo."; return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) { msg.textContent = "Ese correo no se ve válido."; return; }
  if (clave.length < 6) { msg.textContent = "La contraseña temporal debe tener al menos 6 caracteres."; return; }
  // La misma regla que impone la base: quien no es propietario necesita tienda.
  if (rol !== "propietario" && !locId) { msg.textContent = "Una cajera o gerente necesita una sucursal asignada."; return; }
  if (!navigator.onLine) { msg.textContent = "Sin conexión: dar de alta a alguien necesita internet."; return; }

  const btn = $("btn-add-user");
  btn.disabled = true; msg.textContent = "Creando…";
  try {
    const { data, error } = await signupClient().auth.signUp({
      email: correo, password: clave, options: { data: { full_name: nombre } },
    });
    if (error) throw error;

    // Cuando el correo ya existe, el servidor no lo dice de frente (para que
    // nadie pueda averiguar qué correos están registrados): devuelve un
    // usuario sin identidades. Eso es lo que revisamos aquí.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      msg.textContent = "Ya existe un usuario con ese correo. Búscalo en la tabla de arriba para cambiarle el rol o la tienda.";
      return;
    }
    if (!data.user) throw new Error("El servidor no devolvió el usuario.");

    // El perfil lo crea la base sola al nacer el usuario (como cajera sin
    // tienda). Aquí el propietario le pone su rol y su sucursal de verdad.
    const { error: perr } = await sb.from("profiles").upsert({
      id: data.user.id, full_name: nombre, role: rol,
      location_id: rol === "propietario" ? null : locId, active: true,
    });
    if (perr) throw perr;

    const tienda = STATE.locations.find((l) => l.id === locId);
    msg.textContent = `Listo: ${nombre} ya puede entrar como ${rol}` +
      (tienda ? ` en ${tienda.name}` : "") +
      `. Dale su correo y la contraseña temporal.` +
      (data.session ? "" : " Si al entrar le pide confirmar el correo, avísale a soporte técnico.");
    ["nu-name", "nu-email", "nu-password"].forEach((id) => ($(id).value = ""));
    await loadData();
  } catch (ex) {
    const m = ex.message || String(ex);
    msg.textContent = /Password should be/i.test(m)
      ? "La contraseña es muy corta o muy débil para las reglas del servidor."
      : /signups? not allowed|disabled/i.test(m)
      ? "El servidor no está aceptando altas nuevas. Avísale a soporte técnico."
      : `No se pudo crear: ${m}`;
  } finally {
    btn.disabled = false;
  }
});

$("btn-add-location").addEventListener("click", async () => {
  const name = $("nl-name").value.trim();
  if (!name) { alert("Ponle nombre a la sucursal."); return; }
  const { error } = await sb.from("locations").insert({
    name, country_code: $("nl-country").value,
    currency_code: $("nl-currency").value.trim() || "HNL",
    price_per_gram: parseFloat($("nl-price").value) || 0,
    legal_name: "Tuti's Frozen Yogurt",
  });
  const msg = $("new-location-msg");
  if (error) { msg.textContent = `No se pudo crear: ${error.message}`; return; }
  msg.textContent = `Sucursal "${name}" creada. Entra a "Trabajar en esta" para cargarle su inventario, y asígnale su gerente y cajeras abajo.`;
  ["nl-name", "nl-currency", "nl-price"].forEach((id) => ($(id).value = ""));
  await loadData();
});

/* ===========================================================================
   14. BÁSCULA (Web Serial)
   ---------------------------------------------------------------------------
   Funciona en Chrome o Edge sobre HTTPS; no en Safari ni en iPad. El
   protocolo vive en bascula.js; aquí solo se conecta con la pantalla.
   Al abrir la caja se reconecta sola con el puerto que ya tenía permiso (o
   con todos, si el modo kiosko los autorizó por política). La primera vez en
   una computadora nueva hay que presionar "Conectar báscula" y elegirla.
   =========================================================================== */
const balanza = window.Bascula.crear({
  baudRate: CFG.SCALE_BAUD_RATE || 9600,
  dataBits: CFG.SCALE_DATA_BITS || 7,
  parity: CFG.SCALE_PARITY || "even",
  stopBits: CFG.SCALE_STOP_BITS || 1,
});

let mensajeBascula = null; // un aviso a la cajera tapa la lectura por unos segundos
function pintarEstadoBascula(msg, esError) {
  mensajeBascula = { msg, esError, hasta: Date.now() + (esError ? 6000 : 2500) };
  pintarBascula();
}

function pintarBascula() {
  const lectura = $("scale-reading"), estado = $("scale-status");
  const l = balanza.ultima;
  $("btn-scale-connect").hidden = balanza.conectada || !balanza.soportada();
  if (!balanza.soportada()) {
    lectura.textContent = "—";
    estado.textContent = "Este navegador no puede leer la báscula. Usa Chrome en la computadora de la caja; mientras tanto, los pesos van a mano con PIN.";
    return;
  }
  if (!balanza.conectada) {
    lectura.textContent = "—";
  } else if (!l || Date.now() - l.at > 1500) {
    lectura.textContent = "…";
  } else if (l.gramos == null) {
    lectura.textContent = balanza.ultimoEstado && balanza.ultimoEstado.sobrecarga ? "Sobrecarga" : "En movimiento";
  } else {
    lectura.textContent = fmtWeight(l.gramos);
  }
  lectura.classList.toggle("moving", !!(l && !l.estable));

  if (mensajeBascula && Date.now() < mensajeBascula.hasta) {
    estado.textContent = mensajeBascula.msg;
    estado.classList.toggle("bad", mensajeBascula.esError);
    return;
  }
  estado.classList.remove("bad");
  if (!balanza.conectada) { estado.textContent = "Sin conectar"; return; }
  if (!l || Date.now() - l.at > 1500) { estado.textContent = "Conectada, esperando lectura…"; return; }
  let t = l.estable ? "Estable" : "Moviéndose";
  if (l.estado && l.estado.tara) t += " · TARA puesta";
  if (PESO.ultimoBruto != null && l.gramos != null) {
    const d = r2(l.gramos - PESO.ultimoBruto);
    t += ` · ${d >= 0 ? "+" : ""}${fmtWeightShort(d)} desde la última pesada`;
  }
  estado.textContent = t;
}
balanza.escuchar(pintarBascula);
setInterval(pintarBascula, 1000);

$("btn-scale-connect").addEventListener("click", async () => {
  try {
    await balanza.elegir();
    pintarEstadoBascula("Báscula conectada.", false);
  } catch (e) {
    if (e && e.name === "NotFoundError") return; // cerró el selector sin elegir
    pintarEstadoBascula(`No se pudo conectar la báscula: ${e.message}`, true);
  }
});

if (balanza.soportada()) {
  navigator.serial.addEventListener("connect", () => balanza.auto().then(pintarBascula));
  navigator.serial.addEventListener("disconnect", () => { balanza.cerrar().then(pintarBascula); });
  balanza.auto().then(pintarBascula).catch(() => pintarBascula());
} else {
  pintarBascula();
}

/* ===========================================================================
   MOTOR DE GRÁFICAS (SVG a mano)
   ---------------------------------------------------------------------------
   No hay librería de gráficas y no puede haberla: la política de seguridad
   del sitio es script-src 'self', o sea que el navegador no ejecuta código
   traído de otro dominio. Tampoco hace falta — todo lo que este negocio
   necesita graficar son barras, una línea y una barra apilada.

   Reglas que siguen todas:
     · Un solo eje. Nunca dos escalas en la misma gráfica.
     · El color significa lo mismo siempre: verde lo que se queda, rojo lo
       que sale, azul volumen.
     · Rojo y verde juntos son difíciles para daltonismo rojo-verde, así que
       donde aparecen juntos SIEMPRE hay etiqueta de texto además del color.
     · Cada barra lleva <title>, que el navegador muestra al pasar encima.
   =========================================================================== */
const VIZ = { W: 720, H: 200, padL: 48, padR: 12, padT: 12, padB: 26 };

const vizNum = (v) => Math.abs(v) >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k"
                    : String(Math.round(v * 10) / 10);

function vizVacio(box, mensaje) {
  box.innerHTML = `<div class="chart-empty">${esc(mensaje)}</div>`;
}

// Rejilla horizontal + etiquetas del eje vertical.
function vizRejilla(max, y, W, padL, padR) {
  let out = "";
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k, yy = y(v).toFixed(1);
    out += `<line class="chart-axis" x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}"/>`;
    out += `<text class="chart-label" x="${padL - 6}" y="${(+yy + 3).toFixed(1)}" text-anchor="end">${vizNum(v)}</text>`;
  }
  return out;
}

/* Barras verticales. series = [{clave, valor, titulo}], una sola serie. */
function vizBarras(box, series, opciones) {
  const o = Object.assign({ color: "fill-neutral", etiquetaX: (d) => d.clave, maxEtiquetas: 12 }, opciones || {});
  if (!series.length || series.every((d) => !d.valor)) { vizVacio(box, o.vacio || "Sin datos en este periodo."); return; }
  const { W, H, padL, padR, padT, padB } = VIZ;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(...series.map((d) => d.valor), 1);
  const slot = innerW / series.length;
  const bw = Math.max(3, Math.min(40, slot - 4));   // 4px de aire entre barras
  const y = (v) => padT + innerH - (v / max) * innerH;

  let barras = "";
  series.forEach((d, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    const alto = Math.max(0, padT + innerH - y(d.valor));
    barras += `<g data-mark><title>${esc(d.titulo || `${d.clave}: ${d.valor}`)}</title>` +
      `<rect class="${o.color}" x="${x.toFixed(1)}" y="${y(d.valor).toFixed(1)}" width="${bw.toFixed(1)}" height="${alto.toFixed(1)}" rx="4"/></g>`;
  });

  const paso = Math.ceil(series.length / o.maxEtiquetas);
  let etiquetas = "";
  series.forEach((d, i) => {
    if (i % paso) return;
    etiquetas += `<text class="chart-label" x="${(padL + i * slot + slot / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(o.etiquetaX(d))}</text>`;
  });

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || "gráfica de barras")}">
    ${vizRejilla(max, y, W, padL, padR)}${barras}${etiquetas}</svg>`;
}

/* Barras horizontales: para categorías con nombre largo (toppings, gastos). */
function vizBarrasH(box, series, opciones) {
  const o = Object.assign({ color: "fill-neutral", formato: (v) => vizNum(v), max: 8 }, opciones || {});
  const datos = series.slice(0, o.max);
  if (!datos.length || datos.every((d) => !d.valor)) { vizVacio(box, o.vacio || "Sin datos en este periodo."); return; }
  const filaH = 26, padL = 150, padR = 60, padT = 6;
  const W = 720, H = padT * 2 + datos.length * filaH;
  const innerW = W - padL - padR;
  const max = Math.max(...datos.map((d) => d.valor), 1);

  const filas = datos.map((d, i) => {
    const y = padT + i * filaH;
    const ancho = Math.max(2, (d.valor / max) * innerW);
    // El nombre se recorta para que no se monte sobre la barra.
    const nombre = d.clave.length > 22 ? d.clave.slice(0, 21) + "…" : d.clave;
    return `<g data-mark><title>${esc(d.titulo || `${d.clave}: ${o.formato(d.valor)}`)}</title>` +
      `<text class="chart-label" x="${padL - 8}" y="${y + filaH / 2 + 3}" text-anchor="end">${esc(nombre)}</text>` +
      `<rect class="${o.color}" x="${padL}" y="${y + 4}" width="${ancho.toFixed(1)}" height="${filaH - 10}" rx="4"/>` +
      `<text class="chart-value" x="${(padL + ancho + 6).toFixed(1)}" y="${y + filaH / 2 + 3}">${esc(o.formato(d.valor))}</text></g>`;
  }).join("");

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || "gráfica de barras")}">${filas}</svg>`;
}

/* Dos series de barras lado a lado (ingresos contra gastos). */
function vizBarrasDobles(box, series, opciones) {
  const o = Object.assign({}, opciones || {});
  if (!series.length || series.every((d) => !d.a && !d.b)) { vizVacio(box, "Sin movimientos en este periodo."); return; }
  const { W, H, padL, padR, padT, padB } = VIZ;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(...series.map((d) => Math.max(d.a, d.b)), 1);
  const slot = innerW / series.length;
  const bw = Math.max(2, Math.min(16, slot / 2 - 1));   // el -1 deja el aire entre las dos
  const y = (v) => padT + innerH - (v / max) * innerH;
  const prom = series.reduce((x, d) => x + d.a, 0) / series.length;

  let barras = "";
  series.forEach((d, i) => {
    const cx = padL + i * slot + slot / 2;
    barras += `<g data-mark><title>${esc(d.titulo)}</title>` +
      `<rect class="fill-ok"  x="${(cx - bw - 1).toFixed(1)}" y="${y(d.a).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, padT + innerH - y(d.a)).toFixed(1)}" rx="3"/>` +
      `<rect class="fill-bad" x="${(cx + 1).toFixed(1)}" y="${y(d.b).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, padT + innerH - y(d.b)).toFixed(1)}" rx="3"/></g>`;
  });

  const paso = Math.ceil(series.length / 8);
  let etiquetas = "";
  series.forEach((d, i) => { if (i % paso) return;
    etiquetas += `<text class="chart-label" x="${(padL + i * slot + slot / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(d.clave)}</text>`; });

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="ingresos y gastos por periodo">
    ${vizRejilla(max, y, W, padL, padR)}${barras}
    <line x1="${padL}" y1="${y(prom).toFixed(1)}" x2="${W - padR}" y2="${y(prom).toFixed(1)}"
          stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="4 3"/>
    ${etiquetas}</svg>`;
  return prom;
}

/* Barra apilada horizontal: en qué se reparte cada lempira que entra. */
function vizApilada(box, segmentos) {
  const total = segmentos.reduce((a, s) => a + Math.max(0, s.valor), 0);
  if (!(total > 0)) { vizVacio(box, "Todavía no hay ingresos en este periodo."); return; }
  const W = 720, H = 92, padL = 0, barY = 10, barH = 34;
  const innerW = W - padL;
  let x = padL, barras = "", leyenda = "", lx = 0;

  segmentos.forEach((s) => {
    const v = Math.max(0, s.valor);
    const pct = (100 * v) / total;
    let w = (v / total) * innerW;
    if (w > 2) w -= 2;                       // 2px de aire entre segmentos
    if (v > 0) {
      barras += `<g data-mark><title>${esc(`${s.nombre}: ${dmoney(s.valor)} (${r2(pct)}%)`)}</title>` +
        `<rect class="${s.color}" x="${x.toFixed(1)}" y="${barY}" width="${Math.max(1, w).toFixed(1)}" height="${barH}" rx="4"/>`;
      // Rojo y verde juntos: la etiqueta dentro de la barra no es decoración,
      // es lo que hace legible la gráfica sin distinguir color.
      if (pct >= 11) {
        barras += `<text x="${(x + w / 2).toFixed(1)}" y="${barY + barH / 2 + 4}" text-anchor="middle"
                    fill="#fff" font-family="var(--font)" font-size="11" font-weight="700">${r2(pct)}%</text>`;
      }
      barras += `</g>`;
      x += (v / total) * innerW;
    }
    leyenda += `<g><rect class="${s.color}" x="${lx}" y="${H - 16}" width="10" height="10" rx="2"/>` +
      `<text class="chart-label" x="${lx + 15}" y="${H - 7}">${esc(s.nombre)} ${dmoney(s.valor)}</text></g>`;
    lx += 26 + Math.max(90, s.nombre.length * 6.2 + String(dmoney(s.valor)).length * 6.2);
  });

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="reparto de los ingresos">${barras}${leyenda}</svg>`;
}

/* Línea: para una tendencia (el margen %). */
function vizLinea(box, series, opciones) {
  const o = Object.assign({ sufijo: "%", vacio: "Sin datos en este periodo." }, opciones || {});
  const conDato = series.filter((d) => d.valor !== null);
  if (conDato.length < 2) { vizVacio(box, o.vacio); return; }
  const { W, H, padL, padR, padT, padB } = VIZ;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(...conDato.map((d) => d.valor), o.min100 ? 100 : 1);
  const min = Math.min(...conDato.map((d) => d.valor), 0);
  const y = (v) => padT + innerH - ((v - min) / ((max - min) || 1)) * innerH;
  const x = (i) => padL + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);

  let d = "", puntos = "", abierto = false;
  series.forEach((p, i) => {
    if (p.valor === null) { abierto = false; return; }   // días sin ventas cortan la línea
    d += (abierto ? " L " : " M ") + x(i).toFixed(1) + " " + y(p.valor).toFixed(1);
    abierto = true;
    puntos += `<g data-mark><title>${esc(`${p.clave}: ${r2(p.valor)}${o.sufijo}`)}</title>` +
      `<circle cx="${x(i).toFixed(1)}" cy="${y(p.valor).toFixed(1)}" r="4" class="${o.color || "fill-ok"}"
        stroke="var(--surface)" stroke-width="2"/></g>`;
  });

  let rejilla = "";
  for (let k = 0; k <= 4; k++) {
    const v = min + ((max - min) / 4) * k, yy = y(v).toFixed(1);
    rejilla += `<line class="chart-axis" x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}"/>`;
    rejilla += `<text class="chart-label" x="${padL - 6}" y="${(+yy + 3).toFixed(1)}" text-anchor="end">${vizNum(v)}${o.sufijo}</text>`;
  }
  const paso = Math.ceil(series.length / 8);
  let etiquetas = "";
  series.forEach((p, i) => { if (i % paso) return;
    etiquetas += `<text class="chart-label" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(p.clave)}</text>`; });

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || "tendencia")}">
    ${rejilla}<path d="${d}" class="stroke-ok"/>${puntos}${etiquetas}</svg>`;
}

/* ===========================================================================
   15. DASHBOARD
   ---------------------------------------------------------------------------
   Los números salen de dashboard_summary(), una función de la base que ya
   trae todo agregado de un periodo. Se llama una vez por sucursal y aquí se
   suman: así el propietario ve cada tienda por separado y las dos juntas, y
   la base sigue siendo la que decide quién puede ver qué.

   Las gráficas son SVG dibujado a mano. No hay librería de gráficas a
   propósito: la política de seguridad del sitio no permite cargar código de
   otro dominio, y para barras y una línea de promedio no hace falta.
   =========================================================================== */
const DASH = { results: [], expenses: [], audit: [], from: null, to: null, loaded: false };

const EXPENSE_LABELS = {
  renta: "Renta", planilla: "Planilla", insumos: "Insumos",
  servicios: "Servicios", mantenimiento: "Mantenimiento",
  mercadeo: "Mercadeo", impuestos: "Impuestos", otros: "Otros",
};

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeek(d) { const x = new Date(d); const w = (x.getDay() + 6) % 7; return addDays(x, -w); }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }

// Traduce el selector de periodo a un par de fechas locales. Todo en fecha
// local de la tienda, nunca UTC: en UTC-6 las ventas de la tarde caerían en
// el día equivocado.
function dashRange() {
  const hoy = new Date();
  const v = $("dash-range").value;
  switch (v) {
    case "hoy":           return { from: hoy, to: hoy };
    case "ayer":          return { from: addDays(hoy, -1), to: addDays(hoy, -1) };
    case "semana":        return { from: startOfWeek(hoy), to: hoy };
    case "semana_pasada": { const i = addDays(startOfWeek(hoy), -7); return { from: i, to: addDays(i, 6) }; }
    case "mes":           return { from: startOfMonth(hoy), to: hoy };
    case "mes_pasado":    { const i = startOfMonth(addDays(startOfMonth(hoy), -1)); return { from: i, to: endOfMonth(i) }; }
    case "30d":           return { from: addDays(hoy, -29), to: hoy };
    case "90d":           return { from: addDays(hoy, -89), to: hoy };
    default: {
      const f = $("dash-from").value, t = $("dash-to").value;
      return { from: f ? new Date(f + "T12:00:00") : addDays(hoy, -6),
               to:   t ? new Date(t + "T12:00:00") : hoy };
    }
  }
}

function dashScopeIds() {
  if (!isOwner()) return [STATE.profile.location_id];
  const v = $("dash-location").value;
  return v === "__all__" ? STATE.locations.filter((l) => l.active).map((l) => l.id) : [v];
}

// La moneda del tablero es la de la tienda que se está viendo. En el
// consolidado se usa la de la primera, y si hay monedas distintas el aviso de
// arriba ya advierte que esos totales no son comparables.
function dashCurrency() {
  const ids = dashScopeIds();
  const loc = STATE.locations.find((l) => l.id === ids[0]);
  return (loc && loc.currency_code) || "";
}
function dmoney(v) { return `${dashCurrency()} ${(Number(v) || 0).toFixed(2)}`; }

function fillDashLocationPicker() {
  const sel = $("dash-location");
  const keep = sel.value;
  sel.innerHTML = "";
  if (isOwner()) {
    sel.innerHTML = '<option value="__all__">Todas las tiendas (consolidado)</option>';
    STATE.locations.forEach((l) => {
      const o = document.createElement("option");
      o.value = l.id; o.textContent = l.name; sel.appendChild(o);
    });
    sel.value = keep || "__all__";
  } else {
    const loc = activeLocation();
    const o = document.createElement("option");
    o.value = STATE.profile.location_id;
    o.textContent = loc ? loc.name : "Mi tienda";
    sel.appendChild(o);
  }
  sel.disabled = !isOwner();
}

$("dash-range").addEventListener("change", () => {
  const custom = $("dash-range").value === "personalizado";
  $("dash-custom-from").hidden = !custom;
  $("dash-custom-to").hidden = !custom;
  if (!custom) loadDashboard();
});
$("dash-location").addEventListener("change", loadDashboard);
$("btn-dash-refresh").addEventListener("click", loadDashboard);
["dash-from", "dash-to"].forEach((id) => $(id).addEventListener("change", () => {
  if ($("dash-range").value === "personalizado") loadDashboard();
}));

async function loadDashboard() {
  if (!canManage()) return;
  const warn = $("dash-warnings");
  if (!navigator.onLine) {
    warn.innerHTML = '<div class="alert warn">Sin conexión: el tablero necesita internet porque los números se calculan en el servidor. La pantalla de venta sí sigue funcionando.</div>';
    return;
  }
  const { from, to } = dashRange();
  if (from > to) {
    warn.innerHTML = '<div class="alert bad">La fecha "desde" es posterior a la fecha "hasta".</div>';
    return;
  }
  DASH.from = localDateStr(from);
  DASH.to = localDateStr(to);
  warn.innerHTML = '<p class="hint">Calculando…</p>';

  const ids = dashScopeIds().filter(Boolean);
  const results = [];
  for (const locId of ids) {
    const { data, error } = await sb.rpc("dashboard_summary", {
      p_location_id: locId, p_from: DASH.from, p_to: DASH.to,
      p_utc_offset_hours: CFG.UTC_OFFSET_HOURS ?? -6,
    });
    if (error) {
      warn.innerHTML = `<div class="alert bad">No se pudo cargar el tablero: ${esc(error.message)}</div>`;
      return;
    }
    results.push({ ...data, locationName: (STATE.locations.find((l) => l.id === locId) || {}).name || "" });
  }
  DASH.results = results;

  let q = sb.from("expenses").select("*, locations(name)")
            .gte("spent_on", DASH.from).lte("spent_on", DASH.to)
            .order("spent_on", { ascending: false }).limit(200);
  if (ids.length === 1) q = q.eq("location_id", ids[0]);
  const { data: gastos } = await q;
  DASH.expenses = gastos || [];

  // El rastro de auditoría: la base ya decide qué puede ver cada quien, así
  // que aquí solo se pide y se muestra lo que devuelva.
  let qa = sb.from("audit_log").select("*")
             .gte("at", DASH.from + "T00:00:00")
             .lte("at", DASH.to + "T23:59:59.999")
             .order("at", { ascending: false }).limit(150);
  if (ids.length === 1) qa = qa.eq("location_id", ids[0]);
  const { data: eventos } = await qa;
  DASH.audit = eventos || [];

  DASH.loaded = true;
  renderDashboard();
}

function dashTotals() {
  return DASH.results.reduce((a, c) => ({
    ventas:   a.ventas   + Number(c.ventas || 0),
    ingresos: a.ingresos + Number(c.ingresos || 0),
    costos:   a.costos   + Number(c.costos || 0),
    margen:   a.margen   + Number(c.margen || 0),
    gastos:   a.gastos   + Number(c.gastos || 0),
    utilidad: a.utilidad + Number(c.utilidad || 0),
    vasos:    a.vasos    + Number(c.vasos || 0),
    cucharas: a.cucharas + Number(c.cucharas || 0),
    helado:   a.helado   + Number(c.peso_helado_g || 0),
    toppings: a.toppings + Number(c.peso_toppings_g || 0),
  }), { ventas: 0, ingresos: 0, costos: 0, margen: 0, gastos: 0, utilidad: 0,
        vasos: 0, cucharas: 0, helado: 0, toppings: 0 });
}

// Suma las series diarias de todas las tiendas del alcance, día por día.
function dashSerie() {
  const by = new Map();
  DASH.results.forEach((r) => (r.serie || []).forEach((d) => {
    const cur = by.get(d.dia) || { dia: d.dia, ventas: 0, ingresos: 0, costos: 0, margen: 0, gastos: 0 };
    cur.ventas += Number(d.ventas || 0);
    cur.ingresos += Number(d.ingresos || 0);
    cur.costos += Number(d.costos || 0);
    cur.margen += Number(d.margen || 0);
    cur.gastos += Number(d.gastos || 0);
    by.set(d.dia, cur);
  }));
  return [...by.values()].sort((a, b) => (a.dia < b.dia ? -1 : 1));
}

// Cuántos días abarca el periodo pedido. Se calcula del rango, no de lo que
// devolvió el servidor: así la etiqueta y el promedio diario nunca pueden
// contradecir al filtro que el usuario está viendo en pantalla.
function dashDayCount() {
  if (!DASH.from || !DASH.to) return 0;
  const a = new Date(DASH.from + "T12:00:00"), b = new Date(DASH.to + "T12:00:00");
  return Math.round((b - a) / 86400000) + 1;
}

function dashMixedCurrencyWarning() {
  const ids = dashScopeIds();
  if (ids.length <= 1) return "";
  const monedas = [...new Set(STATE.locations.filter((l) => ids.includes(l.id)).map((l) => l.currency_code))];
  if (monedas.length <= 1) return "";
  return `<div class="alert warn">Las tiendas de este consolidado manejan monedas distintas (${esc(monedas.join(", "))}). Los totales en dinero no son comparables; míralas por separado. Los pesos y las cantidades sí se pueden sumar.</div>`;
}

function renderDashboard() {
  const t = dashTotals();
  const serie = dashSerie();
  const ids = dashScopeIds();
  const scopeName = ids.length > 1
    ? "Todas las tiendas"
    : (STATE.locations.find((l) => l.id === ids[0]) || {}).name || "";

  const fmt = (iso) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
  const nDias = dashDayCount();
  $("dash-range-label").textContent = `Mostrando ${scopeName} — del ${fmt(DASH.from)} al ${fmt(DASH.to)} (${nDias} día${nDias === 1 ? "" : "s"}).`;
  $("dash-print-head").innerHTML = logoHtml() + `<strong>${esc(scopeName)}</strong> — del ${fmt(DASH.from)} al ${fmt(DASH.to)}`;
  $("dash-warnings").innerHTML = dashMixedCurrencyWarning();

  const margenPct = t.ingresos > 0 ? r2((100 * t.margen) / t.ingresos) : 0;
  const utilPct   = t.ingresos > 0 ? r2((100 * t.utilidad) / t.ingresos) : 0;
  const ticket    = t.ventas > 0 ? r2(t.ingresos / t.ventas) : 0;
  const diaria    = nDias ? r2(t.ingresos / nDias) : 0;

  const kpi = (label, value, sub, cls) =>
    `<div class="kpi ${cls || ""}"><div class="kpi-label">${label}</div>
     <div class="kpi-value num">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;

  $("dash-kpis").innerHTML =
    kpi("Ingresos", dmoney(t.ingresos), `${t.ventas} venta${t.ventas === 1 ? "" : "s"}`) +
    kpi("Costo del producto", dmoney(t.costos)) +
    kpi("Margen bruto", dmoney(t.margen), `${margenPct}% de los ingresos`) +
    kpi("Gastos de operación", dmoney(t.gastos)) +
    // La utilidad es el único número que dice si la tienda gana: margen del
    // producto menos lo que cuesta tener la tienda abierta.
    kpi("Utilidad", dmoney(t.utilidad), `${utilPct}% de los ingresos`,
        t.utilidad >= 0 ? "good" : "bad") +
    kpi("Ticket promedio", dmoney(ticket)) +
    kpi("Promedio diario", dmoney(diaria), `sobre ${nDias} día${nDias === 1 ? "" : "s"}`) +
    kpi("Vasos", t.vasos, `${t.cucharas} cucharas`) +
    kpi("Helado vendido", fmtWeightShort(t.helado), prefUnit() === "oz" ? `${r2(t.helado)} g` : `${r2(toOz(t.helado))} oz`) +
    kpi("Toppings vendidos", fmtWeightShort(t.toppings), prefUnit() === "oz" ? `${r2(t.toppings)} g` : `${r2(toOz(t.toppings))} oz`);

  renderDashCharts(serie, t);
  renderDashStores();
  renderDashProjection(serie, t);
  renderDashAudit();
  renderDashToppings();
}

/* --- Las gráficas del tablero --------------------------------------------- */
const DIAS_SEMANA = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

function renderDashCharts(serie, t) {
  // 1. A dónde va cada lempira. Es la gráfica que contesta "¿gano o no?".
  vizApilada($("chart-composicion"), [
    { nombre: "Costo del producto", valor: t.costos,   color: "fill-neutral" },
    { nombre: "Gastos de operar",   valor: t.gastos,   color: "fill-bad" },
    { nombre: "Utilidad",           valor: t.utilidad, color: "fill-ok" },
  ]);
  if (t.utilidad < 0) {
    $("chart-composicion").innerHTML +=
      `<div class="alert warn">En este periodo los gastos se comieron el margen: la utilidad es ${dmoney(t.utilidad)}. La barra solo reparte lo que entró.</div>`;
  }

  // 2. Ingresos contra gastos, día por día (o por semana si el periodo es largo).
  let puntos = serie, agrupado = false;
  if (serie.length > 45) {
    agrupado = true;
    const by = new Map();
    serie.forEach((d) => {
      const k = localDateStr(startOfWeek(new Date(d.dia + "T12:00:00")));
      const cur = by.get(k) || { dia: k, ingresos: 0, gastos: 0 };
      cur.ingresos += d.ingresos; cur.gastos += d.gastos;
      by.set(k, cur);
    });
    puntos = [...by.values()].sort((a, b) => (a.dia < b.dia ? -1 : 1));
  }
  const prom = vizBarrasDobles($("dash-chart"), puntos.map((d) => ({
    clave: fechaCorta(d.dia), a: d.ingresos, b: d.gastos,
    titulo: `${fechaCorta(d.dia)}${agrupado ? " (semana)" : ""} — ingresos ${dmoney(d.ingresos)}, gastos ${dmoney(d.gastos)}`,
  })));
  $("dash-chart-legend").innerHTML = prom == null ? "" :
    `<span><i class="income"></i> Ingresos</span><span><i class="expense"></i> Gastos</span>` +
    `<span><i class="avg"></i> Promedio: ${dmoney(prom)} por ${agrupado ? "semana" : "día"}</span>`;

  // 3. Por día de la semana. Se saca de la misma serie, no hace falta pedir
  //    nada más al servidor.
  const semana = DIAS_SEMANA.map((n) => ({ clave: n, valor: 0, dias: 0 }));
  serie.forEach((d) => {
    const i = (new Date(d.dia + "T12:00:00").getDay() + 6) % 7;   // lunes = 0
    semana[i].valor += d.ingresos; semana[i].dias += 1;
  });
  vizBarras($("chart-semana"), semana.map((d) => ({
    clave: d.clave, valor: d.valor,
    titulo: `${d.clave}: ${dmoney(d.valor)} en ${d.dias} ${d.dias === 1 ? "día" : "días"}` +
            (d.dias ? ` (${dmoney(d.valor / d.dias)} por ${d.clave.toLowerCase()})` : ""),
  })), { etiquetaX: (d) => d.clave.slice(0, 3), aria: "ingresos por día de la semana",
         vacio: "Sin ventas en este periodo." });

  // 4. Por hora. Esta sí viene del servidor: las ventas guardan la hora exacta.
  const horas = new Map();
  DASH.results.forEach((r) => (r.por_hora || []).forEach((h) => {
    const cur = horas.get(h.hora) || { ventas: 0, ingresos: 0 };
    cur.ventas += Number(h.ventas || 0); cur.ingresos += Number(h.ingresos || 0);
    horas.set(h.hora, cur);
  }));
  // Solo de la primera a la última hora con movimiento: 24 barras, veinte de
  // ellas en cero, no dicen nada.
  const conVenta = [...horas.entries()].filter(([, v]) => v.ventas > 0).map(([h]) => h);
  const desde = conVenta.length ? Math.min(...conVenta) : 8;
  const hasta = conVenta.length ? Math.max(...conVenta) : 20;
  const serieHoras = [];
  for (let h = desde; h <= hasta; h++) {
    const v = horas.get(h) || { ventas: 0, ingresos: 0 };
    serieHoras.push({ clave: String(h), valor: v.ingresos,
      titulo: `${h}:00 a ${h}:59 — ${v.ventas} venta(s), ${dmoney(v.ingresos)}` });
  }
  vizBarras($("chart-hora"), serieHoras, {
    etiquetaX: (d) => `${d.clave}h`, aria: "ingresos por hora del día",
    vacio: "Sin ventas en este periodo.", maxEtiquetas: 14 });

  // 5. Toppings más vendidos, por peso.
  const agg = {};
  DASH.results.forEach((r) => (r.toppings || []).forEach((x) => {
    agg[x.name] = (agg[x.name] || 0) + Number(x.peso_g || 0);
  }));
  const tops = Object.entries(agg).map(([clave, valor]) => ({ clave, valor }))
                     .sort((a, b) => b.valor - a.valor);
  vizBarrasH($("chart-toppings"), tops, {
    formato: (v) => fmtWeightShort(v), aria: "toppings más vendidos",
    vacio: "No se vendieron toppings en este periodo." });

  // 6. Margen del día. null en los días sin ventas: dibujar 0% ahí sería
  //    mentir — no es que el margen se haya caído, es que no se vendió.
  vizLinea($("chart-margen"), serie.map((d) => ({
    clave: fechaCorta(d.dia),
    valor: d.ingresos > 0 ? r2((100 * d.margen) / d.ingresos) : null,
  })), { sufijo: "%", aria: "margen por día", vacio: "Hacen falta al menos dos días con ventas." });

  // 7. Gastos por categoría (resumen; el detalle vive en la pestaña Gastos).
  const cats = {};
  DASH.results.forEach((r) => (r.gastos_categoria || []).forEach((c) => {
    cats[c.categoria] = (cats[c.categoria] || 0) + Number(c.monto || 0);
  }));
  vizBarrasH($("chart-gastos-cat"),
    Object.entries(cats).map(([k, v]) => ({ clave: EXPENSE_LABELS[k] || k, valor: v }))
          .sort((a, b) => b.valor - a.valor),
    { color: "fill-bad", formato: (v) => dmoney(v), aria: "gastos por categoría",
      vacio: "No hay gastos registrados en este periodo." });
}

function fechaCorta(iso) { const p = iso.split("-"); return `${p[2]}/${p[1]}`; }

/* --- Comparativo por tienda ------------------------------------------------ */
function renderDashStores() {
  const card = $("dash-bystore-card");
  // Con una sola tienda a la vista, la tabla no compara nada.
  card.hidden = DASH.results.length < 2;
  const body = document.querySelector("#table-dash-stores tbody");
  body.innerHTML = "";
  DASH.results.forEach((r) => {
    const tr = document.createElement("tr");
    if (Number(r.utilidad) < 0) tr.classList.add("low-stock");
    tr.innerHTML = `<td>${esc(r.locationName)}</td>
      <td class="num">${r.ventas}</td>
      <td class="num">${dmoney(r.ingresos)}</td>
      <td class="num">${dmoney(r.costos)}</td>
      <td class="num">${dmoney(r.margen)} (${r.margen_pct}%)</td>
      <td class="num">${dmoney(r.gastos)}</td>
      <td class="num">${dmoney(r.utilidad)}</td>
      <td class="num">${dmoney(r.ticket_promedio)}</td>`;
    body.appendChild(tr);
  });
}

/* --- Proyección ------------------------------------------------------------
   Deliberadamente simple y explicada: promedio diario del periodo por los
   días que faltan del mes. No es un modelo; es una regla de tres. Decirlo es
   parte de la función: una proyección con 3 días de datos no vale nada, y la
   pantalla lo tiene que admitir en vez de mostrar un número con autoridad
   falsa. */
function renderDashProjection(serie, t) {
  const box = $("dash-projection"), note = $("dash-projection-note");
  const conVentas = serie.filter((d) => d.ventas > 0).length;

  if (!conVentas) {
    box.innerHTML = "";
    note.textContent = "Todavía no hay ventas en este periodo, así que no hay nada que proyectar.";
    return;
  }

  const nDias = Math.max(1, dashDayCount());
  const promDia = t.ingresos / nDias;
  const promGasto = t.gastos / nDias;

  const hoy = new Date();
  const finMes = endOfMonth(hoy).getDate();
  const diaHoy = hoy.getDate();
  const faltan = Math.max(0, finMes - diaHoy);

  // Lo que va del mes se pide aparte: el periodo que el usuario eligió puede
  // no ser el mes en curso (por ejemplo "semana pasada").
  const proyIngresos = promDia * finMes;
  const proyGastos   = promGasto * finMes;
  const proyUtilidad = proyIngresos - (t.ingresos > 0 ? (t.costos / t.ingresos) * proyIngresos : 0) - proyGastos;

  const kpi = (l, v, sub, cls) =>
    `<div class="kpi ${cls || ""}"><div class="kpi-label">${l}</div>
     <div class="kpi-value num">${v}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;

  box.innerHTML =
    kpi("Ingresos proyectados del mes", dmoney(proyIngresos), `a este ritmo, ${finMes} días`) +
    kpi("Gastos proyectados del mes", dmoney(proyGastos)) +
    kpi("Utilidad proyectada", dmoney(proyUtilidad), "", proyUtilidad >= 0 ? "good" : "bad") +
    kpi("Ritmo actual", dmoney(promDia), "por día") +
    kpi("Días que faltan del mes", faltan);

  const conf = conVentas >= 14 ? "" :
    ` ⚠ Está calculada con solo ${conVentas} día${conVentas === 1 ? "" : "s"} con ventas: tómala como una señal, no como un pronóstico. Con dos o tres semanas de historial empieza a ser confiable.`;
  note.textContent =
    `Método: promedio diario del periodo mostrado (${dmoney(promDia)}) multiplicado por los ${finMes} días del mes. ` +
    `No toma en cuenta fines de semana, feriados ni temporada.` + conf;
}

/* --- Gastos: en el tablero solo el resumen; la administración está en su
       propia pestaña, para no tener dos lugares donde editar lo mismo. ----- */
/* --- Rastro de auditoría ---------------------------------------------------
   Solo se muestra lo que la base dejó pasar. La cajera no llega aquí (no ve
   la pestaña) y aunque llegara, sus consultas volverían vacías. */
const AUDIT_TABLAS = {
  locations: "Sucursal", profiles: "Personal", flavors: "Sabor",
  toppings: "Topping", supplies: "Insumo", expenses: "Gasto", sales: "Venta", purchases: "Compra",
};
const AUDIT_ACCIONES = { INSERT: "Creó", UPDATE: "Cambió", DELETE: "Borró" };
// Campos que valen la pena en un resumen. El resto (fechas internas, ids)
// solo haría ruido.
const AUDIT_CAMPOS = {
  price_per_gram: "precio/g", margin_target_pct: "margen meta", cost_per_gram: "costo/g",
  cost_per_unit: "costo c/u", stock_grams: "stock", stock_qty: "stock",
  min_stock_grams: "stock mínimo", min_stock_qty: "stock mínimo",
  tier: "tier", surcharge_per_gram: "recargo/g", tare_weight_g: "tara",
  role: "rol", location_id: "sucursal", active: "activo", amount: "monto",
  name: "nombre", currency_code: "moneda", country_code: "país",
  default_weight_unit: "unidad", logo_data_url: "logo", category: "categoría",
  total_price: "total", description: "descripción", report_email: "correo",
  include_cup_weight_in_price: "cobra el vaso", legal_name: "razón social",
  tax_id_value: "identificación fiscal", address: "dirección", spent_on: "fecha",
  purchase_series: "serie de compras", supplier_name: "proveedor", supplier_invoice_no: "factura",
  exento: "exento", gravado15: "gravado 15%", gravado18: "gravado 18%", isv15: "ISV 15%", isv18: "ISV 18%", received_on: "entrada",
};

// Resume un evento en una frase legible: "costo/g: 0.06 → 0.02".
function auditResumen(ev) {
  const antes = ev.before || {}, despues = ev.after || {};
  if (ev.action === "DELETE") {
    // Una venta se identifica por su folio, no por un nombre entre comillas.
    const etiqueta = antes.folio != null ? `venta #${antes.folio}`
                   : (antes.name || antes.supplier_name || antes.description || antes.full_name);
    const monto = antes.total_price != null ? ` por ${dmoney(antes.total_price)}`
                : antes.supplier_name && antes.total != null ? ` por ${dmoney(antes.total)}`
                : antes.amount != null ? ` por ${dmoney(antes.amount)}` : "";
    return (etiqueta ? (antes.folio != null ? etiqueta : `"${etiqueta}"`) : "registro") + monto;
  }
  if (ev.action === "INSERT") {
    const etiqueta = despues.name || despues.supplier_name || despues.description || despues.full_name || "";
    const monto = despues.amount != null ? ` por ${dmoney(despues.amount)}`
                : despues.supplier_name && despues.total != null ? ` por ${dmoney(despues.total)}` : "";
    return (etiqueta ? `"${etiqueta}"` : "registro nuevo") + monto;
  }
  const partes = [];
  Object.keys(AUDIT_CAMPOS).forEach((k) => {
    if (!(k in despues)) return;
    const a = antes[k], b = despues[k];
    if (String(a) === String(b)) return;
    partes.push(`${AUDIT_CAMPOS[k]}: ${a === null || a === undefined || a === "" ? "—" : a} → ${b === null || b === undefined || b === "" ? "—" : b}`);
  });
  return partes.length ? partes.join(" · ") : "cambio menor";
}

function renderDashAudit() {
  const body = document.querySelector("#table-audit tbody");
  const nota = $("audit-note");
  const eventos = DASH.audit || [];
  body.innerHTML = eventos.length ? "" :
    '<tr><td colspan="5" class="hint">Sin cambios registrados en este periodo.</td></tr>';
  eventos.forEach((ev) => {
    const tr = document.createElement("tr");
    // Un borrado siempre merece una segunda mirada.
    if (ev.action === "DELETE") tr.classList.add("low-stock");
    const nombre = ev.actor_name || "(usuario desconocido)";
    tr.innerHTML = `<td>${esc(new Date(ev.at).toLocaleString())}</td>
      <td>${esc(nombre)}${ev.actor_role ? ` <span class="kpi-sub">${esc(ev.actor_role)}</span>` : ""}</td>
      <td>${esc(AUDIT_TABLAS[ev.table_name] || ev.table_name)}</td>
      <td>${esc(AUDIT_ACCIONES[ev.action] || ev.action)}</td>
      <td>${esc(auditResumen(ev))}</td>`;
    body.appendChild(tr);
  });
  const borrados = eventos.filter((e) => e.action === "DELETE").length;
  nota.textContent = eventos.length
    ? `${eventos.length} evento(s) en el periodo` + (borrados ? `, ${borrados} de ellos borrados (marcados en rojo).` : ".")
    : "";
}

/* --- Toppings del periodo -------------------------------------------------- */
function renderDashToppings() {
  const agg = {};
  DASH.results.forEach((r) => (r.toppings || []).forEach((t) => {
    const cur = agg[t.name] || { name: t.name, peso: 0, margen: 0 };
    cur.peso += Number(t.peso_g || 0);
    cur.margen += Number(t.margen || 0);
    agg[t.name] = cur;
  }));
  const total = Object.values(agg).reduce((a, b) => a + b.peso, 0);
  const rows = Object.values(agg).sort((a, b) => a.margen - b.margen);

  const body = document.querySelector("#table-dash-toppings tbody");
  body.innerHTML = rows.length ? "" :
    '<tr><td colspan="5" class="hint">No se vendieron toppings en este periodo.</td></tr>';
  const meta = Number((activeLocation() || {}).margin_target_pct || 0);
  rows.forEach((r) => {
    // margen % reconstruido desde el margen y el peso agregados de todas las
    // tiendas del alcance, para que el consolidado no mienta.
    const tr = document.createElement("tr");
    const pct = total > 0 ? r2((100 * r.peso) / total) : 0;
    tr.innerHTML = `<td>${esc(r.name)}</td>
      <td class="num">${fmtWeightShort(r.peso)}</td>
      <td class="num">${pct}%</td>
      <td class="num">${dmoney(r.margen)}</td>
      <td class="num">${r.peso > 0 ? r2(prefUnit() === "oz" ? (r.margen / toOz(r.peso)) : (r.margen / r.peso)) : 0} / ${prefUnit()}</td>`;
    if (meta && r.peso > 0 && r.margen <= 0) tr.classList.add("low-stock");
    body.appendChild(tr);
  });
}



/* ===========================================================================
   CLIENTES Y PROGRAMA DE PUNTOS
   ---------------------------------------------------------------------------
   Los clientes son de la marca (los puntos se canjean en cualquier tienda),
   pero los MOVIMIENTOS siguen aislados: cada gerente ve los de su sucursal.
   Eso lo hace cumplir la base; esta pantalla solo muestra lo que llega.

   El saldo nunca se edita aquí: no hay un campo para eso. Para mover puntos
   a mano está el ajuste, que exige razón y queda con nombre en el libro.
   =========================================================================== */
const CLI = { lista: [], sel: null, loaded: false };
const MOV_LABELS = { gana: "Ganó", canje: "Canjeó", ajuste: "Ajuste", vence: "Venció" };

// La dirección del carnet. Usa el mismo sitio en el que está abierta la caja,
// así no hay que configurarla en ningún lado.
function urlCarnet(codigo) {
  // Sin ".html": el servidor redirige carnet.html → carnet, y cada salto es
  // un toque más de espera en un teléfono con poca señal.
  return `${location.origin}${location.pathname.replace(/[^/]*$/, "")}carnet?c=${encodeURIComponent(codigo)}`;
}

async function cargarClientes(texto) {
  if (!canManage() || !navigator.onLine) return;
  let q = sb.from("customers")
            .select("id, card_code, full_name, phone, email, birth_date, points_balance, total_spent, visits, active, created_at")
            .order("full_name").limit(200);
  const t = (texto || "").trim();
  if (t) {
    const like = `%${t.replace(/[%,()]/g, "")}%`;
    q = q.or(`full_name.ilike.${like},phone.ilike.${like},card_code.ilike.${like}`);
  }
  const { data, error } = await q;
  if (error) { $("cli-count").textContent = `No se pudieron cargar: ${error.message}`; return; }
  CLI.lista = data || [];
  CLI.loaded = true;
  pintarClientes();
  pintarKpisFidelizacion();
}

function pintarClientes() {
  const body = document.querySelector("#table-clientes tbody");
  body.innerHTML = CLI.lista.length ? "" :
    '<tr><td colspan="6" class="hint">Todavía no hay clientes inscritos. Se inscriben desde la pantalla de Venta.</td></tr>';
  CLI.lista.forEach((c) => {
    const tr = document.createElement("tr");
    if (CLI.sel && CLI.sel.id === c.id) tr.classList.add("sel");
    tr.innerHTML = `<td>${esc(c.full_name)}${c.active ? "" : ' <span class="hint">(inactivo)</span>'}</td>
      <td>${esc(c.phone || "")}</td>
      <td><code>${esc(c.card_code)}</code></td>
      <td class="num"><strong>${esc(c.points_balance)}</strong></td>
      <td class="num">${esc(c.visits)}</td>
      <td class="num">${money(c.total_spent)}</td>`;
    tr.addEventListener("click", () => abrirCliente(c.id));
    body.appendChild(tr);
  });
  $("cli-count").textContent = CLI.lista.length ? `${CLI.lista.length} cliente(s)` : "";
}

function pintarKpisFidelizacion() {
  const cfg = reglasFidelizacion();
  const activos = CLI.lista.filter((c) => c.active);
  const saldo = activos.reduce((a, c) => a + Number(c.points_balance || 0), 0);
  const vp = cfg ? Number(cfg.valor_punto) : 0;
  const kpi = (l, v, sub) => `<div class="kpi"><div class="kpi-label">${l}</div>
    <div class="kpi-value num">${v}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  $("loy-kpis").innerHTML =
    kpi("Clientes inscritos", activos.length) +
    kpi("Puntos en circulación", saldo.toLocaleString("es")) +
    // Esto es una deuda: lo que la marca tendría que regalar en descuentos si
    // todos canjearan hoy. Conviene verlo crecer con calma.
    kpi("Valor de esos puntos", money(saldo * vp), "lo que se descontaría si todos canjean hoy") +
    kpi("Estado del programa", cfg ? (cfg.activo ? "Activo" : "Pausado") : "—",
        cfg ? `1 punto por cada ${money(cfg.monto_por_punto)} · cada punto vale ${money(cfg.valor_punto)}` : "");
}

async function abrirCliente(id) {
  const c = CLI.lista.find((x) => x.id === id);
  if (!c) return;
  CLI.sel = c;
  pintarClientes();
  const cfg = reglasFidelizacion();
  $("cli-detail").hidden = false;
  $("cli-d-name").textContent = c.full_name;
  $("cli-d-meta").textContent = `Carnet ${c.card_code} · inscrito el ${new Date(c.created_at).toLocaleDateString()} · ${c.visits} visita(s)`;
  $("cli-d-points").textContent = c.points_balance;
  $("cli-d-value").textContent = cfg ? `puntos · valen ${money(c.points_balance * Number(cfg.valor_punto))}` : "puntos";
  $("cli-e-name").value = c.full_name || "";
  $("cli-e-phone").value = c.phone || "";
  $("cli-e-email").value = c.email || "";
  $("cli-e-birth").value = c.birth_date || "";
  $("cli-e-active").checked = !!c.active;
  $("cli-d-link").value = urlCarnet(c.card_code);
  $("cli-e-msg").textContent = ""; $("cli-adj-msg").textContent = "";
  $("cli-adj-pts").value = ""; $("cli-adj-note").value = "";

  // Movimientos: la base solo devuelve los de las tiendas que este usuario
  // puede ver. Para una gerente, los de su sucursal.
  const { data } = await sb.from("loyalty_transactions")
    .select("created_at, kind, points, amount, note, location_id, locations(name)")
    .eq("customer_id", id).order("created_at", { ascending: false }).limit(100);
  const body = document.querySelector("#table-cli-hist tbody");
  const movs = data || [];
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
  $("cli-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("btn-cli-buscar").addEventListener("click", () => cargarClientes($("cli-q").value));
$("cli-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); cargarClientes($("cli-q").value); } });

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
  if (nombre.length < 2) { msg.textContent = "El nombre no puede quedar vacío."; return; }
  // El saldo, el gasto y las visitas no van aquí: la base no deja tocarlos
  // con un update directo, y la pantalla tampoco lo intenta.
  const { error } = await sb.from("customers").update({
    full_name: nombre,
    phone: $("cli-e-phone").value.trim() || null,
    email: $("cli-e-email").value.trim() || null,
    birth_date: $("cli-e-birth").value || null,
    active: $("cli-e-active").checked,
  }).eq("id", CLI.sel.id);
  if (error) { msg.textContent = `No se pudo guardar: ${error.message}`; return; }
  msg.textContent = "Guardado.";
  const id = CLI.sel.id;
  await cargarClientes($("cli-q").value);
  await abrirCliente(id);
});

$("btn-cli-ajustar").addEventListener("click", async () => {
  if (!CLI.sel) return;
  const msg = $("cli-adj-msg");
  const pts = parseInt($("cli-adj-pts").value, 10);
  const nota = $("cli-adj-note").value.trim();
  if (!pts) { msg.textContent = "Escribe cuántos puntos (positivo para dar, negativo para quitar)."; return; }
  if (!nota) { msg.textContent = "Escribe la razón: queda en el registro."; return; }
  if (!confirm(`¿${pts > 0 ? "Dar" : "Quitar"} ${Math.abs(pts)} puntos a ${CLI.sel.full_name}?\n\nRazón: ${nota}`)) return;
  const { error } = await sb.rpc("loyalty_ajustar", { p_customer_id: CLI.sel.id, p_puntos: pts, p_nota: nota });
  if (error) { msg.textContent = error.message; return; }
  const id = CLI.sel.id;
  await cargarClientes($("cli-q").value);
  await abrirCliente(id);
  $("cli-adj-msg").textContent = "Ajuste aplicado.";
});

/* --- Reglas (solo propietario) ------------------------------------------- */
function explicarReglas() {
  const mpp = parseFloat($("rule-mpp").value) || 0;
  const vp  = parseFloat($("rule-vp").value) || 0;
  const cmax = parseFloat($("rule-cmax").value) || 0;
  const cmin = parseInt($("rule-cmin").value, 10) || 0;
  const ejemplo = 100;
  const pts = mpp > 0 ? Math.floor(ejemplo / mpp) : 0;
  const retorno = mpp > 0 ? (vp / mpp) * 100 : 0;     // % que regresa al cliente
  $("rule-explain").className = "alert" + (retorno > 15 ? " warn" : "");
  $("rule-explain").innerHTML =
    `Por cada <strong>${money(mpp)}</strong> que gasta el cliente gana 1 punto, que vale <strong>${money(vp)}</strong>. ` +
    `Una compra de ${money(ejemplo)} da <strong>${pts} puntos</strong> (${money(pts * vp)}). ` +
    `O sea, le devuelves al cliente el <strong>${r2(retorno)}%</strong> de lo que gasta. ` +
    `Para canjear necesita ${cmin} puntos (${money(cmin * vp)}), y nunca más del ${cmax}% de una venta.` +
    (retorno > 15 ? `<br><strong>Ojo:</strong> devolver más del 15% se come buena parte del margen.` : "");
}
["rule-mpp", "rule-vp", "rule-cmax", "rule-cmin"].forEach((id) => $(id).addEventListener("input", explicarReglas));

function llenarReglas() {
  $("loy-rules-card").hidden = !isOwner();
  const cfg = reglasFidelizacion();
  if (!cfg || !isOwner()) return;
  if (document.activeElement && document.activeElement.closest("#loy-rules-card")) return;
  $("rule-activo").checked = !!cfg.activo;
  $("rule-mpp").value  = cfg.monto_por_punto;
  $("rule-vp").value   = cfg.valor_punto;
  $("rule-min").value  = cfg.compra_minima;
  $("rule-cmin").value = cfg.canje_minimo;
  $("rule-cmax").value = cfg.canje_max_pct;
  explicarReglas();
}

$("btn-rules-save").addEventListener("click", async () => {
  const msg = $("rule-msg");
  const nuevo = {
    activo: $("rule-activo").checked,
    monto_por_punto:   parseFloat($("rule-mpp").value) || 0,
    valor_punto:       parseFloat($("rule-vp").value) || 0,
    compra_minima:     parseFloat($("rule-min").value) || 0,
    canje_minimo:      parseInt($("rule-cmin").value, 10) || 0,
    canje_max_pct:     Math.min(100, Math.max(0, parseFloat($("rule-cmax").value) || 0)),
    actualizado_en:    new Date().toISOString(),
  };
  if (!(nuevo.monto_por_punto > 0)) { msg.textContent = "El monto para ganar un punto tiene que ser mayor a cero."; return; }
  if (!confirm("Las reglas nuevas aplican de inmediato en todas las tiendas. ¿Guardar?")) return;
  const { error } = await sb.from("loyalty_config").update(nuevo).eq("id", true);
  if (error) { msg.textContent = `No se pudo guardar: ${error.message}`; return; }
  await cargarReglasFidelizacion();
  msg.textContent = "Reglas guardadas.";
  pintarKpisFidelizacion();
  setTimeout(() => (msg.textContent = ""), 2500);
});

/* ===========================================================================
   CENTRO DE GASTOS
   ---------------------------------------------------------------------------
   Los gastos son la mitad que faltaba para saber si la tienda gana: el margen
   del producto no sirve de nada si la renta se lo come. Aquí se registran, se
   corrigen y se miran; el tablero solo muestra el resumen, para que no haya
   dos lugares donde editar lo mismo.

   La base es la que manda: una gerente solo ve y toca los de SU tienda, y una
   cajera no llega aquí. Eso no depende de esta pantalla.
   =========================================================================== */
const GAS = { rows: [], from: null, to: null, loaded: false };

function gasRange() {
  const hoy = new Date();
  switch ($("gas-range").value) {
    case "semana":      return { from: startOfWeek(hoy), to: hoy };
    case "mes":         return { from: startOfMonth(hoy), to: hoy };
    case "mes_pasado":  { const i = startOfMonth(addDays(startOfMonth(hoy), -1)); return { from: i, to: endOfMonth(i) }; }
    case "30d":         return { from: addDays(hoy, -29), to: hoy };
    case "90d":         return { from: addDays(hoy, -89), to: hoy };
    case "anio":        return { from: new Date(hoy.getFullYear(), 0, 1), to: hoy };
    default: {
      const f = $("gas-from").value, t = $("gas-to").value;
      return { from: f ? new Date(f + "T12:00:00") : startOfMonth(hoy),
               to:   t ? new Date(t + "T12:00:00") : hoy };
    }
  }
}

function gasScopeIds() {
  if (!isOwner()) return [STATE.profile.location_id];
  const v = $("gas-location").value;
  return v === "__all__" ? STATE.locations.filter((l) => l.active).map((l) => l.id) : [v];
}
// El gasto se registra en la tienda seleccionada; en el consolidado, en la que
// el usuario tenga abierta. El texto de abajo del formulario siempre lo dice.
function gasTargetId() {
  const ids = gasScopeIds();
  return ids.length === 1 ? ids[0] : STATE.activeLocationId;
}
function gasCurrency() {
  const loc = STATE.locations.find((l) => l.id === gasScopeIds()[0]);
  return (loc && loc.currency_code) || "";
}
function gmoney(v) { return `${gasCurrency()} ${(Number(v) || 0).toFixed(2)}`; }

function llenarSelectoresGastos() {
  const sel = $("gas-location"), keep = sel.value;
  sel.innerHTML = "";
  if (isOwner()) {
    sel.innerHTML = '<option value="__all__">Todas las tiendas</option>';
    STATE.locations.forEach((l) => {
      const o = document.createElement("option"); o.value = l.id; o.textContent = l.name; sel.appendChild(o);
    });
    sel.value = keep || "__all__";
  } else {
    const loc = activeLocation();
    const o = document.createElement("option");
    o.value = STATE.profile.location_id; o.textContent = loc ? loc.name : "Mi tienda";
    sel.appendChild(o);
  }
  sel.disabled = !isOwner();

  const cats = Object.entries(EXPENSE_LABELS);
  const f = $("gas-cat-filter"), keepF = f.value;
  f.innerHTML = '<option value="">Todas las categorías</option>' +
    cats.map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("");
  f.value = keepF || "";
  const n = $("ng-cat"), keepN = n.value;
  n.innerHTML = cats.map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("");
  n.value = keepN || "renta";
  if (!$("ng-date").value) $("ng-date").value = localDateStr();
}

$("gas-range").addEventListener("change", () => {
  const c = $("gas-range").value === "personalizado";
  $("gas-custom-from").hidden = !c; $("gas-custom-to").hidden = !c;
  if (!c) cargarGastos();
});
["gas-location", "gas-cat-filter"].forEach((id) => $(id).addEventListener("change", cargarGastos));
["gas-from", "gas-to"].forEach((id) => $(id).addEventListener("change", () => {
  if ($("gas-range").value === "personalizado") cargarGastos();
}));
$("btn-gas-refresh").addEventListener("click", cargarGastos);

async function cargarGastos() {
  if (!canManage()) return;
  const avisos = $("gas-warnings");
  if (!navigator.onLine) {
    avisos.innerHTML = '<div class="alert warn">Sin conexión: los gastos necesitan internet. La pantalla de venta sí sigue funcionando.</div>';
    return;
  }
  const { from, to } = gasRange();
  if (from > to) { avisos.innerHTML = '<div class="alert bad">La fecha "desde" es posterior a la fecha "hasta".</div>'; return; }
  GAS.from = localDateStr(from); GAS.to = localDateStr(to);

  const ids = gasScopeIds().filter(Boolean);
  let q = sb.from("expenses").select("*, locations(name)")
            .gte("spent_on", GAS.from).lte("spent_on", GAS.to)
            .order("spent_on", { ascending: false }).limit(500);
  if (ids.length === 1) q = q.eq("location_id", ids[0]);
  const cat = $("gas-cat-filter").value;
  if (cat) q = q.eq("category", cat);

  const { data, error } = await q;
  if (error) { avisos.innerHTML = `<div class="alert bad">No se pudieron cargar: ${esc(error.message)}</div>`; return; }
  GAS.rows = data || [];

  // Quién registró cada gasto: se resuelve con los perfiles que ya tenemos,
  // y solo el propietario los carga. Para una gerente queda en blanco, que es
  // correcto: ella no tiene por qué ver el directorio completo del personal.
  GAS.loaded = true;
  avisos.innerHTML = "";
  renderGastos();
}

function renderGastos() {
  const ids = gasScopeIds();
  const nombre = ids.length > 1 ? "Todas las tiendas"
               : (STATE.locations.find((l) => l.id === ids[0]) || {}).name || "";
  const fmt = (iso) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
  const dias = Math.round((new Date(GAS.to + "T12:00:00") - new Date(GAS.from + "T12:00:00")) / 86400000) + 1;
  $("gas-range-label").textContent = `Mostrando ${nombre} — del ${fmt(GAS.from)} al ${fmt(GAS.to)} (${dias} día${dias === 1 ? "" : "s"}).`;
  $("gas-print-head").innerHTML = logoHtml() + `<strong>${esc(nombre)}</strong> — gastos del ${fmt(GAS.from)} al ${fmt(GAS.to)}`;

  const total = GAS.rows.reduce((a, g) => a + Number(g.amount || 0), 0);
  const porCat = {};
  GAS.rows.forEach((g) => { porCat[g.category] = (porCat[g.category] || 0) + Number(g.amount || 0); });
  const cats = Object.entries(porCat).sort((a, b) => b[1] - a[1]);
  const mayor = cats[0];

  const kpi = (l, v, sub) => `<div class="kpi"><div class="kpi-label">${l}</div>
    <div class="kpi-value num">${v}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  $("gas-kpis").innerHTML =
    kpi("Total del periodo", gmoney(total), `${GAS.rows.length} registro(s)`) +
    kpi("Promedio diario", gmoney(dias ? total / dias : 0), `sobre ${dias} día${dias === 1 ? "" : "s"}`) +
    kpi("Proyección al mes", gmoney(dias ? (total / dias) * 30 : 0), "a este ritmo, 30 días") +
    (mayor ? kpi("Mayor categoría", esc(EXPENSE_LABELS[mayor[0]] || mayor[0]),
                 `${gmoney(mayor[1])} · ${total > 0 ? r2((100 * mayor[1]) / total) : 0}% del total`) : "");

  vizBarrasH($("gas-chart-cat"),
    cats.map(([k, v]) => ({ clave: EXPENSE_LABELS[k] || k, valor: v,
      titulo: `${EXPENSE_LABELS[k] || k}: ${gmoney(v)} (${total > 0 ? r2((100 * v) / total) : 0}% del total)` })),
    { color: "fill-bad", formato: (v) => gmoney(v), aria: "gastos por categoría",
      vacio: "No hay gastos registrados en este periodo." });

  // Un día por barra, con los días sin gasto en cero: si se saltaran, el
  // gráfico daría la impresión de que se gasta todos los días.
  const porDia = new Map();
  for (let d = new Date(GAS.from + "T12:00:00"); localDateStr(d) <= GAS.to; d = addDays(d, 1)) {
    porDia.set(localDateStr(d), 0);
  }
  GAS.rows.forEach((g) => { if (porDia.has(g.spent_on)) porDia.set(g.spent_on, porDia.get(g.spent_on) + Number(g.amount || 0)); });
  const serieDias = [...porDia.entries()].map(([dia, v]) => ({
    clave: fechaCorta(dia), valor: v, titulo: `${fechaCorta(dia)}: ${gmoney(v)}` }));
  vizBarras($("gas-chart-tiempo"), serieDias,
    { color: "fill-bad", aria: "gastos por día", vacio: "No hay gastos registrados en este periodo." });

  const tLoc = STATE.locations.find((l) => l.id === gasTargetId());
  $("ng-target").textContent = tLoc
    ? (ids.length === 1 ? `Se registrará en ${tLoc.name}.`
       : `Estás viendo todas las tiendas: se registrará en ${tLoc.name}. Si es de otra, selecciónala arriba primero.`)
    : "Selecciona una tienda arriba.";

  renderTablaGastos();
  $("gas-total-hint").textContent = GAS.rows.length
    ? `${GAS.rows.length} gasto(s), ${gmoney(total)} en total.` : "";
}

function renderTablaGastos() {
  const body = document.querySelector("#table-gastos tbody");
  body.innerHTML = GAS.rows.length ? "" :
    '<tr><td colspan="7" class="hint">Sin gastos en este periodo. Regístralos arriba.</td></tr>';
  const quien = (id) => (STATE.profiles.find((x) => x.id === id) || {}).full_name || "";

  GAS.rows.forEach((g) => {
    const tr = document.createElement("tr");
    const opciones = Object.entries(EXPENSE_LABELS)
      .map(([k, v]) => `<option value="${esc(k)}"${g.category === k ? " selected" : ""}>${esc(v)}</option>`).join("");
    tr.innerHTML = `
      <td><input type="date" value="${esc(g.spent_on)}" data-field="spent_on"></td>
      <td>${esc((g.locations && g.locations.name) || "")}</td>
      <td><select data-field="category">${opciones}</select></td>
      <td><input type="text" value="${esc(g.description || "")}" data-field="description"></td>
      <td><input type="number" step="0.01" min="0" value="${esc(g.amount)}" data-field="amount"></td>
      <td>${esc(quien(g.created_by))}</td>
      <td>${rowActionsHtml()}</td>`;

    tr.querySelector(".btn-save").addEventListener("click", async () => {
      const monto = parseFloat(tr.querySelector('[data-field="amount"]').value);
      if (!(monto >= 0)) { alert("El monto no puede ser negativo."); return; }
      const { error } = await sb.from("expenses").update({
        spent_on: tr.querySelector('[data-field="spent_on"]').value,
        category: tr.querySelector('[data-field="category"]').value,
        description: tr.querySelector('[data-field="description"]').value.trim() || null,
        amount: monto,
      }).eq("id", g.id);
      if (error) { alert(`No se pudo guardar: ${error.message}`); return; }
      await cargarGastos();
      if (DASH.loaded) await loadDashboard();
    });

    tr.querySelector(".btn-del").addEventListener("click", async () => {
      if (!confirm(`¿Eliminar el gasto de ${gmoney(g.amount)}${g.description ? ` (${g.description})` : ""}?\n\nQueda registrado en el rastro de auditoría.`)) return;
      const { error } = await sb.from("expenses").delete().eq("id", g.id);
      if (error) { alert(`No se pudo eliminar: ${error.message}`); return; }
      await cargarGastos();
      if (DASH.loaded) await loadDashboard();
    });
    body.appendChild(tr);
  });
}

$("btn-ng-add").addEventListener("click", async () => {
  const msg = $("ng-msg");
  const monto = parseFloat($("ng-amount").value);
  if (!(monto > 0)) { msg.textContent = "Pon un monto mayor a cero."; return; }
  const destino = gasTargetId();
  if (!destino) { msg.textContent = "No hay una tienda seleccionada."; return; }
  if (!navigator.onLine) { msg.textContent = "Sin conexión: registrar un gasto necesita internet."; return; }

  const btn = $("btn-ng-add"); btn.disabled = true;
  // created_by NO se manda: lo pone el servidor con quien está dentro, para
  // que nadie pueda firmar un gasto a nombre de otra persona.
  const { error } = await sb.from("expenses").insert({
    location_id: destino,
    spent_on: $("ng-date").value || localDateStr(),
    category: $("ng-cat").value,
    description: $("ng-desc").value.trim() || null,
    amount: monto,
  });
  btn.disabled = false;
  if (error) { msg.textContent = `No se pudo registrar: ${error.message}`; return; }
  msg.textContent = "Gasto registrado.";
  $("ng-desc").value = ""; $("ng-amount").value = "";
  await cargarGastos();
  if (DASH.loaded) await loadDashboard();
  setTimeout(() => (msg.textContent = ""), 2500);
});

/* ===========================================================================
   LIBRO DE COMPRAS
   ---------------------------------------------------------------------------
   Las facturas de proveedores, con las series del negocio (CTG, CTH y la de
   cada tienda), para sacar el libro de compras igual que en ICG Manager.

   La base manda (sql/12): la gerente ve y registra solo las de SU tienda; la
   propietaria, todas, incluidas las de oficina/bodega central (sin tienda).
   La cajera no llega aquí. Quién registró cada compra lo pone el servidor.
   =========================================================================== */
const CMP = { rows: [], loaded: false };
const CMP_CENTRAL = "__central__";

function serieCompra(c) {
  if (c.compra === "gasto") return "CTG";
  if (c.compra === "materia_bodega") return "CTH";
  const loc = STATE.locations.find((l) => l.id === c.location_id);
  return (loc && loc.purchase_series) || "SIN SERIE";
}
function cmoney(v) {
  const loc = STATE.locations.find((l) => l.id === STATE.activeLocationId) || STATE.locations[0];
  return `${(loc && loc.currency_code) || ""} ${(Number(v) || 0).toLocaleString("es-HN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function prepararCompras() {
  const opciones = (conCentral, conTodas) => {
    if (!isOwner()) {
      const loc = activeLocation();
      return `<option value="${esc(STATE.profile.location_id)}">${esc(loc ? loc.name : "Mi tienda")}</option>`;
    }
    return (conTodas ? '<option value="__all__">Todas</option>' : "") +
      STATE.locations.filter((l) => l.active).map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("") +
      (conCentral ? `<option value="${CMP_CENTRAL}">Oficina / bodega central</option>` : "");
  };
  ["cmp-location", "nc-location"].forEach((id) => {
    const sel = $(id), keep = sel.value;
    sel.innerHTML = opciones(true, id === "cmp-location");
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
    sel.disabled = !isOwner();
  });
  if (!$("cmp-from").value) {
    const hoy = new Date();
    $("cmp-from").value = localDateStr(startOfMonth(hoy));
    $("cmp-to").value = localDateStr(hoy);
  }
  if (!$("nc-received").value) $("nc-received").value = localDateStr();
  if (!$("nc-invoice-date").value) $("nc-invoice-date").value = localDateStr();
  ajustarTipoCompra();
}

// La materia prima "de la tienda" tiene que ser de una tienda: si se elige
// oficina/bodega central, no se ofrece.
function ajustarTipoCompra() {
  const central = $("nc-location").value === CMP_CENTRAL;
  const opt = $("nc-tipo").querySelector('option[value="materia_tienda"]');
  opt.disabled = central;
  if (central && $("nc-tipo").value === "materia_tienda") $("nc-tipo").value = "materia_bodega";
  const loc = STATE.locations.find((l) => l.id === $("nc-location").value);
  opt.textContent = `Materia prima comprada por la tienda${loc && loc.purchase_series ? ` (${loc.purchase_series})` : ""}`;
}
$("nc-location").addEventListener("change", ajustarTipoCompra);

// El ISV se propone solo mientras nadie lo haya tocado a mano.
["15", "18"].forEach((t) => {
  const g = $("nc-g" + t), i = $("nc-isv" + t);
  g.addEventListener("input", () => {
    if (i.dataset.mano === "1") return;
    const v = parseFloat(g.value);
    i.value = v > 0 ? (Math.round(v * Number(t)) / 100).toFixed(2) : "";
    totalCompra();
  });
  i.addEventListener("input", () => { i.dataset.mano = "1"; totalCompra(); });
});
["nc-exento", "nc-desc-monto"].forEach((id) => $(id).addEventListener("input", totalCompra));
function montoCompra(id) { const v = parseFloat($(id).value); return v > 0 ? Math.round(v * 100) / 100 : 0; }
function totalCompra() {
  const t = ["nc-exento", "nc-g15", "nc-g18", "nc-isv15", "nc-isv18"].reduce((a, id) => a + montoCompra(id), 0);
  $("nc-total").textContent = t > 0 ? `Total: ${cmoney(t)}` : "";
  return Math.round(t * 100) / 100;
}

["cmp-location", "cmp-from", "cmp-to"].forEach((id) => $(id).addEventListener("change", cargarCompras));
$("btn-cmp-refresh").addEventListener("click", cargarCompras);

async function comprasDelRango() {
  const todas = [];
  const loc = $("cmp-location").value;
  for (let pag = 0; ; pag++) {
    let q = sb.from("purchases").select("*")
      .gte("received_on", $("cmp-from").value).lte("received_on", $("cmp-to").value)
      .order("received_on", { ascending: false }).order("numero", { ascending: false })
      .range(pag * 1000, pag * 1000 + 999);
    if (loc === CMP_CENTRAL) q = q.is("location_id", null);
    else if (loc !== "__all__") q = q.eq("location_id", loc);
    const { data, error } = await q;
    if (error) throw error;
    todas.push(...(data || []));
    if (!data || data.length < 1000) return todas;
  }
}

async function cargarCompras() {
  if (!canManage()) return;
  const avisos = $("cmp-warnings");
  if (!navigator.onLine) { avisos.innerHTML = '<div class="alert warn">Sin conexión: las compras necesitan internet.</div>'; return; }
  if ($("cmp-from").value > $("cmp-to").value) { avisos.innerHTML = '<div class="alert bad">La fecha "desde" es posterior a la fecha "hasta".</div>'; return; }
  try {
    CMP.rows = await comprasDelRango();
  } catch (e) {
    console.error(e);
    avisos.innerHTML = '<div class="alert bad">No se pudieron cargar las compras. Si sigue pasando, avísale a soporte técnico.</div>';
    return;
  }
  CMP.loaded = true;
  const sinSerie = CMP.rows.some((c) => c.compra === "materia_tienda" && serieCompra(c) === "SIN SERIE");
  avisos.innerHTML = sinSerie
    ? '<div class="alert warn">Hay compras de una tienda que todavía no tiene serie de compras (por ejemplo 011C). Ponla en Configuración para que el libro salga con su serie.</div>'
    : "";
  renderCompras();
}

function renderCompras() {
  const suma = (k) => CMP.rows.reduce((a, c) => a + Number(c[k] || 0), 0);
  const porSerie = {};
  CMP.rows.forEach((c) => { const k = serieCompra(c); porSerie[k] = (porSerie[k] || 0) + Number(c.total || 0); });
  const kpi = (l, v, sub) => `<div class="kpi"><div class="kpi-label">${esc(l)}</div><div class="kpi-value num">${v}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  $("cmp-kpis").innerHTML =
    kpi("Total del periodo", cmoney(suma("total")), `${CMP.rows.length} factura(s)`) +
    kpi("ISV pagado", cmoney(suma("isv15") + suma("isv18")), "crédito fiscal") +
    Object.entries(porSerie).sort((a, b) => b[1] - a[1]).map(([k, v]) => kpi(`Serie ${k}`, cmoney(v))).join("");

  const body = document.querySelector("#table-compras tbody");
  body.innerHTML = CMP.rows.length ? "" : '<tr><td colspan="9" class="hint">No hay compras registradas en estas fechas.</td></tr>';
  const fmt = (iso) => { const [y, m, d] = String(iso).split("-"); return `${d}/${m}/${y}`; };
  CMP.rows.forEach((c) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(fmt(c.received_on))}</td><td>${esc(serieCompra(c))}</td>
      <td>${esc(c.supplier_name)}${c.description ? `<div class="hint">${esc(c.description)}</div>` : ""}</td>
      <td>${esc(c.supplier_invoice_no || "—")}</td>
      <td class="num">${cmoney(c.exento)}</td><td class="num">${cmoney(Number(c.gravado15) + Number(c.gravado18))}</td>
      <td class="num">${cmoney(Number(c.isv15) + Number(c.isv18))}</td><td class="num">${cmoney(c.total)}</td>
      <td><div class="row-actions"><button class="icon-btn delete btn-del" type="button" title="Eliminar">${ICON_TRASH}</button></div></td>`;
    tr.querySelector(".btn-del").addEventListener("click", async () => {
      if (!confirm(`¿Eliminar la factura ${c.supplier_invoice_no || ""} de ${c.supplier_name}? Queda registrado en el rastro de cambios.`)) return;
      const { error } = await sb.from("purchases").delete().eq("id", c.id);
      if (error) { alert("No se pudo eliminar. Si sigue pasando, avísale a soporte técnico."); return; }
      await cargarCompras();
    });
    body.appendChild(tr);
  });
}

$("btn-nc-add").addEventListener("click", async () => {
  const msg = (t, ok) => { $("nc-msg").innerHTML = t ? `<div class="alert ${ok ? "ok" : "warn"}">${esc(t)}</div>` : ""; };
  const proveedor = $("nc-supplier").value.trim();
  const rtn = $("nc-rtn").value.replace(/\D/g, "");
  const destino = $("nc-location").value;
  const tipo = $("nc-tipo").value;
  if (!proveedor) { msg("Escribe el nombre del proveedor."); return; }
  if (rtn && rtn.length !== 14) { msg("El RTN lleva 14 dígitos."); return; }
  if (!(totalCompra() > 0)) { msg("Pon el importe de la factura."); return; }
  if (tipo === "materia_tienda" && destino === CMP_CENTRAL) { msg("La materia prima comprada por una tienda tiene que ser de una tienda."); return; }
  if (!navigator.onLine) { msg("Sin conexión: registrar una compra necesita internet."); return; }
  const btn = $("btn-nc-add"); btn.disabled = true;
  // created_by NO se manda: lo pone el servidor con quien está dentro.
  const { error } = await sb.from("purchases").insert({
    location_id: destino === CMP_CENTRAL ? null : destino,
    compra: tipo,
    received_on: $("nc-received").value || localDateStr(),
    invoice_date: $("nc-invoice-date").value || $("nc-received").value || localDateStr(),
    supplier_name: proveedor,
    supplier_rtn: rtn || null,
    supplier_code: $("nc-code").value.trim() || null,
    supplier_invoice_no: $("nc-invoice").value.trim() || null,
    supplier_cai: $("nc-cai").value.trim() || null,
    description: $("nc-desc").value.trim() || null,
    exento: montoCompra("nc-exento"), gravado15: montoCompra("nc-g15"), gravado18: montoCompra("nc-g18"),
    isv15: montoCompra("nc-isv15"), isv18: montoCompra("nc-isv18"), descuento: montoCompra("nc-desc-monto"),
  });
  btn.disabled = false;
  if (error) {
    msg(/uq_purchases_factura|duplicate/i.test(error.message || "")
      ? "Esa factura de ese proveedor ya está registrada."
      : "No se pudo registrar la compra. Revisa los datos; si sigue pasando, avísale a soporte técnico.");
    return;
  }
  msg("Compra registrada.", true);
  ["nc-supplier", "nc-rtn", "nc-code", "nc-invoice", "nc-cai", "nc-desc", "nc-exento", "nc-g15", "nc-g18", "nc-isv15", "nc-isv18", "nc-desc-monto"]
    .forEach((id) => { $(id).value = ""; delete $(id).dataset.mano; });
  totalCompra();
  await cargarCompras();
  setTimeout(() => msg(""), 2500);
});

$("btn-cmp-download").addEventListener("click", async () => {
  const avisos = $("cmp-warnings");
  if (!navigator.onLine) { avisos.innerHTML = '<div class="alert warn">Para sacar el libro hace falta conexión a internet.</div>'; return; }
  const btn = $("btn-cmp-download"); btn.disabled = true;
  try {
    const compras = await comprasDelRango();
    const loc = $("cmp-location");
    const quien = loc.options[loc.selectedIndex] ? loc.options[loc.selectedIndex].textContent : "";
    const fmt = (iso) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
    const h = LibroVentas.hojaCompras({
      titulo: `LIBRO DE COMPRAS — ${quien} — del ${fmt($("cmp-from").value)} al ${fmt($("cmp-to").value)}`,
      compras, serie: serieCompra,
    });
    const bytes = LibroVentas.crearXlsx([{ nombre: "Libro de compras", ...h }]);
    const nombre = `libro-compras_${quien}_${$("cmp-from").value}_${$("cmp-to").value}.xlsx`.replace(/[^\w.-]+/g, "-");
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = document.createElement("a"); a.href = url; a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    console.error(e);
    avisos.innerHTML = '<div class="alert bad">No se pudo sacar el libro de compras. Si sigue pasando, avísale a soporte técnico.</div>';
  } finally { btn.disabled = false; }
});

/* ===========================================================================
   16. INSTALACION EN EL DISPOSITIVO (service worker)
   ---------------------------------------------------------------------------
   Guarda los archivos de la aplicacion en la tableta para que abra aunque no
   haya internet. Antes, el catalogo y las ventas pendientes ya se guardaban,
   pero los archivos no: recargar la pagina sin señal dejaba la caja parada.
   Necesita HTTPS (o localhost); abierto con doble clic (file://) no se registra
   y la aplicacion sigue funcionando igual, solo que sin modo offline.
   =========================================================================== */
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => {
      console.warn("No se pudo instalar el modo sin conexion:", e.message);
    });
  });
}

/* ===========================================================================
   17. ARRANQUE
   =========================================================================== */
(async function init() {
  if (!sb) { showLogin(); return; }
  loadPending();
  updateConnBadge();
  const { data: { session } } = await sb.auth.getSession();
  if (session) await startSession();
  else showLogin();
})();
