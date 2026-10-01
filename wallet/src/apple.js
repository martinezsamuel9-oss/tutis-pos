/* ===========================================================================
   El pase de Apple Wallet (.pkpass)
   ---------------------------------------------------------------------------
   Un .pkpass es un ZIP con:
     pass.json      — qué dice el pase
     *.png          — logo e ícono
     manifest.json  — el SHA-1 de cada archivo
     signature      — la firma PKCS#7 de manifest.json (ver cms.js)

   iOS rechaza en silencio un pase al que le falta cualquiera de estas piezas,
   o cuyo manifiesto no cuadra con sus archivos. Por eso el manifiesto se
   calcula de los bytes exactos que van dentro del ZIP.
   =========================================================================== */
import { zip } from "./zip.js";
import { firmar } from "./cms.js";

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// Cómo se ve el pase. storeCard es el tipo que Apple destina a tarjetas de
// lealtad: deja el QR abajo y los puntos bien visibles arriba.
export function contenidoPase(carnet, opciones) {
  const { passTypeId, teamId, webServiceURL, authenticationToken } = opciones;
  const codigo = carnet.card_code;
  const puntos = Number(carnet.puntos || 0);

  const vale = `L ${Number(carnet.vale || 0).toFixed(2)}`;

  // Colores de la guía de marca (Pantone, no tomados de una foto):
  //   fondo   219 C  #DA1884  magenta
  //   texto   blanco          contraste 4.7 sobre el magenta: pasa para texto chico
  //   etiquetas 706 C #F7CED7 rosado claro, la pareja que la guía usa sobre el magenta
  // El verde de marca (576 C) se descartó para el pase: con texto blanco daba
  // 3.1 de contraste, y las etiquetas chicas se leen mal en la calle con sol.
  const pase = {
    formatVersion: 1,
    passTypeIdentifier: passTypeId,
    teamIdentifier: teamId,
    // El número de serie identifica ESTE pase. Es el código del carnet: así,
    // si la clienta lo vuelve a agregar, iOS lo reconoce y no lo duplica.
    serialNumber: codigo,
    organizationName: "Tuti's",
    description: "Carnet de cliente frecuente Tuti's",
    logoText: "",
    backgroundColor: "rgb(218, 24, 132)",
    foregroundColor: "rgb(255, 255, 255)",
    labelColor: "rgb(247, 206, 215)",

    storeCard: {
      // Arriba a la derecha: cuánto valen sus puntos en dinero. Va como texto
      // ("L 240.00") y no con currencyCode, que iOS muestra como "HNL 240.00".
      headerFields: [
        { key: "saldo", label: "SALDO", value: vale, textAlignment: "PKTextAlignmentRight" },
      ],
      // Lo grande son los PUNTOS. En storeCard, Wallet pone la etiqueta DEBAJO
      // del número, así que se lee "240 / PUNTOS".
      primaryFields: [
        { key: "puntos", label: "PUNTOS", value: puntos, numberStyle: "PKNumberStyleDecimal",
          // Cuando el saldo cambie y el pase se actualice, iOS muestra esto.
          // %@ es el valor nuevo.
          changeMessage: "Ahora tienes %@ puntos en Tuti's" },
      ],
      secondaryFields: [
        { key: "nombre", label: "CLIENTE", value: carnet.nombre || "" },
      ],
      auxiliaryFields: [
        { key: "carnet", label: "CARNET", value: codigo.replace(/(.{5})(.*)/, "$1 $2"),
          textAlignment: "PKTextAlignmentRight" },
      ],
      // El reverso del pase. Sin enlaces al sitio: el dueño lo pidió para todo
      // lo que se entrega al cliente.
      backFields: [
        { key: "como", label: "Cómo funciona",
          value: "Por cada dólar que gastas (o su equivalente en lempiras) ganas 1 punto, y cada punto vale L 1. Muestra este código en caja para sumar o canjear." },
        { key: "donde", label: "Dónde",
          value: "Tuti's Galerías y Tuti's Multiplaza. Tus puntos sirven en las dos." },
        { key: "desde", label: "Cliente desde", value: carnet.desde || "" },
      ],
    },

    // El QR lleva SOLO el código: es lo que teclea el lector de la caja.
    barcodes: [{
      format: "PKBarcodeFormatQR",
      message: codigo,
      messageEncoding: "iso-8859-1",
      altText: codigo,
    }],
  };

  // Con esto el pase sabe a dónde preguntar por su versión nueva cuando
  // cambien los puntos. Va desde el primer pase que se entregue: un pase
  // emitido sin estas líneas no se puede actualizar nunca, y la clienta
  // tendría que borrarlo y volver a agregarlo.
  if (webServiceURL && authenticationToken) {
    pase.webServiceURL = webServiceURL;
    pase.authenticationToken = authenticationToken;
  }
  return pase;
}

/* armarPkpass(carnet, imagenes, credenciales, opciones) → Uint8Array (.pkpass)
   imagenes: { "icon.png": Uint8Array, ... } */
export async function armarPkpass(carnet, imagenes, credenciales, opciones) {
  const enc = new TextEncoder();
  const archivos = { "pass.json": enc.encode(JSON.stringify(contenidoPase(carnet, opciones))) };
  for (const [nombre, datos] of Object.entries(imagenes)) archivos[nombre] = datos;

  // Apple exige SHA-1 en el manifiesto (la firma de afuera sí es SHA-256).
  const manifiesto = {};
  for (const [nombre, datos] of Object.entries(archivos)) {
    manifiesto[nombre] = hex(await crypto.subtle.digest("SHA-1", datos));
  }
  const manifestBytes = enc.encode(JSON.stringify(manifiesto));
  const firma = await firmar(manifestBytes, credenciales);

  return zip([
    ...Object.entries(archivos).map(([nombre, datos]) => ({ nombre, datos })),
    { nombre: "manifest.json", datos: manifestBytes },
    { nombre: "signature", datos: firma },
  ]);
}
