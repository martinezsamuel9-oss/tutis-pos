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
  if (canManage()) fillDashLocationPicker();
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

  const loc = activeLocation();
  $("price-per-gram-hint").textContent = loc ? `Precio único: ${money(loc.price_per_gram)} por gramo` : "";
  prefillCupWeight();
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
      orderRows.push({ rowId: "r" + Date.now() + Math.random(), toppingId: t.id, weight: 0, unit: "g" });
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
        <span class="tl-meta">${l.weight_g ? r2(l.weight_g) + "g · " : ""}costo ${money(l.cost)}${l.is_premium_surcharge ? " · premium" : ""}</span>
      </span>
      <span class="num">${money(l.price_contribution)}</span>
    </div>`).join("");

  totalsEl.innerHTML = `
    <div><span>Peso del vaso</span><span class="num">${r2(tareG)} g</span></div>
    <div><span>Peso del helado</span><span class="num">${r2(iceG)} g</span></div>
    <div><span>Peso de toppings${usingScale ? " (calculado)" : ""}</span><span class="num">${r2(toppingsG)} g</span></div>
    <div><span>Peso total</span><span class="num">${displayedTotalG} g (${r2(toOz(displayedTotalG))} oz)</span></div>
    <div><span>Costo real</span><span class="num">${money(result.total_cost)}</span></div>
    <div><span>Margen</span><span class="num">${money(result.margin)} (${result.margin_pct}%)</span></div>
    <div class="tt-total"><span>Total</span><span class="num">${money(result.total_price)}</span></div>`;

  const alerts = [...result.alerts];
  if (usingScale && Math.abs(scaleTotalG - result.gross_weight_g) > 0.5) {
    alerts.unshift(`La báscula marca ${r2(scaleTotalG)}g, pero vaso + helado + toppings registrados suman ${result.gross_weight_g}g (diferencia de ${r2(Math.abs(scaleTotalG - result.gross_weight_g))}g). Revisa antes de cobrar.`);
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
    .map((l) => `${esc(l.name)}${l.weight_g ? "  " + r2(l.weight_g) + "g" : ""}   ${money(l.price_contribution)}`)
    .join("\n");

  $("receipt-body").innerHTML = `<div class="ticket" style="white-space:pre-wrap;">
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
PESO TOTAL: ${result.gross_weight_g} g
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
      <td class="num">${r2(s.gross_weight_g)} g</td>
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
    tr.innerHTML = `<td>${esc(r.name)}</td><td class="num">${r2(r.peso)} g</td><td class="num">${money(r.costo)}</td>
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
  $("closing-print-head").innerHTML = `<strong>${esc(scopeName)}</strong> — Cierre del día ${dateInput.value}`;

  $("closing-summary").innerHTML = mixedCurrencyWarning() + `
    <div class="kpi"><div class="kpi-label">Vasos vendidos</div><div class="kpi-value num">${totals.vasos}</div></div>
    <div class="kpi"><div class="kpi-label">Cucharas vendidas</div><div class="kpi-value num">${totals.cucharas}</div></div>
    <div class="kpi"><div class="kpi-label">Peso de helado vendido</div><div class="kpi-value num">${r2(totals.helado)} g</div><div class="hint">${r2(toOz(totals.helado))} oz</div></div>
    <div class="kpi"><div class="kpi-label">Peso de toppings vendido</div><div class="kpi-value num">${r2(totals.toppings)} g</div><div class="hint">${r2(toOz(totals.toppings))} oz</div></div>
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
    tr.innerHTML = `<td>${esc(r.name)}</td><td class="num">${r2(r.peso)} g</td><td class="num">${r.pct}%</td>`;
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
    L.push(`  Peso de helado vendido: ${r2(c.peso_helado_g)} g (${r2(toOz(c.peso_helado_g))} oz)`);
    L.push(`  Peso de toppings vendido: ${r2(c.peso_toppings_g)} g (${r2(toOz(c.peso_toppings_g))} oz)`);
    L.push(`  Ingresos: ${c.ingresos}`);
    L.push("  Toppings vendidos:");
    if (!(c.toppings || []).length) L.push("    (sin ventas de toppings)");
    else (c.toppings || []).forEach((t) => L.push(`    - ${t.name}: ${r2(t.peso_g)} g (${t.pct}%)`));
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
  $("cfg-invoice-status").textContent =
    "Mientras no se conecte un proveedor certificado (FEL en Guatemala, DTE en El Salvador, SAR en Honduras), cada venta genera un comprobante interno con todos los campos legales listos, claramente marcado como no fiscal.";
}

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
  }).eq("id", STATE.activeLocationId);

  const msg = $("config-saved");
  msg.textContent = error ? `No se pudo guardar: ${error.message}` : "Configuración guardada.";
  if (!error) { await loadData(); setTimeout(() => (msg.textContent = ""), 2500); }
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
const DASH = { results: [], expenses: [], from: null, to: null, loaded: false };

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
  $("dash-print-head").innerHTML = `<strong>${esc(scopeName)}</strong> — del ${fmt(DASH.from)} al ${fmt(DASH.to)}`;
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
    kpi("Helado vendido", `${r2(t.helado)} g`, `${r2(toOz(t.helado))} oz`) +
    kpi("Toppings vendidos", `${r2(t.toppings)} g`, `${r2(toOz(t.toppings))} oz`);

  renderDashChart(serie);
  renderDashStores();
  renderDashProjection(serie, t);
  renderDashExpenses();
  renderDashToppings();
}

