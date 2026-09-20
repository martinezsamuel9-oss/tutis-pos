/* ===========================================================================
   TUTI'S — Service worker
   ---------------------------------------------------------------------------
   Para qué sirve: hasta ahora el catálogo y las ventas pendientes se guardaban
   en el navegador, pero los ARCHIVOS de la aplicación no. Si la tableta se
   reiniciaba o alguien recargaba la página sin internet, no abría nada y la
   caja quedaba parada. Con esto, la aplicación se guarda en el dispositivo y
   abre aunque no haya señal.

   Dos estrategias, a propósito distintas:
     · config.js  → primero la red. Es el archivo donde viven las credenciales
       de Supabase; si algún día cambian, no queremos servir una copia vieja.
       Si no hay red, se usa la copia guardada.
     · todo lo demás → primero la copia guardada (abre instantáneo), y se
       refresca en segundo plano para la próxima vez.

   Cómo publicar una versión nueva: sube CACHE_VERSION. Eso borra la caché
   anterior y obliga a bajar los archivos otra vez.
   =========================================================================== */
const CACHE_VERSION = "tutis-v1";

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
  // Solo manejamos lo que sirve este mismo sitio. Las llamadas a Supabase
  // pasan de largo: esas las maneja la cola de ventas de la aplicación, que ya
  // sabe reintentar. Cachearlas daría datos viejos sin avisar.
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith("/config.js")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
