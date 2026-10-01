/* ===========================================================================
   CARNET DIGITAL — lo que ve la clienta en su teléfono
   ---------------------------------------------------------------------------
   Página aparte de la caja: no pide usuario, porque la clienta no tiene uno.
   Lee el código del enlace (?c=...) y le pregunta a la base solo lo mínimo:
   nombre de pila y saldo (loyalty_carnet, la única función pública).

   El QR se dibuja con el código, que viene en el propio enlace. Por eso el
   QR funciona SIEMPRE, aunque no haya señal en el mall: no necesita la red.
   Lo que sí necesita red es el saldo; si no hay, se muestra el último que se
   vio, diciendo de cuándo es.
   =========================================================================== */
"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const CFG = window.TUTIS_CONFIG || {};

  // El código solo puede traer las letras y números del alfabeto del carnet.
  // Cualquier otra cosa se descarta antes de llegar a ningún lado.
  const crudo = new URLSearchParams(location.search).get("c") || "";
  const codigo = crudo.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);

  const CACHE = "tutis_carnet_" + codigo;
  const leer = () => { try { return JSON.parse(localStorage.getItem(CACHE) || "null"); } catch (e) { return null; } };
  const guardar = (v) => { try { localStorage.setItem(CACHE, JSON.stringify(v)); } catch (e) {} };

  function error(mensaje) {
    $("card").outerHTML = `<div class="error"><strong>${mensaje}</strong>
      <p>Pide en caja que te reenvíen el enlace de tu carnet.</p></div>`;
  }

  function dibujarQR() {
    const qr = window.qrcode(0, "M");   // M: tolera ~15% del código dañado o sucio
    qr.addData(codigo);
    qr.make();
    // createSvgTag arma el SVG con texto que nosotros controlamos (el código
    // ya filtrado arriba), así que se puede insertar.
    $("c-qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
  }

  function pintar(d, desdeCache) {
    $("c-name").textContent = d.nombre ? `Hola, ${d.nombre}` : "";
    $("c-points").textContent = Number(d.puntos || 0).toLocaleString("es");
    $("c-value").textContent = d.vale != null ? `equivalen a L ${Number(d.vale).toFixed(2)}` : "";
    $("c-foot").textContent = desdeCache && d.visto
      ? `Sin conexión — saldo del ${new Date(d.visto).toLocaleString()}`
      : (d.desde ? `Cliente desde ${new Date(d.desde + "T12:00:00").toLocaleDateString()}` : "");
  }

  async function botonesWallet() {
    // El servicio de pases vive en su propio Worker. Cada wallet se enciende
    // por separado en config.js: un botón que lleva a "todavía no está
    // disponible" es peor que no tener botón.
    const base = CFG.WALLET_URL;
    if (!base) return;
    $("btn-apple").href  = `${base}/apple/${encodeURIComponent(codigo)}`;
    $("btn-google").href = `${base}/google/${encodeURIComponent(codigo)}`;
    // Cada quien ve el botón de su teléfono; en una compu se ven los dos.
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/i.test(ua), android = /Android/i.test(ua);
    $("btn-apple").hidden  = !CFG.WALLET_APPLE  || android;
    $("btn-google").hidden = !CFG.WALLET_GOOGLE || ios;
    $("wallets").hidden = $("btn-apple").hidden && $("btn-google").hidden;
  }

  if (!codigo || codigo.length < 8) { error("Este enlace de carnet no es válido."); return; }

  $("c-code").textContent = codigo.replace(/(.{5})(.*)/, "$1 $2");
  dibujarQR();

  const previo = leer();
  if (previo) pintar(previo, true);

  if (!navigator.onLine || !window.supabase || !CFG.SUPABASE_URL) {
    if (!previo) $("c-foot").textContent = "Sin conexión. El QR sirve igual en caja.";
    return;
  }

  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });

  sb.rpc("loyalty_carnet", { p_code: codigo }).then(({ data, error: e }) => {
    if (e) { if (!previo) $("c-foot").textContent = "No se pudo consultar el saldo ahora."; return; }
    if (!data) { error("No encontramos este carnet."); return; }
    data.visto = new Date().toISOString();
    guardar(data);
    pintar(data, false);
    botonesWallet();
  });
})();
