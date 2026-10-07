/* ===========================================================================
   TUTI'S — Lector de báscula (Web Serial)
   ---------------------------------------------------------------------------
   Pensado para la CAS PD-II de las tiendas, en "tYPE-5" (NCI General, el que
   el manual llama "Most POS Software"). Cómo se configura está en
   caja/LEEME.md.

   Cómo habla la báscula (protocolo NCI):
     · La caja manda  W<CR>  y la báscula contesta con el peso, sus unidades
       y unos bytes de estado:   <LF>0.452LB<CR><LF>00<CR><ETX>
     · Si el plato se está moviendo, el peso es negativo o pasa de su
       capacidad, contesta SOLO el estado, sin peso.
     · Los bytes de estado dicen si está en movimiento, en cero, si hay
       sobrecarga y —cuando la báscula lo manda— si se está usando TARA.

   Por qué importa el estado: la regla del negocio es que lo pesado queda
   fijo. Un peso que se toma mientras el plato todavía se mueve no es "lo
   pesado": por eso solo se acepta una lectura ESTABLE y reciente.

   También entiende básculas de salida continua (las que mandan una línea
   tras otra sin que se les pida). Ahí la estabilidad se deduce: tres
   lecturas seguidas iguales.

   Este archivo no sabe nada de ventas: solo entrega lecturas. Se puede
   probar en Node sin navegador (module.exports al final).
   =========================================================================== */
"use strict";

