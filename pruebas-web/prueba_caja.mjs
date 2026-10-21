// Prueba de punta a punta de la pantalla de venta con báscula simulada.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const BASE = "http://127.0.0.1:8799/";
const fakeSb = fs.readFileSync(path.join(AQUI, "fake-supabase.js"), "utf8");
const fakeSerial = fs.readFileSync(path.join(AQUI, "fake-serial.js"), "utf8");

let fallas = 0;
function ok(cond, msg, extra) {
  if (cond) console.log("[ OK ]", msg);
  else { fallas++; console.log("[FALLA]", msg, extra === undefined ? "" : JSON.stringify(extra)); }
}

const browser = await chromium.launch();

const configReal = fs.readFileSync(path.join(AQUI, "..", "web", "config.js"), "utf8");

async function abrir(rol, { serial = true, huella = false, fuera = false, movil = false } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: "block",
    ...(movil ? { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 },
                  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } : {}) });
  await ctx.addInitScript((r) => { if (!localStorage.getItem("fake_role")) localStorage.setItem("fake_role", r); }, rol);
  if (fuera) await ctx.addInitScript(() => { if (!sessionStorage.getItem("ya")) { localStorage.setItem("fake_logged_out", "1"); sessionStorage.setItem("ya", "1"); } });
  // La huella se prende o se apaga en la prueba, sin importar cómo esté config.js.
  await ctx.route("**/config.js", (r) => r.fulfill({ contentType: "application/javascript", body: configReal.replace(/PASSKEYS:\s*(true|false)/, `PASSKEYS: ${huella}`) }));
  if (serial) await ctx.addInitScript(fakeSerial);
  await ctx.route("**/vendor/supabase.min.js", (r) => r.fulfill({ contentType: "application/javascript", body: fakeSb }));
  const page = await ctx.newPage();
  const errores = [];
  page.on("pageerror", (e) => errores.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errores.push(m.text()); });
  await page.goto(BASE + "index.html");
  await page.waitForSelector(fuera ? "#login-screen:not([hidden])" : "#app:not([hidden])");
  return { ctx, page, errores };
}
const rpcs = (page, name) => page.evaluate((n) => JSON.parse(localStorage.getItem("fake_rpcs") || "[]").filter((x) => x.name === n), name);
const ponerBascula = (page, v) => page.evaluate((v) => Object.assign(window.__scale, v), v);
const texto = (page, sel) => page.locator(sel).innerText();

