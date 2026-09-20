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
     7. Báscula (Web Serial)
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
const ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>';
const ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';

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

let sb = null;
if (CONFIGURED) {
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
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
  flavors: [], toppings: [], supplies: [], sales: [], profiles: [],
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

window.addEventListener("online", () => { updateConnBadge(); syncPending(); });
window.addEventListener("offline", updateConnBadge);
setInterval(() => { if (navigator.onLine && STATE.pending.length) syncPending(); }, 60000);

/* ===========================================================================
   4. MOTOR DE PRECIOS Y COSTOS
   ---------------------------------------------------------------------------
   Al cliente se le cobra un precio único por gramo del total (vaso + helado +
   toppings). Internamente se calcula el costo real de cada componente, porque
   no todos los toppings cuestan lo mismo. Los toppings "tier 2" llevan un
   recargo por gramo para que no se coman el margen.
   =========================================================================== */
function computeSale({ pricePerGram, includeCupWeight, iceCream, toppings, cup, spoon, marginTargetPct }) {
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
    const [fl, tp, sp] = await Promise.all([
      sb.from("flavors").select("*").eq("location_id", locId).eq("active", true).order("name"),
      sb.from("toppings").select("*").eq("location_id", locId).eq("active", true).order("name"),
      sb.from("supplies").select("*").eq("location_id", locId).eq("active", true).order("name"),
    ]);
    STATE.flavors = fl.data || [];
    STATE.toppings = tp.data || [];
    STATE.supplies = sp.data || [];

    let salesQuery = sb.from("sales").select("*, locations(name)").order("created_at", { ascending: false }).limit(200);
    if (!isOwner()) salesQuery = salesQuery.eq("location_id", locId);
    const { data: sales } = await salesQuery;
    STATE.sales = sales || [];

    if (isOwner()) {
      const { data: profiles } = await sb.from("profiles").select("*").order("full_name");
      STATE.profiles = profiles || [];
    }

    cacheCatalog();
  } catch (e) {
    console.error("No se pudo cargar del servidor, usando copia local:", e);
    loadFromCache();
  }
  renderAll();
}

function cacheCatalog() {
  lsSet(LS.catalog(STATE.activeLocationId), {
    location: activeLocation(),
    flavors: STATE.flavors, toppings: STATE.toppings, supplies: STATE.supplies,
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
}

function renderAll() {
  const loc = activeLocation();
  $("location-tag").textContent = loc ? loc.name : "Sin sucursal";
  fillSaleSelectors();
  renderToppingChips();
  renderOrderRows();
  renderQuote();
  if (canManage()) {
    renderInventory();
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
  });
});

/* ===========================================================================
   8. VENTA
   =========================================================================== */
let iceUnit = "g", cupUnit = "g", totalUnit = "g";
const orderRows = [];

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
wireUnitToggle("unit-ice",   () => iceUnit,   (u) => (iceUnit = u),   "inp-ice-weight");
wireUnitToggle("unit-cup",   () => cupUnit,   (u) => (cupUnit = u),   "inp-cup-weight");
wireUnitToggle("unit-total", () => totalUnit, (u) => (totalUnit = u), "inp-total-weight");

