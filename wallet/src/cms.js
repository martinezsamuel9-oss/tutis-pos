/* ===========================================================================
   Firma PKCS#7 (CMS SignedData) desacoplada — la que exige Apple Wallet
   ---------------------------------------------------------------------------
   Apple pide que el manifest.json del pase venga firmado con el certificado
   del Pass Type ID, incluyendo el intermedio WWDR. Sin esa firma, iOS ni
   siquiera abre el archivo.

   Por qué está escrito a mano en vez de usar una librería:
     · La operación cara (RSA) la hace WebCrypto, que es nativo. Una librería
       en JavaScript puro haría la RSA en JS y pasaría los 10 ms de CPU por
       solicitud que da el plan gratuito de Workers.
     · Lo único que falta es armar la estructura ASN.1 alrededor, que es
       determinista. Cada byte de lo que sale se puede comprobar con
       `openssl cms -verify`, y así se probó.
   =========================================================================== */

// --- Codificación DER mínima -------------------------------------------------
function largo(n) {
  if (n < 0x80) return Uint8Array.of(n);
  const b = [];
  while (n > 0) { b.unshift(n & 0xFF); n >>>= 8; }
  return Uint8Array.of(0x80 | b.length, ...b);
}
function unir(...partes) {
  const out = new Uint8Array(partes.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of partes) { out.set(p, o); o += p.length; }
  return out;
}
const tlv = (tag, ...cuerpo) => { const c = unir(...cuerpo); return unir(Uint8Array.of(tag), largo(c.length), c); };
const SEQ = (...x) => tlv(0x30, ...x);
const OCTETOS = (b) => tlv(0x04, b);
const ENTERO = (n) => tlv(0x02, Uint8Array.of(n));
const NULO = () => Uint8Array.of(0x05, 0x00);

// En DER, los elementos de un SET OF van ordenados por sus bytes. Si no, la
// firma es inválida aunque los datos sean correctos.
function SET(...elementos) {
  const orden = [...elementos].sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  });
  return tlv(0x31, ...orden);
}

function OID(texto) {
  const p = texto.split(".").map(Number);
  const out = [40 * p[0] + p[1]];
  for (let i = 2; i < p.length; i++) {
    let v = p[i]; const pila = [v & 0x7F];
    while ((v >>>= 7) > 0) pila.unshift(0x80 | (v & 0x7F));
    out.push(...pila);
  }
  return tlv(0x06, Uint8Array.from(out));
}

function horaUTC(d) {
  const p = (n) => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
            `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, new TextEncoder().encode(s));
}

const O = {
  data:          "1.2.840.113549.1.7.1",
  signedData:    "1.2.840.113549.1.7.2",
  contentType:   "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime:   "1.2.840.113549.1.9.5",
  sha256:        "2.16.840.1.101.3.4.2.1",
  rsa:           "1.2.840.113549.1.1.1",
};

// --- Lectura DER mínima: solo lo necesario para sacar emisor y serie ---------
function leer(b, o) {
  const tag = b[o];
  let l = b[o + 1], cab = 2;
  if (l & 0x80) {
    const n = l & 0x7F; l = 0;
    for (let i = 0; i < n; i++) l = (l << 8) | b[o + 2 + i];
    cab = 2 + n;
  }
  return { tag, inicio: o, cab, fin: o + cab + l };
}
function hijos(b, nodo) {
  const out = []; let o = nodo.inicio + nodo.cab;
  while (o < nodo.fin) { const h = leer(b, o); out.push(h); o = h.fin; }
  return out;
}
// IssuerAndSerialNumber identifica al firmante. Se copian los bytes tal cual
// vienen en el certificado: re-codificarlos es la forma más fácil de romperlo.
function emisorYSerie(certDer) {
  const tbs = hijos(certDer, leer(certDer, 0))[0];
  const c = hijos(certDer, tbs);
  const i = c[0].tag === 0xA0 ? 1 : 0;             // [0] versión, si está
  const serie  = certDer.slice(c[i].inicio, c[i].fin);
  const emisor = certDer.slice(c[i + 2].inicio, c[i + 2].fin);
  return SEQ(emisor, serie);
}

export function pemADer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* firmar(manifest, { certPem, llavePem, intermedioPem, ahora })
   Devuelve el archivo "signature" del pase: DER de un ContentInfo/SignedData
   con el contenido desacoplado (el manifest no va adentro, va al lado). */
export async function firmar(manifest, { certPem, llavePem, intermedioPem, ahora = new Date() }) {
  const cert = pemADer(certPem), intermedio = pemADer(intermedioPem);
  const algSha256 = SEQ(OID(O.sha256), NULO());

  const resumen = new Uint8Array(await crypto.subtle.digest("SHA-256", manifest));
  const atributos = [
    SEQ(OID(O.contentType),   SET(OID(O.data))),
    SEQ(OID(O.signingTime),   SET(horaUTC(ahora))),
    SEQ(OID(O.messageDigest), SET(OCTETOS(resumen))),
  ];

  // Lo que se firma es el conjunto de atributos codificado como SET (0x31).
  // En el SignerInfo ese mismo contenido va con la etiqueta [0] (0xA0). Es la
  // trampa clásica de CMS: firmar los bytes con 0xA0 da una firma inválida.
  const atributosSet = SET(...atributos);
  const atributosImplicitos = unir(Uint8Array.of(0xA0), atributosSet.slice(1));

  const llave = await crypto.subtle.importKey("pkcs8", pemADer(llavePem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const firma = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", llave, atributosSet));

  const firmante = SEQ(
    ENTERO(1),
    emisorYSerie(cert),
    algSha256,
    atributosImplicitos,
    SEQ(OID(O.rsa), NULO()),
    OCTETOS(firma),
  );

  const signedData = SEQ(
    ENTERO(1),
    SET(algSha256),
    SEQ(OID(O.data)),                               // desacoplado: sin contenido
    tlv(0xA0, cert, intermedio),                    // [0] certificados
    SET(firmante),
  );

  return SEQ(OID(O.signedData), tlv(0xA0, signedData));
}