/* ---------------- Cajera, con báscula ---------------- */
{
  const { ctx, page, errores } = await abrir("cajera");
  await page.waitForFunction(() => document.querySelector("#scale-status").textContent !== "Sin conectar");
  const opts = await page.evaluate(() => window.__openOpts);
  ok(opts && opts.baudRate === 9600 && opts.dataBits === 7 && opts.parity === "even" && opts.stopBits === 1,
     "1 se conecta sola a la báscula con 9600 7E1 (CAS PD-II)", opts);
  ok(await page.locator("#inp-ice-weight").isHidden(), "2 el peso del helado NO es un campo editable");
  ok(await page.locator("#inp-cup-weight").count() === 0, "2b la tara del vaso ya no se teclea");
  ok((await texto(page, "#cup-tare-hint")).includes("15"), "2c la tara sale del catálogo (15 g)");

  // Topping antes del helado: no.
  await page.click("#topping-chips .chip");
  await page.click("#order-rows .order-row button.btn");
  ok((await texto(page, "#scale-status")).includes("Primero pesa el helado"), "3 no deja pesar un topping antes que el helado");

  // Helado: vaso (15) + 150 g = 165 g en la báscula.
  await ponerBascula(page, { g: 165, motion: false });
  await page.waitForFunction(() => document.querySelector("#scale-reading").textContent.includes("165"));
  await page.click("#btn-weigh-ice");
  await page.waitForFunction(() => document.querySelector("#out-ice-weight").textContent.includes("150"));
  ok(true, "4 Pesar helado: 165 − 15 de tara = 150 g");
  ok(await page.locator("#btn-weigh-ice").isHidden(), "4b el botón de pesar helado desaparece: ya quedó fijo");
  ok(await page.locator("#sel-cup").isDisabled(), "4c ya no se puede cambiar el vaso (cambiaría la tara)");
  ok(!!(await page.evaluate(() => localStorage.getItem("tutis_pedido_en_curso"))), "4d el pedido en curso quedó guardado en el navegador");

  // Topping: la báscula sube a 195, primero moviéndose.
  await ponerBascula(page, { g: 195, motion: true });
  const pesarTopping = page.click("#order-rows .order-row button.btn");
  await page.waitForTimeout(600);
  ok((await page.locator("#order-rows .weigh-lock").count()) === 0, "5 mientras el plato se mueve, no toma el peso");
  await ponerBascula(page, { motion: false });
  await pesarTopping;
  await page.waitForSelector("#order-rows .weigh-lock");
  ok((await texto(page, "#order-rows .order-row")).includes("30"), "5b al estabilizarse toma 195 − 165 = 30 g");
  ok((await page.locator("#order-rows .row-remove").count()) === 0, "5c la línea pesada ya no se puede quitar");

  const total = await texto(page, "#ticket-totals .tt-total");
  ok(total.includes("87.75"), "6 150 g + 30 g + vaso 15 g a 0.45/g = 87.75", total);

  await page.click("#btn-charge");
  await page.waitForSelector("#receipt-modal:not([hidden])");
  const venta = (await rpcs(page, "process_sale")).pop();
  const p = venta && venta.args.payload;
  ok(p && p.weight_mode === "bascula" && Math.abs(p.scale_gross_g - 195) < 0.01 && p.scale_log.length === 2,
     "7 la venta lleva modo báscula, la lectura bruta (195 g) y las dos lecturas", p && { m: p.weight_mode, g: p.scale_gross_g, n: p.scale_log && p.scale_log.length });
  ok(p && p.scale_log[0].crudo.includes("KG") && p.scale_log[0].crudo.includes("<ETX>") === false,
     "7b cada lectura guarda el texto crudo de la báscula", p && p.scale_log[0]);
  const suma = p.lines.filter((l) => ["helado", "topping", "vaso"].includes(l.item_type)).reduce((s, l) => s + l.weight_g, 0);
  ok(Math.abs(suma - p.scale_gross_g) <= 1, "7c las líneas suman lo que marcó la báscula (lo que revisa el servidor)", suma);
  ok(!(await page.evaluate(() => localStorage.getItem("tutis_pedido_en_curso"))), "7d al cobrar se borra el pedido en curso");
  await page.click("#btn-close-receipt");
  ok(await page.locator("#btn-weigh-ice").isVisible() && !(await page.locator("#sel-cup").isDisabled()), "7e la siguiente venta arranca limpia");

  // TARA puesta en la báscula.
  await ponerBascula(page, { g: 150, tara: true });
  await page.waitForTimeout(500);
  await page.click("#btn-weigh-ice");
  await page.waitForFunction(() => document.querySelector("#scale-status").textContent.includes("TARA"));
  ok((await texto(page, "#out-ice-weight")).trim() === "—", "8 con TARA puesta en la báscula no acepta el peso");
  await ponerBascula(page, { tara: false });

  // Pedido pesado y anulado con el botón.
  await ponerBascula(page, { g: 115 });
  await page.waitForTimeout(500);
  await page.click("#btn-weigh-ice");
  await page.waitForFunction(() => document.querySelector("#out-ice-weight").textContent.includes("100"));
  page.once("dialog", (d) => d.accept("La clienta se fue"));
  await page.click("#btn-void-order");
  await page.waitForFunction(() => document.querySelector("#out-ice-weight").textContent.trim() === "—");
  const anul = (await rpcs(page, "registrar_anulacion")).pop();
  ok(anul && anul.args.payload.reason === "La clienta se fue" && anul.args.payload.weighed_g === 100,
     "9 anular un pedido pesado lo registra con motivo y peso", anul && anul.args.payload);

  // Pedido pesado y la caja se recarga.
  await ponerBascula(page, { g: 215 });
  await page.waitForTimeout(500);
  await page.click("#btn-weigh-ice");
  await page.waitForFunction(() => document.querySelector("#out-ice-weight").textContent.includes("200"));
  await page.reload();
  await page.waitForSelector("#app:not([hidden])");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("fake_rpcs") || "[]").filter((x) => x.name === "registrar_anulacion").length >= 2);
  const recarga = (await rpcs(page, "registrar_anulacion")).pop();
  ok(recarga && /recarg/.test(recarga.args.payload.reason) && recarga.args.payload.weighed_g === 200,
     "10 recargar la caja con un pedido pesado lo deja registrado como anulado", recarga && recarga.args.payload);

  // Pesos a mano con PIN.
  page.once("dialog", (d) => d.accept());
  await page.click("#btn-manual-mode");
  ok(await page.locator("#inp-ice-weight").isVisible() && await page.locator("#manual-banner").isVisible(), "11 modo a mano: aparecen los campos y el aviso");
  await page.fill("#inp-ice-weight", "150");
  await page.click("#topping-chips .chip");
  await page.fill("#order-rows .order-row input", "30");
  await page.click("#btn-charge");
  await page.waitForSelector("#pin-modal:not([hidden])");
  await page.waitForFunction(() => !document.querySelector("#btn-pin-ok").disabled);
  ok((await texto(page, "#pin-summary")).includes("180"), "12 la gerente ve el total tecleado (180 g) antes de autorizar");
  await page.fill("#pin-code", "0000");
  await page.click("#btn-pin-ok");
  await page.waitForFunction(() => document.querySelector("#pin-msg").textContent.includes("incorrecto"));
  ok(await page.locator("#receipt-modal").isHidden(), "12b con PIN equivocado no se cobra");
  await page.fill("#pin-code", "4829");
  await page.click("#btn-pin-ok");
  await page.waitForSelector("#receipt-modal:not([hidden])");
  const aut = (await rpcs(page, "autorizar_peso_manual")).pop();
  ok(aut && aut.args.p_weight_g === 180 && aut.args.p_manager_id === "G1", "12c se pidió autorizar exactamente 180 g a la gerente elegida", aut && aut.args);
  const vm = (await rpcs(page, "process_sale")).pop().args.payload;
  ok(vm.weight_mode === "manual" && vm.weight_auth_id === "AUTH-1", "12d la venta lleva la autorización", { m: vm.weight_mode, a: vm.weight_auth_id });
  await page.click("#btn-close-receipt");

  // Pesos a mano sin internet.
  await ctx.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.fill("#inp-ice-weight", "120");
  page.once("dialog", (d) => d.accept());
  await page.click("#btn-charge");
  await page.waitForSelector("#receipt-modal:not([hidden])");
  const cola = await page.evaluate(() => JSON.parse(localStorage.getItem("tutis_pending_sales") || "[]"));
  ok(cola.length === 1 && cola[0].weight_mode === "manual_sin_conexion", "13 sin internet se cobra y queda como 'a mano sin conexión' en la cola", cola.map((c) => c.weight_mode));
  await ctx.setOffline(false);

  ok(errores.length === 0, "14 sin errores de JavaScript en la consola", errores);
  await page.screenshot({ path: path.join(AQUI, "caja.png"), fullPage: true });
  await ctx.close();
}

