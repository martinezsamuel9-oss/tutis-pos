/* ===========================================================================
   ZIP mínimo, sin compresión (método STORE)
   ---------------------------------------------------------------------------
   Un .pkpass es un ZIP. Apple acepta entradas sin comprimir, y los archivos
   de un pase pesan unos KB: comprimirlos no aporta nada y obligaría a meter
   una librería de deflate. Esto son 60 líneas que se pueden leer completas.
   =========================================================================== */

const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = TABLA_CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// archivos: [{ nombre: "pass.json", datos: Uint8Array }]
export function zip(archivos) {
  const enc = new TextEncoder();
  const locales = [], centrales = [];
  let desplazamiento = 0;

  for (const a of archivos) {
    const nombre = enc.encode(a.nombre);
    const datos = a.datos;
    const crc = crc32(datos);

    const l = new DataView(new ArrayBuffer(30));
    l.setUint32(0, 0x04034b50, true);     // firma de encabezado local
    l.setUint16(4, 20, true);             // versión necesaria
    l.setUint16(6, 0x0800, true);         // nombres en UTF-8
    l.setUint16(8, 0, true);              // método 0 = STORE
    l.setUint16(10, 0, true);             // hora
    l.setUint16(12, 0x21, true);          // fecha (1980-01-01): fija, el pase no la usa
    l.setUint32(14, crc, true);
    l.setUint32(18, datos.length, true);  // tamaño comprimido = real
    l.setUint32(22, datos.length, true);
    l.setUint16(26, nombre.length, true);
    l.setUint16(28, 0, true);
    locales.push(new Uint8Array(l.buffer), nombre, datos);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);     // firma de directorio central
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, 0, true);
    c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, datos.length, true);
    c.setUint32(24, datos.length, true);
    c.setUint16(28, nombre.length, true);
    c.setUint32(42, desplazamiento, true);
    centrales.push(new Uint8Array(c.buffer), nombre);

    desplazamiento += 30 + nombre.length + datos.length;
  }

  const tamCentral = centrales.reduce((s, b) => s + b.length, 0);
  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true);
  fin.setUint16(8, archivos.length, true);
  fin.setUint16(10, archivos.length, true);
  fin.setUint32(12, tamCentral, true);
  fin.setUint32(16, desplazamiento, true);

  const partes = [...locales, ...centrales, new Uint8Array(fin.buffer)];
  const out = new Uint8Array(partes.reduce((s, b) => s + b.length, 0));
  let o = 0;
  for (const p of partes) { out.set(p, o); o += p.length; }
  return out;
}
