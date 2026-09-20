/* ===========================================================================
   TUTI'S — Service worker
   ---------------------------------------------------------------------------
   Para qué sirve: hasta ahora el catálogo y las ventas pendientes se guardaban
   en el navegador, pero los ARCHIVOS de la aplicación no. Si la tableta se
   reiniciaba o alguien recargaba la página sin internet, no abría nada y la
   caja quedaba parada. Con esto, la aplicación se guarda en el dispositivo y
   abre aunque no haya señal.

   Estrategia: PRIMERO LA RED, con la copia guardada como respaldo, y con un
   límite de 3 segundos de espera.

   Por qué no al revés. La primera versión servía primero la copia guardada, y
   eso tenía un defecto que se vio al publicar: después de subir una versión
   nueva, la caja seguía abriendo la anterior y solo se actualizaba al segundo
   intento. En un punto de venta eso es inaceptable — si se corrige un precio
   o un cálculo, tiene que llegar ya.

   Con este orden: si hay internet, siempre se abre la versión publicada. Si
   no hay, o si la red está tan lenta que no responde en 3 segundos (que es lo
   que pasa en un mall con la señal saturada), se usa la copia guardada al
   instante y la caja sigue cobrando. Son archivos pequeños; el costo de
   pedirlos es mínimo frente a servir una versión vieja sin avisar.

   Cómo publicar una versión nueva: sube CACHE_VERSION. Eso borra la caché
   anterior y obliga a bajar los archivos otra vez.
   =========================================================================== */
const CACHE_VERSION = "tutis-v4";

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./vendor/supabase.min.js",
  "./logo.png",
  "./icon-192.png",
  "./icon-512.png",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // addAll falla entero si un solo archivo falla; los pedimos uno por uno
      // para que un archivo ausente no deje a la tienda sin aplicación offline.
      .then((cache) => Promise.all(
        APP_SHELL.map((url) => cache.add(url).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Solo manejamos lo que sirve este mismo sitio. Las llamadas al servidor de
  // datos pasan de largo: esas las maneja la cola de ventas de la aplicación,
  // que ya sabe reintentar. Guardarlas en caché daría datos viejos sin avisar.
  if (url.origin !== self.location.origin) return;

  event.respondWith(redPrimero(req));
});

async function redPrimero(req) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const res = await conLimiteDeTiempo(fetch(req), 3000);
    // Solo guardamos respuestas buenas: cachear un 404 o un 500 dejaría la
    // caja rota incluso cuando el servidor ya se recuperó.
    if (res && res.status === 200 && res.type === "basic") {
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    const guardado = await cache.match(req);
    if (guardado) return guardado;
    // Una navegación sin copia guardada: al menos devolvemos la portada, que
    // sí está en caché desde la instalación.
    if (req.mode === "navigate") {
      const portada = await cache.match("./index.html") || await cache.match("./");
      if (portada) return portada;
    }
    throw e;
  }
}

function conLimiteDeTiempo(promesa, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("La red tardó demasiado")), ms);
    promesa.then((v) => { clearTimeout(t); resolve(v); },
                 (e) => { clearTimeout(t); reject(e); });
  });
}