/* ---------------- Gerente: PIN y reporte ---------------- */
{
  const { ctx, page, errores } = await abrir("gerente");
  await page.click('.tab-btn[data-tab="config"]');
  await page.waitForFunction(() => document.querySelector("#pin-status").textContent.length > 0);
  ok((await texto(page, "#pin-status")).includes("Todavía no tienes PIN"), "15 la gerente ve que no tiene PIN");
  await page.fill("#cfg-pin", "4829"); await page.fill("#cfg-pin2", "4830");
  await page.click("#btn-save-pin");
  ok((await texto(page, "#pin-saved")).includes("no coinciden"), "15b si no coinciden, no se guarda");
  await page.fill("#cfg-pin", "1234"); await page.fill("#cfg-pin2", "1234");
  await page.click("#btn-save-pin");
  await page.waitForFunction(() => document.querySelector("#pin-saved").textContent.includes("fácil"));
  ok(true, "15c el mensaje del servidor (PIN fácil) llega a la pantalla");
  await page.fill("#cfg-pin", "4829"); await page.fill("#cfg-pin2", "4829");
  await page.click("#btn-save-pin");
  await page.waitForFunction(() => document.querySelector("#pin-saved").textContent.includes("guardado"));
  ok((await rpcs(page, "set_manager_pin")).pop().args.p_pin === "4829", "15d PIN guardado");

  await page.click('.tab-btn[data-tab="reportes"]');
  await page.waitForSelector("#table-wc-incidents tbody tr td");
  const filas = await page.locator("#table-wc-cashiers tbody tr").count();
  ok(filas === 1 && (await page.locator("#table-wc-cashiers tbody tr.row-bad").count()) === 1, "16 el reporte marca a la cajera con ventas a mano SIN PIN");
  const html = await page.locator("#table-wc-incidents").innerHTML();
  ok(html.includes("&lt;b&gt;") && !html.includes("<b>Galerías"), "16b los nombres del reporte pasan por esc()");
  ok((await texto(page, "#table-wc-incidents")).includes("Peso a mano SIN PIN"), "16c el incidente se describe con texto, no solo con color");
  ok(errores.filter((e) => !/no simulado/.test(e)).length === 0, "17 sin errores de JavaScript (gerente)", errores);
  await page.screenshot({ path: path.join(AQUI, "reporte.png"), fullPage: true });
  await ctx.close();
}