function fillSaleSelectors() {
  const cupSel = $("sel-cup"), spoonSel = $("sel-spoon"), flavorSel = $("sel-flavor");
  const keep = { cup: cupSel.value, spoon: spoonSel.value, flavor: flavorSel.value };

  cupSel.innerHTML = ""; spoonSel.innerHTML = ""; flavorSel.innerHTML = "";
  STATE.supplies.filter((s) => s.kind === "vaso").forEach((s) => {
    const o = document.createElement("option");
    o.value = s.id; o.textContent = `${s.name} (tara ${s.tare_weight_g}g)`;
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
  prefillCupWeight();
}

// Pone los tres campos de peso en la unidad que eligió la tienda. Solo actúa
// cuando la unidad cambió: si la cajera ya movió un botón a mano en plena
// venta, no se lo pisamos.
let unidadAplicada = null;
function aplicarUnidadPreferida() {
  const u = prefUnit();
  if (u === unidadAplicada) return;
  unidadAplicada = u;
  iceUnit = u; cupUnit = u; totalUnit = u;
  markUnitButtons("unit-ice", u);
  markUnitButtons("unit-cup", u);
  markUnitButtons("unit-total", u);
  $("inp-cup-weight").dataset.auto = "1";
}

function prefillCupWeight() {
  const cup = STATE.supplies.find((s) => s.id === $("sel-cup").value);
  const input = $("inp-cup-weight");
  if (cup && (!input.value || input.dataset.auto === "1")) {
    input.value = cupUnit === "oz" ? r2(toOz(cup.tare_weight_g)) : cup.tare_weight_g;
    input.dataset.auto = "1";
  }
}
$("inp-cup-weight").addEventListener("input", function () { this.dataset.auto = "0"; renderQuote(); });
$("sel-cup").addEventListener("change", () => { $("inp-cup-weight").dataset.auto = "1"; prefillCupWeight(); renderQuote(); });
["inp-ice-weight", "inp-total-weight"].forEach((id) => $(id).addEventListener("input", renderQuote));
["sel-flavor", "sel-spoon", "chk-spoon"].forEach((id) => $(id).addEventListener("change", renderQuote));

function renderToppingChips() {
  const wrap = $("topping-chips");
  wrap.innerHTML = "";
  STATE.toppings.forEach((t) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (t.tier === 2 ? " tier2" : "");
    chip.innerHTML = `${esc(t.name)}<span class="chip-cat">${esc(t.category)}</span>`;
    chip.addEventListener("click", () => {
      orderRows.push({ rowId: "r" + Date.now() + Math.random(), toppingId: t.id, weight: 0, unit: prefUnit() });
      renderOrderRows(); renderQuote();
    });
    wrap.appendChild(chip);
  });
}

function renderOrderRows() {
  const wrap = $("order-rows");
  wrap.innerHTML = "";
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
    select.addEventListener("change", () => { row.toppingId = select.value; renderQuote(); });

    const weightInput = document.createElement("input");
    weightInput.type = "number"; weightInput.min = "0"; weightInput.step = "0.1";
    weightInput.placeholder = "peso"; weightInput.value = row.weight || "";
    weightInput.addEventListener("input", () => { row.weight = parseFloat(weightInput.value) || 0; renderQuote(); });

    const unitSel = document.createElement("select");
    ["g", "oz"].forEach((u) => {
      const o = document.createElement("option");
      o.value = u; o.textContent = u; if (u === row.unit) o.selected = true;
      unitSel.appendChild(o);
    });
    unitSel.addEventListener("change", () => { row.unit = unitSel.value; renderQuote(); });

    const removeBtn = document.createElement("button");
    removeBtn.className = "row-remove"; removeBtn.textContent = "✕"; removeBtn.type = "button";
    removeBtn.addEventListener("click", () => {
      const i = orderRows.indexOf(row);
      if (i >= 0) orderRows.splice(i, 1);
      renderOrderRows(); renderQuote();
    });

    div.append(select, weightInput, unitSel, removeBtn);
    wrap.appendChild(div);
  });
}

