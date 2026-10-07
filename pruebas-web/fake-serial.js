// Báscula CAS PD-II simulada, en modo NCI: contesta a "W\r" con el peso en
// kilos y dos bytes de estado. Se controla con window.__scale.
(function () {
  window.__scale = { g: 0, motion: false, tara: false, unit: "KG", on: true };
  window.__openOpts = null;
  function respuesta() {
    const s = window.__scale;
    const b1 = String.fromCharCode(0x30 | (s.motion ? 1 : 0) | (s.g === 0 ? 2 : 0));
    let est = b1 + (s.tara ? String.fromCharCode(0x30 | 0x40) + String.fromCharCode(0x30 | 4) : "0");
    if (s.motion) return `\n${est}\r\x03`;            // ECR: en movimiento solo manda estado
    const peso = s.unit === "LB" ? `${(s.g / 453.59237).toFixed(3)}LB` : `${(s.g / 1000).toFixed(3)}KG`;
    return `\n${peso}\r\n${est}\r\x03`;
  }
  let ctrl;
  const port = {
    async open(opts) { window.__openOpts = opts; },
    async close() {},
    getInfo() { return { usbVendorId: 0x067b, usbProductId: 0x2303 }; },
    readable: new ReadableStream({ start(c) { ctrl = c; } }),
    writable: new WritableStream({
      write(chunk) {
        const txt = new TextDecoder().decode(chunk);
        if (txt === "W\r" && window.__scale.on) setTimeout(() => ctrl.enqueue(new TextEncoder().encode(respuesta())), 20);
      },
    }),
  };
  const serial = new EventTarget();
  serial.getPorts = async () => [port];
  serial.requestPort = async () => port;
  Object.defineProperty(navigator, "serial", { value: serial, configurable: true });
})();