/* ---------------- Sin Web Serial (Safari/iPad) ---------------- */
{
  const { ctx, page, errores } = await abrir("cajera", { serial: false });
  await page.evaluate(() => { try { delete navigator.serial; } catch (e) {} });
  ok((await texto(page, "#scale-status")).length > 0, "18 sin Web Serial la caja abre y lo dice", await texto(page, "#scale-status"));
  ok(errores.length === 0, "18b sin errores", errores);
  await ctx.close();
}

/* ---------------- Huella del teléfono ---------------- */
{
  // Sin la bandera en config.js, no aparece nada de huella.
  const a = await abrir("cajera", { fuera: true });
  ok(await a.page.locator("#btn-login-passkey").isHidden(), "19 con PASSKEYS apagado no aparece 'entrar con huella'");
  await a.ctx.close();

  const { ctx, page, errores } = await abrir("cajera", { huella: true, fuera: true });
  ok(await page.locator("#btn-login-passkey").isVisible(), "20 con PASSKEYS encendido aparece 'entrar con huella'");
  await page.click("#btn-login-passkey");
  await page.waitForSelector("#app:not([hidden])");
  const login = (await rpcs(page, "signInWithPasskey")).pop();
  ok(login && login.args.cliente === 1 && login.args.experimental && login.args.experimental.passkey === true,
     "20b entra con passkey en el cliente principal, con la opción experimental encendida", login && login.args);

  await page.click("#btn-mi-huella");
  await page.waitForSelector("#huella-modal:not([hidden])");
  ok(await page.locator("#btn-huella-registrar").isHidden() && await page.locator("#huella-solo-telefono").isVisible(),
     "21 en la computadora de la caja NO se ofrece registrar huella");
  await page.waitForSelector("#table-huellas tbody tr td button");
  ok((await page.locator("#table-huellas").innerHTML()).includes("&lt;i&gt;Ana"), "21b el nombre del dispositivo pasa por esc()");
  page.once("dialog", (d) => d.accept());
  await page.click("#table-huellas tbody tr td button");
  await page.waitForFunction(() => document.querySelector("#huella-msg").textContent.includes("Borrado"));
  ok((await rpcs(page, "deletePasskey")).pop().args.passkeyId === "PK1", "21c se puede borrar un teléfono registrado");
  await page.click("#btn-huella-cerrar");

  // Peso a mano autorizado con la huella de la gerente.
  page.once("dialog", (d) => d.accept());
  await page.click("#btn-manual-mode");
  await page.fill("#inp-ice-weight", "150");
  await page.click("#topping-chips .chip");
  await page.fill("#order-rows .order-row input", "30");
  await page.click("#btn-charge");
  await page.waitForSelector("#pin-modal:not([hidden])");
  ok(await page.locator("#btn-pin-passkey").isVisible(), "22 la ventana de autorización ofrece la huella");
  await page.click("#btn-pin-passkey");
  await page.waitForSelector("#receipt-modal:not([hidden])");
  const aut = (await rpcs(page, "autorizar_peso_presencial")).pop();
  ok(aut && aut.args.p_requested_by === "U1" && aut.args.p_weight_g === 180, "22b autoriza 180 g a nombre de la cajera que cobra", aut && aut.args);
  const ses = (await rpcs(page, "signInWithPasskey")).pop();
  ok(ses.args.cliente > 1, "22c la huella de la gerente abre una sesión APARTE, no la de la cajera", ses.args);
  const salida = (await rpcs(page, "signOut")).pop();
  ok(salida && salida.args.cliente === ses.args.cliente && salida.args.scope === "local", "22d y esa sesión se cierra enseguida", salida && salida.args);
  const v = (await rpcs(page, "process_sale")).pop().args.payload;
  ok(v.weight_mode === "manual" && v.weight_auth_id === "AUTH-H", "22e la venta lleva la autorización por huella");
  ok(errores.length === 0, "23 sin errores de JavaScript (huella)", errores);
  await ctx.close();

  const m = await abrir("cajera", { huella: true, movil: true });
  await m.page.click("#btn-mi-huella");
  ok(await m.page.locator("#btn-huella-registrar").isVisible(), "24 desde el teléfono sí se ofrece registrar");
  await m.page.click("#btn-huella-registrar");
  await m.page.waitForFunction(() => document.querySelector("#huella-msg").textContent.includes("Listo"));
  ok((await rpcs(m.page, "registerPasskey")).length === 1, "24b registra la passkey");
  await m.page.screenshot({ path: path.join(AQUI, "huella_movil.png") });
  await m.ctx.close();

  const g = await abrir("gerente", { huella: true });
  await g.page.click('.tab-btn[data-tab="reportes"]');
  await g.page.waitForSelector("#table-wc-incidents tbody tr td");
  ok((await texto(g.page, "#table-wc-incidents")).includes("(huella)"), "25 el reporte dice si se autorizó con huella o con PIN");

  // Libro de ventas en formato ICG: se descarga un .xlsx de verdad.
  await g.page.evaluate(() => localStorage.setItem("fake_sales", JSON.stringify([
    { location_id: "L1", created_at: "2026-10-02T03:30:00Z", folio: 2, customer_name: "", customer_tax_id: null, total_price: 262.14, discount: 0 },
    { location_id: "L1", created_at: "2026-10-01T15:00:00Z", folio: 1, customer_name: "Ana <b>López</b>", customer_tax_id: "08011999000001", total_price: 100, discount: 20 },
  ])));
  await g.page.reload(); await g.page.waitForSelector("#app:not([hidden])");
  await g.page.click('.tab-btn[data-tab="reportes"]');
  ok(/^\d{4}-\d{2}-01$/.test(await g.page.inputValue("#lv-from")), "26 el libro arranca en el primero del mes");
  await g.page.fill("#lv-from", "2026-10-01"); await g.page.fill("#lv-to", "2026-10-31");
  const [descarga] = await Promise.all([g.page.waitForEvent("download"), g.page.click("#btn-lv-download")]);
  const destino = path.join(process.env.LIBRO_DESTINO || AQUI, "libro-prueba.xlsx");
  await descarga.saveAs(destino);
  ok(descarga.suggestedFilename() === "libro-ventas_Tuti-s-Galer-as_2026-10-01_2026-10-31.xlsx", "26b el archivo se llama por tienda y fechas", descarga.suggestedFilename());
  ok(fs.statSync(destino).size > 1000 && fs.readFileSync(destino).subarray(0, 2).toString() === "PK", "26c es un .xlsx (zip)");
  ok(g.errores.length === 0, "26d sin errores de JavaScript (libro)", g.errores);

  // Cierre por forma de pago
  const pago = await texto(g.page, "#table-closing-pay");
  ok(pago.includes("Efectivo") && pago.includes("170.50") && pago.includes("Tarjeta") && pago.includes("250.50"),
     "27 el cierre cuadra por forma de pago, con su total", pago);
  ok((await texto(g.page, "#closing-pay-note")).includes("Pedidos anulados: 1"), "27b y dice los descuentos y los pedidos anulados");

  // Libro de compras
  await g.page.click('.tab-btn[data-tab="compras"]');
  ok(await g.page.isDisabled("#nc-location"), "28 la gerente solo registra compras de su tienda");
  await g.page.fill("#nc-supplier", "Distribuidora <b>DCR</b>");
  await g.page.fill("#nc-rtn", "0801-1");
  await g.page.fill("#nc-g15", "100");
  ok((await g.page.inputValue("#nc-isv15")) === "15.00", "28b el ISV se calcula solo con el gravado");
  await g.page.click("#btn-nc-add");
  ok((await texto(g.page, "#nc-msg")).includes("14 dígitos") && (await rpcs(g.page, "insert:purchases")).length === 0, "28c un RTN incompleto no se registra");
  await g.page.fill("#nc-rtn", "08019013602834"); await g.page.fill("#nc-isv15", "14.99"); await g.page.fill("#nc-g15", "100.00");
  ok((await g.page.inputValue("#nc-isv15")) === "14.99", "28d si se corrige el ISV a mano, ya no se pisa");
  await g.page.fill("#nc-exento", "280"); await g.page.fill("#nc-invoice", "000-001-01-00020106");
  await g.page.click("#btn-nc-add");
  await g.page.waitForFunction(() => document.querySelector("#nc-msg").textContent.includes("registrada"));
  const compra = (await rpcs(g.page, "insert:purchases")).pop().args;
  ok(compra.compra === "materia_tienda" && compra.location_id === "L1" && compra.gravado15 === 100 && compra.isv15 === 14.99
     && compra.exento === 280 && compra.supplier_rtn === "08019013602834" && !("created_by" in compra),
     "28e la compra va completa y sin firmar a nombre de nadie (lo pone la base)", compra);
  ok(g.errores.length === 0, "28f sin errores de JavaScript (compras)", g.errores);
  await g.ctx.close();
}

await browser.close();
console.log(fallas ? `\n${fallas} FALLA(S)` : "\nTODAS LAS PRUEBAS DE LA CAJA PASARON");
process.exit(fallas ? 1 : 0);
