/* ===========================================================================
   TUTI'S — Libro de ventas en el formato del "Reporte fiscal de ventas" de ICG
   ---------------------------------------------------------------------------
   Es el Excel que el contador recibe hoy de FrontRetail (rptVentasFRetail):
   mismas columnas, mismo orden y fila de TOTALES al final, para que lo pueda
   trabajar igual.

   Lo que NO es: un libro fiscal. Mientras no esté conectada la facturación
   de la SAR, cada venta es un comprobante interno: la columna CAI va vacía,
   el tipo de documento dice "COMPROBANTE INTERNO" y el correlativo es el
   folio interno de la tienda. El título lo dice. No se inventa un CAI ni un
   correlativo con forma de factura.

   El ISV se SEPARA del total cobrado (el precio al cliente ya lo incluye):
   gravado = total / 1.15 redondeado a centavos, ISV = total − gravado. Así
   gravado + ISV da exactamente lo cobrado, factura por factura. El
   descuento (canje de puntos) va aparte, como en ICG, donde el gravado ya
   viene con el descuento restado.

   El .xlsx se arma a mano (ZIP sin compresión + XML). No puede haber
   librería: la CSP de la caja es script-src 'self'. Se prueba en Node
   (module.exports al final).
   =========================================================================== */
"use strict";

(function (global) {
  // Tasa general del impuesto sobre ventas por país.
  const TASA = { HN: 0.15, GT: 0.12, SV: 0.13 };
  const cent = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

  /* --- Las filas del libro -------------------------------------------------- */
  // ventas: filas de `sales` (created_at, folio, customer_name,
  // customer_tax_id, total_price, discount). desfase: horas respecto a UTC.
  function filasLibro(ventas, pais, desfase) {
    const tasa = TASA[pais] ?? TASA.HN;
    const off = Number(desfase ?? -6);
    return ventas
      .slice()
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.folio || 0) - (b.folio || 0)))
      .map((s) => {
        const total = cent(s.total_price || 0);
        const gravado = cent(total / (1 + tasa));
        const isv = cent(total - gravado);
        // Fecha de la tienda, no la UTC: se corre el desfase y luego se lee.
        const dia = new Date(new Date(s.created_at).getTime() + off * 3600e3).toISOString().slice(0, 10);
        return {
          dia,
          rtn: (s.customer_tax_id || "").trim(),
          nombre: (s.customer_name || "").trim() || "Clientes varios",
          tipo: "COMPROBANTE INTERNO",
          cai: "",
          correlativo: s.folio == null ? "" : String(s.folio),
          exento: 0, exonerado: 0, gravado, gravado18: 0,
          totalImportes: gravado,
          descuento: cent(s.discount || 0),
          isv, isv18: 0, totalImpuesto: isv,
          total,
        };
      });
  }

  function totales(filas) {
    const t = { exento: 0, exonerado: 0, gravado: 0, gravado18: 0, totalImportes: 0, descuento: 0, isv: 0, isv18: 0, totalImpuesto: 0, total: 0 };
    filas.forEach((f) => Object.keys(t).forEach((k) => { t[k] += f[k]; }));
    Object.keys(t).forEach((k) => { t[k] = cent(t[k]); });
    return t;
  }

  /* --- La hoja, igual que la de ICG ----------------------------------------- */
  // Devuelve una matriz [fila][columna] desde A1; null = celda vacía.
  // Cada celda: string, number o { fecha: "AAAA-MM-DD" }.
  function hojaLibro({ tienda, pais, desde, hasta, ventas, desfase }) {
    const pct = Math.round((TASA[pais] ?? TASA.HN) * 100);
    const filas = filasLibro(ventas, pais, desfase);
    const t = totales(filas);
    const fecha = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
    const m = [
      [],
      [null, "REPORTE DE VENTAS (formato del libro fiscal) — COMPROBANTES INTERNOS, NO FISCALES"],
      [null, "Fecha inicial:", fecha(desde)],
      [null, "Fecha final:", fecha(hasta)],
      [null, "Punto de venta:", tienda],
      [null, "Sin CAI: el correlativo es el folio interno de la tienda. El ISV se separa del total cobrado."],
      [null, "DD-MM-AAAA", "RTN CLIENTE", "NOMBRE CLIENTE O RAZÓN", "TIPO DOCUMENTO", "CAI", "NÚMERO CORRELATIVO",
        "IMPORTE EXENTO", "IMPORTE EXONERADO", `IMPORTE GRAVADO ${pct}%`, "IMPORTE GRAVADO 18%", "TOTAL IMPORTES",
        "DESCUENTO Y REBAJAS", `IMPUESTO ${pct}%`, "IMPUESTO 18%", "TOTAL IMPUESTO", "IMPORTE TOTAL"],
    ];
    filas.forEach((f) => m.push([null, { fecha: f.dia }, f.rtn, f.nombre, f.tipo, f.cai, f.correlativo,
      f.exento, f.exonerado, f.gravado, f.gravado18, f.totalImportes, f.descuento, f.isv, f.isv18, f.totalImpuesto, f.total]));
    m.push([null, "TOTALES", null, null, null, null, null,
      t.exento, t.exonerado, t.gravado, t.gravado18, t.totalImportes, t.descuento, t.isv, t.isv18, t.totalImpuesto, t.total]);
    return { matriz: m, filas, totales: t };
  }

  /* --- XLSX a mano ------------------------------------------------------------ */
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

  // ZIP "stored" (sin comprimir): Excel lo abre sin problema y no hace falta
  // un compresor. archivos: [{ nombre, datos: Uint8Array }].
  function zip(archivos) {
    const enc = new TextEncoder(), partes = [], central = [];
    let off = 0;
    const u16 = (v) => [v & 255, (v >>> 8) & 255];
    const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    archivos.forEach(({ nombre, datos }) => {
      const n = enc.encode(nombre), crc = crc32(datos), len = datos.length;
      // Fecha DOS fija (1/1/2026): no aporta nada y así el archivo es reproducible.
      const comun = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16((2026 - 1980) << 9 | 1 << 5 | 1), ...u32(crc), ...u32(len), ...u32(len), ...u16(n.length), ...u16(0)];
      const local = new Uint8Array([...u32(0x04034b50), ...comun, ...n]);
      partes.push(local, datos);
      central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...comun, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off), ...n]));
      off += local.length + len;
    });
    const tamCentral = central.reduce((a, c) => a + c.length, 0);
    const fin = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(archivos.length), ...u16(archivos.length), ...u32(tamCentral), ...u32(off), ...u16(0)]);
    const todo = [...partes, ...central, fin];
    const out = new Uint8Array(todo.reduce((a, p) => a + p.length, 0));
    let p = 0; todo.forEach((x) => { out.set(x, p); p += x.length; });
    return out;
  }

  const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    // Caracteres de control que XML no admite (un nombre pegado con basura).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  const colLetra = (i) => { let s = ""; i += 1; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
  // Días desde 1899-12-30, como cuenta Excel.
  const serialExcel = (d) => (Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 864e5;
  // Nombre de hoja: 31 caracteres y sin : \ / ? * [ ]
  const nombreHoja = (s, usados) => {
    let n = String(s).replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31) || "Hoja";
    let k = 2; const base = n;
    while (usados.has(n)) n = `${base.slice(0, 28)} ${k++}`;
    usados.add(n); return n;
  };

  // Estilos: 0 normal, 1 negrita, 2 fecha dd/mm/aaaa, 3 número 0.00, 4 número negrita, 5 título.
  // Todo en Arial (requisito del dueño, también en lo que se imprime).
  const ESTILOS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts>