function buildPlan() {
  const loc = activeLocation();
  if (!loc) return null;
  const flavor = STATE.flavors.find((f) => f.id === $("sel-flavor").value);
  const cupRow = STATE.supplies.find((s) => s.id === $("sel-cup").value);
  const spoonRow = $("chk-spoon").checked ? STATE.supplies.find((s) => s.id === $("sel-spoon").value) : null;
  if (!flavor || !cupRow) return null;

  const cupWeightG = toGrams(parseFloat($("inp-cup-weight").value) || 0, cupUnit);
  const iceWeightG = toGrams(parseFloat($("inp-ice-weight").value) || 0, iceUnit);

  const toppings = orderRows.map((row) => {
    const t = STATE.toppings.find((x) => x.id === row.toppingId);
    if (!t) return null;
    return { id: t.id, name: t.name, weight_g: toGrams(row.weight, row.unit),
             cost_per_gram: Number(t.cost_per_gram), tier: t.tier, surcharge_per_gram: Number(t.surcharge_per_gram) };
  }).filter(Boolean);

  return {
    loc, flavorRow: flavor, cupRow, spoonRow, cupWeightG, iceWeightG, toppings,
    args: {
      pricePerGram: Number(loc.price_per_gram),
      includeCupWeight: loc.include_cup_weight_in_price,
      marginTargetPct: Number(loc.margin_target_pct),
      iceCream: { id: flavor.id, name: flavor.name, weight_g: iceWeightG, cost_per_gram: Number(flavor.cost_per_gram) },
      toppings,
      cup: { id: cupRow.id, name: cupRow.name, tare_weight_g: cupWeightG, cost_per_unit: Number(cupRow.cost_per_unit) },
      spoon: spoonRow ? { id: spoonRow.id, name: spoonRow.name, cost_per_unit: Number(spoonRow.cost_per_unit) } : null,
    },
  };
}

function renderQuote() {
  const plan = buildPlan();
  const linesEl = $("ticket-lines"), totalsEl = $("ticket-totals"), alertsEl = $("ticket-alerts");
  if (!plan) {
    linesEl.innerHTML = '<p class="hint">Selecciona vaso y sabor para empezar.</p>';
    totalsEl.innerHTML = ""; alertsEl.innerHTML = "";
    return;
  }

  const result = computeSale(plan.args);
  const tareG = plan.cupWeightG, iceG = plan.iceWeightG;
  const toppingsFromRows = result.gross_weight_g - iceG - tareG;

  const scaleInput = parseFloat($("inp-total-weight").value) || 0;
  const scaleTotalG = scaleInput > 0 ? toGrams(scaleInput, totalUnit) : 0;
  const usingScale = scaleTotalG > 0;
  const toppingsG = usingScale ? r2(scaleTotalG - iceG - tareG) : r2(toppingsFromRows);
  const displayedTotalG = usingScale ? r2(scaleTotalG) : result.gross_weight_g;

  linesEl.innerHTML = result.lines.map((l) => `
    <div class="ticket-line">
      <span class="tl-name">${esc(l.name)}
        <span class="tl-meta">${l.weight_g ? fmtWeightShort(l.weight_g) + " · " : ""}costo ${money(l.cost)}${l.is_premium_surcharge ? " · premium" : ""}</span>
      </span>
      <span class="num">${money(l.price_contribution)}</span>
    </div>`).join("");

  totalsEl.innerHTML = `
    <div><span>Peso del vaso</span><span class="num">${fmtWeightShort(tareG)}</span></div>
    <div><span>Peso del helado</span><span class="num">${fmtWeightShort(iceG)}</span></div>
    <div><span>Peso de toppings${usingScale ? " (calculado)" : ""}</span><span class="num">${fmtWeightShort(toppingsG)}</span></div>
    <div><span>Peso total</span><span class="num">${fmtWeight(displayedTotalG)}</span></div>
    <div><span>Costo real</span><span class="num">${money(result.total_cost)}</span></div>
    <div><span>Margen</span><span class="num">${money(result.margin)} (${result.margin_pct}%)</span></div>
    <div class="tt-total"><span>Total</span><span class="num">${money(result.total_price)}</span></div>`;

  const alerts = [...result.alerts];
  if (usingScale && Math.abs(scaleTotalG - result.gross_weight_g) > 0.5) {
    alerts.unshift(`La báscula marca ${fmtWeightShort(scaleTotalG)}, pero vaso + helado + toppings registrados suman ${fmtWeightShort(result.gross_weight_g)} (diferencia de ${fmtWeightShort(Math.abs(scaleTotalG - result.gross_weight_g))}). Revisa antes de cobrar.`);
  }
  alertsEl.innerHTML = alerts.map((a) => `<div class="alert warn">${esc(a)}</div>`).join("");
}