(function (global) {
  const G_POR = { LB: 453.59237, KG: 1000, OZ: 28.349523125, GM: 1, G: 1 };

  // Los caracteres de control se guardan visibles: esto queda en la venta
  // como prueba de lo que mandó la báscula, y tiene que poderse leer.
  function visible(txt) {
    return String(txt)
      .replace(/\x02/g, "<STX>").replace(/\x03/g, "<ETX>")
      .replace(/\r/g, "<CR>").replace(/\n/g, "<LF>")
      .replace(/[\x00-\x1F\x7F]/g, (c) => `<${c.charCodeAt(0).toString(16).padStart(2, "0")}>`)
      .slice(0, 60);
  }

  // Bytes de estado NCI. El bit 6 del primero siempre es 0, así que una "S"
  // al inicio (0x53) es el prefijo del protocolo ECR y no un estado.
  function leerEstado(linea) {
    let s = linea;
    if (s.length >= 3 && s[0] === "S") s = s.slice(1);
    if (s.length < 2 || s.length > 3) return null;
    const b = [...s].map((c) => c.charCodeAt(0) & 0x7f);
    // Los bits 4 y 5 de cada byte de estado siempre van en 1.
    if (!b.every((x) => (x & 0x30) === 0x30)) return null;
    return {
      movimiento: !!(b[0] & 1),
      enCero: !!(b[0] & 2),
      bajoCapacidad: !!(b[1] & 1),
      sobrecarga: !!(b[1] & 2),
      // Tercer byte: solo existe si el bit 6 del segundo lo anuncia.
      tara: b.length === 3 && (b[1] & 0x40) ? !!(b[2] & 4) : null,
    };
  }

  function leerPeso(linea) {
    let m = /^(-?)\s*(\d+)\s*LB\s+(\d+(?:\.\d+)?)\s*OZ$/i.exec(linea);
    if (m) {
      const oz = Number(m[2]) * 16 + Number(m[3]);
      return { gramos: (m[1] ? -1 : 1) * oz * G_POR.OZ, unidad: "LB-OZ", texto: linea };
    }
    m = /^(-?)\s*(\d*\.?\d+)\s*(LB|KG|OZ|GM|G)$/i.exec(linea);
    if (m) {
      const u = m[3].toUpperCase();
      return { gramos: (m[1] ? -1 : 1) * Number(m[2]) * G_POR[u], unidad: u, texto: linea };
    }
    return null;
  }

  // Un mensaje completo de la báscula (lo que llega antes de <ETX>).
  function interpretarNCI(trama) {
    const lineas = trama.split(/[\r\n\x02]+/).map((l) => l.trim()).filter(Boolean);
    if (lineas.length === 1 && lineas[0] === "?") return { desconocido: true, crudo: visible(trama) };
    let peso = null, estado = null;
    for (const l of lineas) {
      const p = leerPeso(l);
      if (p) { peso = p; continue; }
      const e = leerEstado(l);
      if (e) estado = e;
    }
    if (!peso && !estado) return null;
    return {
      gramos: peso ? Math.round(peso.gramos * 100) / 100 : null,
      unidad: peso ? peso.unidad : null,
      estable: !!peso && !!estado && !estado.movimiento && peso.gramos >= 0,
      estado,
      crudo: visible(trama),
    };
  }

  // Básculas de salida continua: "ST,GS,+  182.4 g", "US,GS,+0.183kg"...
  function interpretarContinua(linea, unidadPorDefecto) {
    const m = /(-?)\s*(\d*\.?\d+)\s*(kg|lb|oz|gm|g)?\b/i.exec(linea);
    if (!m) return null;
    const u = (m[3] || unidadPorDefecto || "g").toUpperCase();
    const gramos = (m[1] ? -1 : 1) * Number(m[2]) * (G_POR[u] || 1);
    let estable = null;
    if (/\bUS\b|\bMOTION\b/i.test(linea)) estable = false;
    else if (/\bST\b/i.test(linea)) estable = true;
    return { gramos: Math.round(gramos * 100) / 100, unidad: u, estable, estado: null, crudo: visible(linea) };
  }

  /* --- La conexión ---------------------------------------------------------- */
  function crear(opciones) {
    const cfg = Object.assign({
      baudRate: 9600, dataBits: 7, parity: "even", stopBits: 1,
      cadaMs: 300, unidadPorDefecto: "g",
    }, opciones || {});

    const b = {
      puerto: null, lector: null, escritor: null,
      ultima: null,        // última lectura con peso: {gramos, estable, ..., at}
      ultimoEstado: null,  // último estado aunque no traiga peso
      historial: [],       // para deducir estabilidad en salida continua
      protocolo: null,     // "nci" | "continua"
      oyentes: new Set(),
      timer: null,
      conectada: false,
    };

    function avisar() { b.oyentes.forEach((f) => { try { f(b); } catch (e) {} }); }

    function registrar(lectura) {
      if (!lectura) return;
      lectura.at = Date.now();
      if (lectura.desconocido) { b.protocolo = "continua"; return; }
      if (lectura.estado) b.ultimoEstado = lectura.estado;
      if (lectura.gramos == null) {
        // Solo estado: el plato se mueve, peso negativo o sobrecarga.
        b.ultima = Object.assign({}, lectura, { estable: false });
        avisar();
        return;
      }
      // Sin bytes de estado, la estabilidad se deduce de las últimas lecturas.
      if (lectura.estable == null || (!lectura.estado && b.protocolo !== "nci")) {
        b.historial.push(lectura);
        if (b.historial.length > 5) b.historial.shift();
        const ult = b.historial.slice(-3);
        const iguales = ult.length === 3 && ult.every((x) => Math.abs(x.gramos - ult[0].gramos) <= 0.5);
        lectura.estable = lectura.estable === false ? false : iguales;
      }
      b.ultima = lectura;
      avisar();
    }

    async function bucleLectura() {
      const decoder = new TextDecoderStream();
      b.puerto.readable.pipeTo(decoder.writable).catch(() => {});
      b.lector = decoder.readable.getReader();
      let buf = "";
      try {
        while (true) {
          const { value, done } = await b.lector.read();
          if (done) break;
          buf += value;
          // NCI: cada mensaje termina en <ETX>.
          let i;
          while ((i = buf.indexOf("\x03")) >= 0) {
            const trama = buf.slice(0, i); buf = buf.slice(i + 1);
            b.protocolo = "nci";
            registrar(interpretarNCI(trama));
          }
          // Salida continua: líneas sueltas, sin <ETX>.
          if (b.protocolo !== "nci") {
            const lineas = buf.split(/\r\n|\r|\n/);
            buf = lineas.pop() || "";
            lineas.filter((l) => l.trim()).forEach((l) => {
              const n = interpretarNCI(l);
              if (n && n.desconocido) { b.protocolo = "continua"; return; }
              registrar(interpretarContinua(l, cfg.unidadPorDefecto));
            });
          }
          if (buf.length > 500) buf = buf.slice(-100);
        }
      } catch (e) {
        // se desconectó
      } finally {
        b.conectada = false;
        avisar();
      }
    }

    async function pedir() {
      if (!b.escritor) return;
      try { await b.escritor.write(new TextEncoder().encode("W\r")); } catch (e) {}
    }

    async function abrir(puerto) {
      await puerto.open({ baudRate: cfg.baudRate, dataBits: cfg.dataBits, parity: cfg.parity, stopBits: cfg.stopBits });
      b.puerto = puerto;
      b.escritor = puerto.writable ? puerto.writable.getWriter() : null;
      b.conectada = true;
      b.ultima = null; b.historial = []; b.protocolo = null;
      bucleLectura();
      clearInterval(b.timer);
      b.timer = setInterval(pedir, cfg.cadaMs);
      pedir();
      avisar();
    }

    async function cerrar() {
      clearInterval(b.timer);
      try { if (b.lector) await b.lector.cancel(); } catch (e) {}
      try { if (b.escritor) b.escritor.releaseLock(); } catch (e) {}
      try { if (b.puerto) await b.puerto.close(); } catch (e) {}
      b.puerto = null; b.lector = null; b.escritor = null; b.conectada = false;
      avisar();
    }

    // Espera hasta `ms` a que llegue CUALQUIER respuesta. Sirve para saber
    // si en ese puerto hay de verdad una báscula.
    function esperarRespuesta(ms) {
      const desde = Date.now();
      return new Promise((res) => {
        const t = setInterval(() => {
          const viva = (b.ultima && b.ultima.at >= desde) || b.protocolo;
          if (viva || Date.now() - desde > ms) { clearInterval(t); res(!!viva); }
        }, 100);
      });
    }

    return Object.assign(b, {
      soportada: () => typeof navigator !== "undefined" && "serial" in navigator,
      escuchar: (f) => { b.oyentes.add(f); return () => b.oyentes.delete(f); },
      cerrar,

      // Elegir el puerto a mano (requiere un clic de la cajera).
      async elegir() {
        const p = await navigator.serial.requestPort();
        if (b.puerto) await cerrar();
        await abrir(p);
        return true;
      },

      // Reconectar sola al abrir la caja, con los puertos que ya tienen
      // permiso (o todos, si el modo kiosko los autorizó por política).
      // Si hay varios, se queda con el primero que conteste.
      async auto() {
        if (!this.soportada() || b.conectada) return b.conectada;
        const puertos = await navigator.serial.getPorts();
        if (!puertos.length) return false;
        for (const p of puertos) {
          try {
            await abrir(p);
            if (puertos.length === 1 || await esperarRespuesta(1500)) return true;
            await cerrar();
          } catch (e) {
            try { await cerrar(); } catch (e2) {}
          }
        }
        return false;
      },

      // Una lectura ESTABLE y reciente. Si en `ms` no se estabiliza, falla
      // con el motivo, para decírselo a la cajera tal cual.
      capturar(ms) {
        const limite = Date.now() + (ms || 4000);
        return new Promise((res, rej) => {
          const t = setInterval(() => {
            const l = b.ultima, e = b.ultimoEstado;
            if (!b.conectada) { clearInterval(t); rej(new Error("La báscula no está conectada.")); return; }
            if (l && Date.now() - l.at < 900) {
              if (e && e.sobrecarga) { clearInterval(t); rej(new Error("La báscula marca sobrecarga.")); return; }
              if (l.estado && l.estado.tara) {
                clearInterval(t);
                rej(new Error("La báscula tiene TARA puesta. Quita todo, presiona CERO con el plato vacío y vuelve a pesar."));
                return;
              }
              if (l.estable && l.gramos != null && l.gramos >= 0) { clearInterval(t); res(Object.assign({}, l)); return; }
            }
            if (Date.now() > limite) {
              clearInterval(t);
              rej(new Error(!l || Date.now() - l.at >= 900
                ? "La báscula no responde. Revisa que esté encendida y el cable puesto."
                : "La báscula no se estabiliza. Deja quieto el vaso un momento."));
            }
          }, 100);
        });
      },
    });
  }

  const api = { crear, interpretarNCI, interpretarContinua, visible, G_POR };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.Bascula = api;
})(typeof window !== "undefined" ? window : globalThis);