/* --- Gráfica de barras en SVG ---------------------------------------------
   Si el periodo es largo, los días se agrupan por semana: 90 barras en un
   celular no se leen. */
function renderDashChart(serie) {
  const box = $("dash-chart");
  if (!serie.length || serie.every((d) => !d.ingresos && !d.gastos)) {
    box.innerHTML = '<div class="chart-empty">No hay movimientos en este periodo.</div>';
    $("dash-chart-legend").innerHTML = "";
    return;
  }

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

  const W = 720, H = 220, padL = 52, padR = 10, padT = 12, padB = 26;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(...puntos.map((d) => Math.max(d.ingresos, d.gastos)), 1);
  const slot = innerW / puntos.length;
  const bw = Math.max(2, Math.min(18, slot / 2 - 1));
  const y = (v) => padT + innerH - (v / max) * innerH;

  const avg = puntos.reduce((a, d) => a + d.ingresos, 0) / puntos.length;
  const nice = (v) => v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(Math.round(v));

  let bars = "";
  puntos.forEach((d, i) => {
    const x = padL + i * slot + slot / 2;
    const hi = Math.max(0, padT + innerH - y(d.ingresos));
    const hg = Math.max(0, padT + innerH - y(d.gastos));
    const t = `${fechaCorta(d.dia)}${agrupado ? " (semana)" : ""} — ingresos ${dmoney(d.ingresos)}, gastos ${dmoney(d.gastos)}`;
    bars += `<g><title>${esc(t)}</title>`;
    bars += `<rect class="chart-bar-income" x="${(x - bw - 0.5).toFixed(1)}" y="${y(d.ingresos).toFixed(1)}" width="${bw.toFixed(1)}" height="${hi.toFixed(1)}" rx="2"/>`;
    bars += `<rect class="chart-bar-expense" x="${(x + 0.5).toFixed(1)}" y="${y(d.gastos).toFixed(1)}" width="${bw.toFixed(1)}" height="${hg.toFixed(1)}" rx="2"/>`;
    bars += `</g>`;
  });

  let ticks = "";
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k, yy = y(v);
    ticks += `<line class="chart-axis" x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" opacity="0.35"/>`;
    ticks += `<text class="chart-label" x="${padL - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${nice(v)}</text>`;
  }

  const paso = Math.ceil(puntos.length / 8);
  let labels = "";
  puntos.forEach((d, i) => {
    if (i % paso) return;
    const x = padL + i * slot + slot / 2;
    labels += `<text class="chart-label" x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle">${fechaCorta(d.dia)}</text>`;
  });

  const avgY = y(avg).toFixed(1);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet"
      aria-label="Ingresos y gastos por ${agrupado ? "semana" : "día"}">
    ${ticks}${bars}
    <line class="chart-avg-line" x1="${padL}" y1="${avgY}" x2="${W - padR}" y2="${avgY}"/>
  </svg>`;

  $("dash-chart-legend").innerHTML =
    `<span><i class="income"></i> Ingresos</span>` +
    `<span><i class="expense"></i> Gastos</span>` +
    `<span><i class="avg"></i> Promedio de ingresos: ${dmoney(avg)} por ${agrupado ? "semana" : "día"}</span>`;
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

/* --- Gastos ---------------------------------------------------------------- */
function renderDashExpenses() {
  const cats = {};
  DASH.results.forEach((r) => (r.gastos_categoria || []).forEach((c) => {
    cats[c.categoria] = (cats[c.categoria] || 0) + Number(c.monto || 0);
  }));
  const total = Object.values(cats).reduce((a, b) => a + b, 0);
  const entries = Object.entries(cats).sort((a, b) => b[1] - a[1]);

  $("dash-expense-cats").innerHTML = entries.length
    ? entries.map(([c, m]) => `<div class="kpi">
        <div class="kpi-label">${esc(EXPENSE_LABELS[c] || c)}</div>
        <div class="kpi-value num">${dmoney(m)}</div>
        <div class="kpi-sub">${total > 0 ? r2((100 * m) / total) : 0}% de los gastos</div></div>`).join("")
    : '<p class="hint">No hay gastos registrados en este periodo.</p>';

  const body = document.querySelector("#table-expenses tbody");
  body.innerHTML = DASH.expenses.length ? "" :
    '<tr><td colspan="6" class="hint">Sin gastos en este periodo.</td></tr>';
  DASH.expenses.forEach((g) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(fechaCorta(g.spent_on))}/${esc(g.spent_on.slice(0, 4))}</td>
      <td>${esc((g.locations && g.locations.name) || "")}</td>
      <td>${esc(EXPENSE_LABELS[g.category] || g.category)}</td>
      <td>${esc(g.description || "")}</td>
      <td class="num">${dmoney(g.amount)}</td>
      <td><div class="row-actions"><button class="icon-btn delete btn-del" type="button" title="Eliminar">${ICON_TRASH}</button></div></td>`;
    tr.querySelector(".btn-del").addEventListener("click", async () => {
      if (!confirm(`¿Eliminar el gasto de ${dmoney(g.amount)}?`)) return;
      const { error } = await sb.from("expenses").delete().eq("id", g.id);
      if (error) { alert(`No se pudo eliminar: ${error.message}`); return; }
      await loadDashboard();
    });
    body.appendChild(tr);
  });

  const ids = dashScopeIds();
  const target = ids.length === 1 ? ids[0] : STATE.activeLocationId;
  const tLoc = STATE.locations.find((l) => l.id === target);
  $("ne-target").textContent = tLoc
    ? (ids.length === 1
        ? `El gasto se registrará en ${tLoc.name}.`
        : `Estás viendo el consolidado: el gasto se registrará en ${tLoc.name}. Si es de otra tienda, selecciónala arriba primero.`)
    : "";
  if (!$("ne-date").value) $("ne-date").value = localDateStr();
}