$("btn-charge").addEventListener("click", () => chargeSale(false));

async function chargeSale(force) {
  const plan = buildPlan();
  if (!plan) { alert("Selecciona vaso y sabor."); return; }
  const result = computeSale(plan.args);
  if (result.total_price <= 0) { alert("La venta está en cero: pesa el helado o los toppings."); return; }

  const warnings = [];
  if (plan.flavorRow.stock_grams < plan.iceWeightG) warnings.push(`Stock insuficiente de "${plan.flavorRow.name}".`);
  plan.toppings.forEach((t) => {
    const row = STATE.toppings.find((x) => x.id === t.id);
    if (row && row.stock_grams < t.weight_g) warnings.push(`Stock insuficiente de topping "${row.name}".`);
  });
  if (plan.cupRow.stock_qty < 1) warnings.push(`No hay vasos disponibles (${plan.cupRow.name}).`);
  if (warnings.length && !force) {
    if (!confirm(warnings.join("\n") + "\n\n¿Registrar la venta de todos modos?")) return;
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
  };

  let folio = null, offline = false;
  try {
    if (!navigator.onLine) throw new Error("offline");
    const { data, error } = await sb.rpc("process_sale", { payload });
    if (error) throw error;
    folio = data && data.folio;
  } catch (e) {
    // La venta ya ocurrió físicamente: el cliente pagó y se llevó su helado.
    // Así que nunca la perdemos — se guarda aquí y se envía sola al volver la red.
    offline = true;
    lastSyncFailed = true;
    queueSale(payload);
  }

  showReceipt(payload, result, folio, offline);
  discountLocalStock(plan, result);

  $("inp-ice-weight").value = "";
  $("inp-total-weight").value = "";
  $("inp-customer-name").value = "";
  $("inp-customer-taxid").value = "";
  orderRows.length = 0;
  renderOrderRows();
  $("inp-cup-weight").dataset.auto = "1";
  prefillCupWeight();
  renderQuote();
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

function showReceipt(payload, result, folio, offline) {
  const loc = activeLocation();
  const TAX = { GT: { doc: "Factura Electrónica en Línea (FEL)", id: "NIT" },
                SV: { doc: "Documento Tributario Electrónico (DTE)", id: "NIT/DUI" },
                HN: { doc: "Factura (CAI / Factura Electrónica SAR)", id: "RTN" } };
  const t = TAX[loc.country_code] || TAX.HN;
  const items = result.lines
    .filter((l) => !(l.item_type === "cuchara" && l.price_contribution === 0))
    .map((l) => `${esc(l.name)}${l.weight_g ? "  " + fmtWeightShort(l.weight_g) : ""}   ${money(l.price_contribution)}`)
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
------------------------------
${items}
------------------------------
PESO TOTAL: ${fmtWeight(result.gross_weight_g)}
TOTAL: ${money(result.total_price)}
------------------------------
NO ES UNA FACTURA FISCAL VÁLIDA — pendiente de
conexión con proveedor certificado.
${offline ? "\n** Registrada sin conexión — se enviará al\n   servidor cuando vuelva el internet. **" : ""}
</div>`;
  $("receipt-modal").hidden = false;
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

$("sel-report-location").addEventListener("change", () => { renderReports(); renderClosing(); });

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
   Funciona en Chrome o Edge sobre HTTPS. La primera vez, el navegador pide
   permiso y hay que elegir el puerto de la báscula; después queda recordado.
   La báscula debe estar en modo de salida continua ("PC mode" o similar).
   El lector es tolerante: toma el primer número de cada línea que recibe, que
   es lo que mandan la mayoría de básculas (Torrey, CAS, OHAUS y compatibles).
   =========================================================================== */
const scale = { port: null, reader: null, lastWeight: null, reading: false };

function scaleSupported() { return "serial" in navigator; }

async function connectScale() {
  if (!scaleSupported()) {
    $("scale-status").textContent = "Este navegador no puede leer la báscula. Usa Chrome o Edge en la computadora del mostrador.";
    return false;
  }
  try {
    scale.port = await navigator.serial.requestPort();
    await scale.port.open({ baudRate: CFG.SCALE_BAUD_RATE || 9600 });
    $("scale-status").textContent = "Báscula conectada.";
    readScaleLoop();
    return true;
  } catch (e) {
    $("scale-status").textContent = `No se pudo conectar la báscula: ${e.message}`;
    return false;
  }
}

async function readScaleLoop() {
  if (!scale.port || scale.reading) return;
  scale.reading = true;
  const decoder = new TextDecoderStream();
  scale.port.readable.pipeTo(decoder.writable).catch(() => {});
  const reader = decoder.readable.getReader();
  scale.reader = reader;
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split(/[\r\n]+/);
      buffer = lines.pop() || "";
      lines.forEach((line) => {
        const m = line.match(/-?\d+(?:\.\d+)?/);
        if (m) {
          scale.lastWeight = parseFloat(m[0]);
          const unit = /oz/i.test(line) ? "oz" : "g";
          $("scale-status").textContent = `Báscula: ${scale.lastWeight} ${unit}`;
          scale.lastUnit = unit;
        }
      });
    }
  } catch (e) {
    $("scale-status").textContent = `Se perdió la lectura de la báscula: ${e.message}`;
  } finally {
    scale.reading = false;
  }
}

async function captureWeightInto(inputId, unitContainerId, setUnit) {
  if (!scale.port) {
    const ok = await connectScale();
    if (!ok) return;
    await new Promise((r) => setTimeout(r, 800));
  }
  if (scale.lastWeight == null) {
    $("scale-status").textContent = "Todavía no llega lectura de la báscula. Verifica que esté encendida y en modo de salida continua.";
    return;
  }
  $(inputId).value = scale.lastWeight;
  if (scale.lastUnit) {
    document.querySelectorAll(`#${unitContainerId} button`).forEach((b) => {
      b.classList.toggle("active", b.dataset.unit === scale.lastUnit);
    });
    setUnit(scale.lastUnit);
  }
  $(inputId).dataset.auto = "0";
  renderQuote();
}