<fonts count="3"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font><font><b/><sz val="12"/><name val="Arial"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function hojaXml(matriz, filaEncabezado) {
    const filas = matriz.map((fila, r) => {
      const negrita = r + 1 === filaEncabezado || r === matriz.length - 1;
      const celdas = fila.map((v, c) => {
        if (v == null || v === "") return "";
        const ref = colLetra(c) + (r + 1);
        if (typeof v === "number") return `<c r="${ref}" s="${negrita ? 4 : 3}"><v>${v}</v></c>`;
        if (v && v.fecha) return `<c r="${ref}" s="2"><v>${serialExcel(v.fecha)}</v></c>`;
        const s = r === 1 ? 5 : negrita || (c === 1 && r < filaEncabezado - 1) ? 1 : 0;
        return `<c r="${ref}" t="inlineStr" s="${s}"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
      }).join("");
      return celdas ? `<row r="${r + 1}">${celdas}</row>` : "";
    }).join("");
    const anchos = [3, 12, 16, 34, 22, 14, 20, 14, 14, 16, 16, 14, 16, 14, 12, 14, 14]
      .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${filaEncabezado}" topLeftCell="A${filaEncabezado + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${anchos}</cols><sheetData>${filas}</sheetData></worksheet>`;
  }

  // hojas: [{ nombre, matriz }]. Devuelve los bytes del .xlsx.
  function crearXlsx(hojas) {
    const enc = new TextEncoder(), usados = new Set();
    const nombres = hojas.map((h) => nombreHoja(h.nombre, usados));
    const f = (nombre, texto) => ({ nombre, datos: enc.encode(texto) });
    return zip([
      f("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${hojas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`),
      f("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
      f("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${nombres.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
      f("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
      f("xl/styles.xml", ESTILOS),
      ...hojas.map((h, i) => f(`xl/worksheets/sheet${i + 1}.xml`, hojaXml(h.matriz, 7))),
    ]);
  }

  const api = { TASA, filasLibro, totales, hojaLibro, crearXlsx, crc32 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.LibroVentas = api;
})(typeof window !== "undefined" ? window : globalThis);