$("btn-add-expense").addEventListener("click", async () => {
  const msg = $("ne-msg");
  const monto = parseFloat($("ne-amount").value);
  if (!(monto > 0)) { msg.textContent = "Pon un monto mayor a cero."; return; }
  const ids = dashScopeIds();
  const target = ids.length === 1 ? ids[0] : STATE.activeLocationId;
  if (!target) { msg.textContent = "No hay una tienda seleccionada."; return; }

  const { error } = await sb.from("expenses").insert({
    location_id: target,
    spent_on: $("ne-date").value || localDateStr(),
    category: $("ne-cat").value,
    description: $("ne-desc").value.trim() || null,
    amount: monto,
    created_by: STATE.profile.id,
  });
  if (error) { msg.textContent = `No se pudo registrar: ${error.message}`; return; }
  msg.textContent = "Gasto registrado.";
  $("ne-desc").value = ""; $("ne-amount").value = "";
  await loadDashboard();
  setTimeout(() => (msg.textContent = ""), 2500);
});

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
      <td class="num">${r2(r.peso)} g</td>
      <td class="num">${pct}%</td>
      <td class="num">${dmoney(r.margen)}</td>
      <td class="num">${r.peso > 0 ? r2(r.margen / r.peso) : 0} / g</td>`;
    if (meta && r.peso > 0 && r.margen <= 0) tr.classList.add("low-stock");
    body.appendChild(tr);
  });
}

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