$("btn-scale-ice").addEventListener("click", () => captureWeightInto("inp-ice-weight", "unit-ice", (u) => (iceUnit = u)));
$("btn-scale-total").addEventListener("click", () => captureWeightInto("inp-total-weight", "unit-total", (u) => (totalUnit = u)));

if (!scaleSupported()) {
  $("btn-scale-ice").hidden = true;
  $("btn-scale-total").hidden = true;
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
  toppings: "Topping", supplies: "Insumo", expenses: "Gasto", sales: "Venta",
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
};

// Resume un evento en una frase legible: "costo/g: 0.06 → 0.02".
function auditResumen(ev) {
  const antes = ev.before || {}, despues = ev.after || {};
  if (ev.action === "DELETE") {
    // Una venta se identifica por su folio, no por un nombre entre comillas.
    const etiqueta = antes.folio != null ? `venta #${antes.folio}`
                   : (antes.name || antes.description || antes.full_name);
    const monto = antes.total_price != null ? ` por ${dmoney(antes.total_price)}`
                : antes.amount != null ? ` por ${dmoney(antes.amount)}` : "";
    return (etiqueta ? (antes.folio != null ? etiqueta : `"${etiqueta}"`) : "registro") + monto;
  }
  if (ev.action === "INSERT") {
    const etiqueta = despues.name || despues.description || despues.full_name || "";
    const monto = despues.amount != null ? ` por ${dmoney(despues.amount)}` : "";
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
