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

// PW_CHROME: usar otro Chromium ya instalado si el de Playwright no está.
const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {});

const configReal = fs.readFileSync(path.join(AQUI, "..", "web", "config.js"), "utf8");

async function abrir(rol, { serial = true, huella = false, fuera = false, movil = false, ls = {} } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: "block",
    ...(movil ? { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 },
                  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } : {}) });
  await ctx.addInitScript((r) => { if (!localStorage.getItem("fake_role")) localStorage.setItem("fake_role", r); }, rol);
  await ctx.addInitScript((o) => { Object.entries(o).forEach(([k, v]) => { if (localStorage.getItem(k) == null) localStorage.setItem(k, v); }); }, ls);
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
  // Pantalla táctil: todo se elige tocando cuadros grandes, no listas.
  const altoCuadro = (await page.locator("#tiles-cup .tile").first().boundingBox()).height;
  ok(altoCuadro >= 72 && (await page.locator("#sel-cup").isHidden()), "2d el vaso se elige con cuadros de al menos 72 px, sin lista desplegable", altoCuadro);
  await page.click('#tiles-spoon .tile:has-text("Sin cuchara")');
  ok(!(await page.isChecked("#chk-spoon")) && !(await texto(page, "#ticket-lines")).includes("Cuchara"), "2e 'Sin cuchara' la quita del ticket");
  await page.click('#tiles-spoon .tile:has-text("Cuchara")');
  ok(await page.isChecked("#chk-spoon"), "2f tocar una cuchara la vuelve a incluir");

  // Topping antes del helado: no.
  await page.click("#topping-chips .tile");
  await page.click("#order-rows .order-row button.btn");
  ok((await texto(page, "#scale-status")).includes("Primero pesa el helado"), "3 no deja pesar un topping antes que el helado");

  // Helado: vaso (15) + 150 g = 165 g en la báscula.
  await ponerBascula(page, { g: 165, motion: false });
  await page.waitForFunction(() => document.querySelector("#scale-reading").textContent.includes("165"));
  await page.click("#btn-weigh-ice");
  await page.waitForFunction(() => document.querySelector("#out-ice-weight").textContent.includes("150"));
  ok(true, "4 Pesar helado: 165 − 15 de tara = 150 g");
  ok(await page.locator("#btn-weigh-ice").isHidden(), "4b el botón de pesar helado desaparece: ya quedó fijo");
  ok(await page.locator("#sel-cup").isDisabled() && (await page.locator("#tiles-cup .tile:not([disabled])").count()) === 0,
     "4c ya no se puede cambiar el vaso, ni con los cuadros (cambiaría la tara)");
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

  ok((await texto(page, "#charge-total")).includes("87.75"), "6b el total también está junto al botón de cobrar");
  const ticketCajera = await texto(page, "#tab-venta .ticket-card");
  ok(!/costo|margen/i.test(ticketCajera), "6d la cajera no ve costo ni margen en el ticket", ticketCajera.match(/.*(costo|margen).*/i));
  await page.click('#tiles-payment .tile:has-text("Tarjeta")');
  ok(await page.locator("#card-box").isVisible() && (await texto(page, "#card-amount")).includes("87.75"),
     "6e con tarjeta aparece el monto en grande para teclearlo en el datáfono");
  const antes = (await rpcs(page, "process_sale")).length;
  await page.click("#btn-charge");
  await page.waitForTimeout(300);
  ok((await rpcs(page, "process_sale")).length === antes, "6f sin número de autorización del voucher no se cobra");
  await page.fill("#inp-card-auth", "ab 1234-56");
  await page.fill("#inp-card-last4", "4a3");
  const soloNumeros = await page.inputValue("#inp-card-last4");
  await page.fill("#inp-card-last4", "4321");
  ok((await page.inputValue("#inp-card-auth")) === "AB123456" && soloNumeros === "43",
     "6g la autorización se limpia al teclear y la tarjeta solo acepta números");
  await page.click("#btn-charge");
  await page.waitForSelector("#receipt-modal:not([hidden])");
  const venta = (await rpcs(page, "process_sale")).pop();
  const p = venta && venta.args.payload;
  ok(p && p.payment_method === "tarjeta" && p.card_auth_code === "AB123456" && p.card_last4 === "4321",
     "6c la forma de pago se elige con un cuadro y viaja en la venta con su voucher", p && [p.payment_method, p.card_auth_code, p.card_last4]);
  ok((await texto(page, "#receipt-body")).includes("Aut. AB123456 · ****4321"), "6h el recibo dice la autorización y los últimos 4");
  ok(p && p.weight_mode === "bascula" && Math.abs(p.scale_gross_g - 195) < 0.01 && p.scale_log.length === 2,
     "7 la venta lleva modo báscula, la lectura bruta (195 g) y las dos lecturas", p && { m: p.weight_mode, g: p.scale_gross_g, n: p.scale_log && p.scale_log.length });
  ok(p && p.scale_log[0].crudo.includes("KG") && p.scale_log[0].crudo.includes("<ETX>") === false,
     "7b cada lectura guarda el texto crudo de la báscula", p && p.scale_log[0]);
  const suma = p.lines.filter((l) => ["helado", "topping", "vaso"].includes(l.item_type)).reduce((s, l) => s + l.weight_g, 0);
  ok(Math.abs(suma - p.scale_gross_g) <= 1, "7c las líneas suman lo que marcó la báscula (lo que revisa el servidor)", suma);
  ok(!(await page.evaluate(() => localStorage.getItem("tutis_pedido_en_curso"))), "7d al cobrar se borra el pedido en curso");
  await page.click("#btn-close-receipt");
  ok(await page.locator("#btn-weigh-ice").isVisible() && !(await page.locator("#sel-cup").isDisabled()), "7e la siguiente venta arranca limpia");
  ok((await page.inputValue("#sel-payment")) === "efectivo" && (await page.getAttribute('#tiles-payment .tile:has-text("Efectivo")', "aria-checked")) === "true",
     "7f y vuelve a Efectivo: una tarjeta de la venta anterior no se cuela en el cuadre");
  ok(await page.locator("#card-box").isHidden() && (await page.inputValue("#inp-card-auth")) === "", "7g y el voucher anterior se borra");

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
  await page.click("#topping-chips .tile");
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

  // Ubicación y horario para la app de clientes
  ok((await texto(page, "#cfg-horario-hint")).includes("aún no tiene horario"), "15e una tienda sin horario lo dice (y la app no revisa la hora)");
  await page.fill("#cfg-ubicacion", "https://maps.app.goo.gl/abc123");
  ok((await texto(page, "#cfg-ubicacion-hint")).includes("enlace es corto"), "15f un enlace corto de Google se explica, no se adivina");
  await page.fill("#cfg-ubicacion", "https://www.google.com/maps/place/Mall/@14.0800,-87.2000,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d14.074321!4d-87.192654");
  ok((await texto(page, "#cfg-ubicacion-hint")).includes("14.074321, -87.192654"), "15g del enlace largo se toma el punto exacto del lugar (!3d!4d), no el centro del mapa");
  await page.fill("#cfg-ubicacion", "-87.19, 14.07");
  ok((await texto(page, "#cfg-ubicacion-hint")).includes("¿Están al revés?"), "15h coordenadas al revés: avisa");
  await page.fill("#cfg-ubicacion", "14.074321, -87.192654");
  await page.fill("#cfg-telefono", "2200-0000");
  await page.uncheck('#cfg-horario tr[data-dia="dom"] .hor-abre');
  await page.fill('#cfg-horario tr[data-dia="vie"] .hor-hasta', "22:00");
  await page.fill('#cfg-horario tr[data-dia="sab"] .hor-desde', "23:00");
  page.once("dialog", (d) => d.dismiss());
  await page.click("#btn-save-config");
  ok((await rpcs(page, "update:locations")).length === 0, "15i un día que cierra antes de abrir no se guarda");
  await page.fill('#cfg-horario tr[data-dia="sab"] .hor-desde', "10:00");
  await page.click("#btn-save-config");
  const guardado = (await rpcs(page, "update:locations")).pop()?.args || {};
  ok(guardado.latitud === 14.074321 && guardado.longitud === -87.192654 && guardado.telefono === "2200-0000" && guardado.app_minutos === 15
     && guardado.horario?.dom === null && guardado.horario?.vie?.cierra === "22:00" && guardado.horario?.lun?.abre === "10:00",
     "15j se guardan ubicación, teléfono, minutos y horario por día", guardado);

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
  await page.click("#topping-chips .tile");
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
  const malos = await g.page.locator("#table-closing-vouchers tr.row-bad").count();
  const vtxt = await texto(g.page, "#table-closing-vouchers");
  ok(malos === 3 && vtxt.includes("(repetida)") && vtxt.includes("SIN AUTORIZACIÓN") && vtxt.includes("****4321"),
     "27c la lista de vouchers marca en rojo la autorización repetida y la venta sin autorización", malos);
  ok(!(await g.page.innerHTML("#table-closing-vouchers")).includes("<b>X</b>"), "27d lo que viene de la base se escapa");

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

/* ---------------- Productos de precio fijo ---------------- */
{
  const { ctx, page, errores } = await abrir("cajera");
  ok(await page.locator("#products-card").isHidden(), "30 sin productos en el catálogo, la tarjeta no aparece");
  await page.evaluate(() => localStorage.setItem("fake_products", JSON.stringify([
    { id: "P1", location_id: "L1", family: "Bebidas", name: "Agua en botella", price: 25, cost: 8, stock_qty: 10, upsell: null, active: true },
    { id: "P2", location_id: "L1", family: "Bebidas", name: "Latte frío", price: 65, cost: 20, stock_qty: null, upsell: null, active: true },
    { id: "P3", location_id: "L1", family: "Toppings", name: "Topping premium (porción)", price: 30, cost: 9, stock_qty: null, upsell: "Ofrezca agua o algo para llevar.", active: true },
  ])));
  await page.reload(); await page.waitForSelector("#app:not([hidden])");
  ok(await page.locator("#products-card").isVisible() && (await page.locator("#product-families .tile").count()) === 2,
     "30b con productos aparecen sus familias como cuadros");
  await page.click('#product-tiles .tile:has-text("Agua en botella")');
  await page.click('#product-tiles .tile:has-text("Agua en botella")');
  ok((await texto(page, "#product-rows")).includes("2") && (await texto(page, "#charge-total")).includes("50.00"),
     "30c dos toques = 2 aguas, total 50 (sin vaso: no hay taza)");
  ok(!(await texto(page, "#ticket-lines")).includes("Vaso"), "30d una venta de solo productos no cobra vaso ni cuchara");
  await page.click('#product-rows button[aria-label="Quitar uno"]');
  ok((await texto(page, "#charge-total")).includes("25.00"), "30e el − quita uno");
  await page.click('#product-families .tile:has-text("Toppings")');
  await page.click('#product-tiles .tile:has-text("Topping premium")');
  ok((await texto(page, "#ticket-alerts")).includes("Ofrezca agua"), "30f el aviso del producto le aparece a la cajera");
  await page.click("#btn-charge");
  await page.waitForSelector("#receipt-modal:not([hidden])");
  const v = (await rpcs(page, "process_sale")).pop().args.payload;
  const tipos = v.lines.map((l) => l.item_type).join(",");
  ok(tipos === "producto,producto" && v.lines[0].quantity === 1 && v.lines.every((l) => l.weight_g === 0),
     "30g la venta lleva solo las líneas de producto, con cantidad y sin peso", v.lines);
  ok((await texto(page, "#receipt-body")).includes("1 × Agua en botella"), "30h el recibo dice la cantidad");
  await page.click("#btn-close-receipt");
  ok((await page.locator("#product-rows .product-row").count()) === 0, "30i la siguiente venta arranca sin productos");
  ok(errores.length === 0, "30j sin errores de JavaScript (productos)", errores);
  await ctx.close();
}

/* ---------------- Pedidos de la app ---------------- */
{
  const { ctx, page, errores } = await abrir("cajera");
  await page.evaluate(() => localStorage.setItem("fake_pedidos_app", JSON.stringify([
    { id: "PA1", folio: 105, estado: "recibido", cliente: "Andrea <b>López</b>", carnet: "TK7RMQPAYB", hora: "ya", usar_puntos: true, creado: new Date().toISOString(), total: 215,
      items: [{ nombre: "Taza mediana 12 oz", cantidad: 1, precio: 165, sabores: ["Taro", "Vainilla"], toppings: ["Oreo"], premium: ["Almendras"] },
              { nombre: "Agua en botella", cantidad: 2, precio: 50 }] },
  ])));
  await page.reload(); await page.waitForSelector("#app:not([hidden])");
  await page.waitForFunction(() => !document.querySelector("#pedidos-badge").hidden);
  ok(await page.isVisible('.tab-btn[data-tab="pedidos"]') && (await texto(page, "#pedidos-badge")) === "1",
     "31 la cajera ve la pestaña de pedidos de la app con 1 pedido nuevo");
  await page.click('.tab-btn[data-tab="pedidos"]');
  const tarjeta = await texto(page, "#pedidos-lista");
  ok(tarjeta.includes("#105") && tarjeta.includes("Taro + Vainilla") && tarjeta.includes("quiere usar sus puntos") && !(await page.innerHTML("#pedidos-lista")).includes("<b>López"),
     "31b el pedido muestra folio, detalle de la taza, si usa puntos, y escapa lo que viene de la base");
  await page.click('#pedidos-lista button:has-text("Empezar a preparar")');
  await page.waitForFunction(() => document.querySelector("#pedidos-lista").textContent.includes("Marcar listo"));
  ok((await rpcs(page, "tienda_pedido_estado")).pop().args.p_estado === "preparando", "31c avanzar el pedido le avisa a la base (y el cliente lo ve)");
  ok(errores.length === 0, "31d sin errores de JavaScript (pedidos)", errores);
  await ctx.close();
}

/* ---------------- La caja: abrir, retiro, cierre ciego ---------------- */
{
  const { ctx, page, errores } = await abrir("cajera");
  await page.evaluate(() => {
    localStorage.setItem("fake_caja", "cerrada");
    localStorage.setItem("fake_products", JSON.stringify([{ id: "P1", location_id: "L1", family: "Bebidas", name: "Agua en botella", price: 25, cost: 8, stock_qty: null, upsell: null, active: true }]));
  });
  await page.reload(); await page.waitForSelector("#app:not([hidden])");
  await page.waitForFunction(() => document.querySelector("#caja-estado").textContent === "Caja cerrada");
  ok(await page.isVisible("#btn-caja-abrir") && !(await page.isVisible("#btn-caja-cerrar")), "40 la cajera ve la caja cerrada y el botón para abrirla");
  await page.click('#product-tiles .tile:has-text("Agua en botella")');
  page.once("dialog", (d) => d.accept());
  await page.click("#btn-charge");
  await page.waitForSelector("#caja-modal:not([hidden])");
  ok((await rpcs(page, "process_sale")).length === 0, "40b con la caja cerrada no se cobra: primero se abre");
  await page.fill('#caja-conteo input[data-den="500"]', "1");
  await page.fill('#caja-conteo input[data-den="100"]', "1");
  await page.fill('#caja-conteo input[data-den="0.5"]', "2");
  ok((await texto(page, "#caja-contado")).includes("601.00"), "40c el conteo se suma billete por billete (lo que ella contó)");
  await page.click("#btn-caja-ok");
  await page.waitForFunction(() => document.querySelector("#caja-resultado").textContent.includes("dejó"));
  const ab = (await rpcs(page, "caja_abrir")).pop().args;
  ok(ab.p_conteo["500"] === 1 && ab.p_conteo["0.5"] === 2 && !("200" in ab.p_conteo), "40d a la base va el conteo por denominación, sin las vacías");
  ok((await texto(page, "#caja-resultado")).includes("faltan"), "40e si no coincide con lo que dejó el turno anterior, se lo dice al abrir");
  await page.click("#btn-caja-cancelar");
  await page.waitForFunction(() => document.querySelector("#caja-estado").textContent === "Caja abierta");
  await page.click("#btn-charge");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("fake_rpcs") || "[]").some((x) => x.name === "process_sale"));
  ok(true, "40f con la caja abierta, cobra");
  await page.click("#btn-close-receipt");

  await page.click("#btn-caja-mov");
  await page.fill("#caja-mov-monto", "100");
  await page.selectOption("#caja-mov-motivo", "otro");
  await page.click("#btn-caja-ok");
  ok((await texto(page, "#caja-msg")).includes("motivo") && (await rpcs(page, "caja_movimiento")).length === 0, "41 un retiro sin motivo no se guarda");
  await page.fill("#caja-mov-otro", "Pago al del hielo");
  await page.click("#btn-caja-ok");
  await page.waitForSelector("#caja-modal", { state: "hidden" });
  const mv = (await rpcs(page, "caja_movimiento")).pop().args;
  ok(mv.p_tipo === "retiro" && mv.p_monto === 100 && mv.p_motivo === "Pago al del hielo", "41b retiro de 100 con su motivo");

  await page.click("#btn-caja-precierre");
  await page.waitForSelector("#caja-precierre tbody tr td:nth-child(5)");
  const pre = await texto(page, "#caja-modal");
  ok(pre.includes("000123") && pre.includes("2640") && pre.includes("SIN AUTORIZACIÓN") && pre.includes("300.00")
     && await page.isHidden("#btn-caja-ok"),
     "41c el pre-cierre lista los vouchers del turno, marca el que no tiene autorización y solo es para mirar", pre);
  await page.click("#btn-caja-cancelar");

  await page.click("#btn-caja-cerrar");
  await page.waitForSelector("#caja-precierre tbody tr td:nth-child(5)");
  ok((await texto(page, "#caja-pasos")).includes("Tarjeta") && await page.isVisible("#caja-lote"), "42 el cierre empieza por la tarjeta: pre-cierre y lote del datáfono");
  await page.click("#btn-caja-ok");
  ok((await texto(page, "#caja-msg")).includes("lote"), "42a sin el lote del datáfono no se avanza");
  await page.fill("#caja-lote", "000389");
  await page.fill("#caja-lote-ventas", "2");
  await page.fill("#caja-lote-monto", "300");
  await page.click("#btn-caja-ok");
  await page.waitForSelector("#caja-conteo-area:not([hidden])");
  ok(!/esperado|debería haber\s*L|1000/i.test(await texto(page, "#caja-modal")), "42b en el efectivo, la pantalla NO dice cuánto debería haber");
  await page.fill('#caja-conteo input[data-den="500"]', "1");
  await page.fill('#caja-conteo input[data-den="200"]', "2");
  await page.fill('#caja-conteo input[data-den="50"]', "1");
  await page.click("#btn-caja-ok");
  ok((await texto(page, "#caja-msg")).includes("queda en la gaveta"), "42c hay que decir cuánto queda de fondo");
  await page.click("#btn-caja-queda-todo");
  ok((await page.inputValue("#caja-deja")) === "950.00", "42d \"Queda todo\" pone lo contado");
  await page.fill("#caja-deja", "700");
  await page.click("#btn-caja-ok");
  await page.waitForSelector("#caja-otros-area:not([hidden])");
  ok(await page.isVisible("#caja-dec-pedidosya") && await page.isVisible("#caja-dec-hugo") && !/150/.test(await texto(page, "#caja-modal")),
     "42e luego transferencias y delivery (Pedidos Ya, Hugo), también a ciegas");
  await page.fill("#caja-dec-pedidosya", "150");
  page.once("dialog", (d) => d.accept());
  await page.click("#btn-caja-ok");
  await page.waitForSelector("#caja-resultado:not([hidden])");
  const cerr = (await rpcs(page, "caja_cerrar")).pop().args;
  ok(cerr.p_lote.lote === "000389" && cerr.p_lote.monto === 300 && cerr.p_declarado.tarjeta === 300 && cerr.p_declarado.pedidosya === 150
     && cerr.p_declarado.hugo === 0 && cerr.p_deja_fondo === 700, "42f a la base va el lote, lo declarado por forma de pago y el fondo", cerr);
  const res = await texto(page, "#caja-resultado");
  ok(res.includes("Faltante") && res.includes("50.00") && res.includes("1000.00") && res.includes("Pedidos Ya") && res.includes("coincide")
     && await page.isVisible("#caja-explicar-area"),
     "42g después de guardar se ve el cuadre por forma de pago, el faltante y se pide explicación", res);
  await page.fill("#caja-explicacion", "Di mal un vuelto");
  await page.click("#btn-caja-explicar");
  await page.waitForFunction(() => document.querySelector("#caja-msg").textContent.includes("guardada"));
  ok((await rpcs(page, "caja_explicar")).pop().args.p_texto === "Di mal un vuelto", "42h la explicación llega a la base");
  await page.click("#btn-caja-imprimir");
  const comp = await texto(page, "#receipt-body");
  ok(comp.includes("ARQUEO DE CAJA") && comp.includes("× 2") && comp.includes("Recibe (gerente)") && comp.includes("Pedidos Ya") && comp.includes("000389")
     && !/innova504/i.test(comp), "42i comprobante del arqueo con el conteo, el cuadre por forma de pago, el lote y espacio para firmas", comp);
  ok(errores.length === 0, "43 sin errores de JavaScript (caja)", errores);
  await ctx.close();
}
{
  const { ctx, page, errores } = await abrir("gerente");
  await page.click('.tab-btn[data-tab="reportes"]');
  await page.waitForSelector("#table-turnos tbody tr td:nth-child(7)");
  const html = await page.locator("#table-turnos").innerHTML();
  const t = await texto(page, "#table-turnos");
  ok(t.includes("Faltan") && t.includes("20.00") && t.includes("Entrega") && t.includes("Al cerrar") && html.includes("&lt;b&gt;Ana"),
     "44 la gerente ve el turno con faltante, diferencia de entrega, el esperado que cambió, y los nombres escapados", t);
  ok(t.includes("Pedidos Ya") && t.includes("Falta HNL 10.00") && t.includes("Lote 000389"), "44a y el cuadre de las otras formas de pago con el lote", t);
  ok((await texto(page, "#turnos-fuera")).includes("sin caja abierta"), "44b avisa las ventas en efectivo que no cayeron en ningún turno");
  page.once("dialog", (d) => d.accept("Hablado con Ana"));
  await page.click('#table-turnos button:has-text("Revisar")');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("fake_rpcs") || "[]").some((x) => x.name === "caja_revisar"));
  ok((await rpcs(page, "caja_revisar")).pop().args.p_nota === "Hablado con Ana", "44c la gerente revisa el cierre con nota");
  ok(errores.filter((e) => !/no simulado/.test(e)).length === 0, "44d sin errores de JavaScript (turnos)", errores);
  await ctx.close();
}

/* ---------------- Clientes: "¿Es cliente?" al cobrar ---------------- */
{
  const { ctx, page, errores } = await abrir("cajera", { ls: { fake_preguntar: "1", fake_loyalty: "1" } });
  await page.waitForFunction(() => document.querySelector("#scale-status").textContent !== "Sin conectar");
  const pesarYCobrar = async () => {
    await ponerBascula(page, { g: 165, motion: false });
    await page.waitForFunction(() => document.querySelector("#scale-reading").textContent.includes("165"));
    await page.click("#btn-weigh-ice");
    await page.waitForFunction(() => document.querySelector("#out-ice-weight").textContent.includes("150"));
    await page.click("#btn-charge");
  };
  // 1) Sin cliente: pregunta, y "Sin cliente" cobra igual.
  await pesarYCobrar();
  await page.waitForSelector("#cliente-modal:not([hidden])");
  ok(true, "50 al cobrar sin cliente, la caja pregunta \"¿Es cliente?\"");
  const antes = (await rpcs(page, "process_sale")).length;
  await page.click("#btn-pc-sin");
  await page.waitForSelector("#receipt-modal:not([hidden])");
  const v1 = (await rpcs(page, "process_sale")).pop().args.payload;
  ok((await rpcs(page, "process_sale")).length === antes + 1 && !v1.customer_id, "50a \"Sin cliente, cobrar\" cobra sin cliente");
  await page.click("#btn-close-receipt");

  // 2) Teléfono que no existe: inscribe ahí mismo y cobra con ella.
  await pesarYCobrar();
  await page.waitForSelector("#cliente-modal:not([hidden])");
  await page.fill("#pc-tel", "9911-0002");
  await page.click("#btn-pc-buscar");
  await page.waitForSelector("#pc-nuevo:not([hidden])");
  ok(true, "51 un teléfono que no existe abre el formulario para inscribirla");
  await page.click("#btn-pc-inscribir");
  ok((await texto(page, "#pc-msg")).includes("nombre"), "51a sin nombre no inscribe");
  await page.fill("#pc-nombre", "Carla Nueva");
  await page.fill("#pc-birth", "1995-04-12");
  await page.selectOption("#pc-sexo", "F");
  await page.click("#btn-pc-inscribir");
  await page.waitForSelector("#receipt-modal:not([hidden])");
  const ins = (await rpcs(page, "clientes_inscribir")).pop().args.p;
  const v2 = (await rpcs(page, "process_sale")).pop().args.payload;
  ok(ins.telefono === "9911-0002" && ins.nombre === "Carla Nueva" && ins.cumpleanos === "1995-04-12" && ins.sexo === "F",
     "51b se inscribe con teléfono, nombre, cumpleaños y sexo", ins);
  ok(v2.customer_id === "C2", "51c y la venta sale a su nombre (gana puntos)", v2.customer_id);
  await page.click("#btn-close-receipt");

  // 3) Cliente con puntos: pregunta si canjea; "Sí" vuelve al ticket.
  await pesarYCobrar();
  await page.waitForSelector("#cliente-modal:not([hidden])");
  await page.fill("#pc-tel", "+504 9911 0001");
  await page.press("#pc-tel", "Enter");
  await page.waitForSelector("#pc-resultado .loy-result");
  const r = await page.innerHTML("#pc-resultado");
  ok(r.includes("&lt;i&gt;R") && r.includes("VIP") && r.includes("Hoy es su cumpleaños"),
     "52 la encuentra por teléfono en otro formato, con categoría y cumpleaños, nombre escapado");
  await page.click("#pc-resultado .loy-result");
  await page.waitForSelector("#btn-pc-canjear");
  ok((await texto(page, "#pc-resultado")).includes("120 puntos"), "52a tiene puntos: le pregunta si los quiere usar");
  const antes3 = (await rpcs(page, "process_sale")).length;
  await page.click("#btn-pc-canjear");
  await page.waitForTimeout(200);
  ok(await page.locator("#cliente-modal").isHidden() && (await rpcs(page, "process_sale")).length === antes3,
     "52b \"Sí, canjear\" vuelve al ticket sin cobrar");
  ok((await texto(page, "#loy-sel-cumple")).includes("Hoy es su cumpleaños") && (await texto(page, "#loy-sel-obs")).includes("Sin lactosa")
     && (await texto(page, "#loy-sel-cat")) === "VIP", "52c en el ticket se ve su cumpleaños, su nota y su categoría");
  await page.click("#btn-charge");
  await page.waitForSelector("#receipt-modal:not([hidden])");
  ok(await page.locator("#cliente-modal").isHidden() && (await rpcs(page, "process_sale")).pop().args.payload.customer_id === "C1",
     "52d con cliente elegido ya no vuelve a preguntar");
  await page.click("#btn-close-receipt");

  // 4) Sin internet no pregunta (no se puede buscar).
  await ponerBascula(page, { g: 165, motion: false });
  await page.waitForFunction(() => document.querySelector("#scale-reading").textContent.includes("165"));
  await page.click("#btn-weigh-ice");
  await page.waitForFunction(() => document.querySelector("#out-ice-weight").textContent.includes("150"));
  await ctx.setOffline(true);
  await page.click("#btn-charge");
  await page.waitForSelector("#receipt-modal:not([hidden])");
  ok(await page.locator("#cliente-modal").isHidden(), "53 sin internet cobra directo, sin preguntar");
  await ctx.setOffline(false);
  await page.click("#btn-close-receipt");

  // 5) El formulario de la tarjeta también pide la ficha completa.
  await page.fill("#loy-q", "99110009");
  await page.click("#btn-loy-buscar");
  await page.waitForSelector("#loy-new-form:not([hidden])");
  ok((await page.inputValue("#loy-new-phone")) === "99110009", "54 si no existe, el formulario arranca con el teléfono buscado");
  await page.fill("#loy-new-name", "Ana Ficha");
  await page.fill("#loy-new-ident", "0801-1990-12345");
  await page.fill("#loy-new-obs", "Alérgica al maní");
  await page.click("#btn-loy-guardar");
  await page.waitForSelector("#loy-selected:not([hidden])");
  const ins2 = (await rpcs(page, "clientes_inscribir")).pop().args.p;
  ok(ins2.identidad === "0801-1990-12345" && ins2.observaciones === "Alérgica al maní", "54a con identidad y observaciones", ins2);
  ok(errores.filter((e) => !/no simulado/.test(e)).length === 0, "54b sin errores de JavaScript (clientes en caja)", errores);
  await ctx.close();
}

/* ---------------- Clientes: el módulo de la gerente ---------------- */
{
  const { ctx, page, errores } = await abrir("gerente");
  await page.click('.tab-btn[data-tab="clientes"]');
  await page.waitForSelector("#table-clientes tbody tr:nth-child(3)");
  const k = (await texto(page, "#cli-kpis")).toLowerCase();
  ok(k.includes("vip") && k.includes("inactivos") && k.includes("ticket promedio") && k.includes("cumpleaños cerca"),
     "55 el módulo muestra VIP, inactivos, ticket promedio y cumpleaños cerca", k);
  ok((await page.innerHTML("#cli-cumples")).includes("&lt;i&gt;R") && (await page.innerHTML("#cli-cumples")).includes("wa.me/50499110001"),
     "55a el aviso de cumpleaños trae el enlace de WhatsApp, con el nombre escapado");
  await page.selectOption("#cli-cat", "inactivo");
  ok((await page.locator("#table-clientes tbody tr").count()) === 1 && (await texto(page, "#table-clientes")).includes("Óscar"),
     "55b filtrar por categoría");
  await page.selectOption("#cli-cat", "");
  await page.fill("#cli-desde", "2026-09-01");
  await page.dispatchEvent("#cli-desde", "change");
  ok((await page.locator("#table-clientes tbody tr").count()) === 1 && (await texto(page, "#table-clientes")).includes("Óscar"),
     "55c \"no vienen desde\" deja a quien vino antes y no después (sin contar a quien nunca vino)");
  await page.fill("#cli-desde", "");
  await page.dispatchEvent("#cli-desde", "change");
  await page.fill("#cli-q", "oscar");
  ok((await page.locator("#table-clientes tbody tr").count()) === 1, "55d la búsqueda ignora los acentos");
  await page.fill("#cli-q", "");
  await page.click('#table-clientes tbody tr:has-text("Valeria")');
  await page.waitForSelector("#table-cli-consumo tbody tr td.num");
  const d = (await texto(page, "#cli-detail")).toLowerCase();
  ok(d.includes("ticket promedio") && d.includes("25.1 días") && d.includes("los sábados") && d.includes("16:00") && d.includes("tarjeta"),
     "56 la ficha dice cada cuánto viene, su día y hora, y cómo paga", d.slice(0, 400));
  ok((await page.innerHTML("#table-cli-consumo")).includes("&lt;b&gt;Mora"), "56a lo que consume, escapado");
  ok((await page.inputValue("#cli-e-ident")) === "0801-1999-00001" && (await page.inputValue("#cli-e-obs")) === "Sin lactosa",
     "56b la gerente ve y edita identidad y observaciones");
  await page.fill("#cli-e-phone", "");
  await page.click("#btn-cli-guardar");
  ok((await texto(page, "#cli-e-msg")).includes("teléfono"), "56c no deja el teléfono vacío: es la llave");
  await page.fill("#cli-e-phone", "9911-0099");
  await page.fill("#cli-e-obs", "Sin lactosa. Prefiere mora.");
  await page.click("#btn-cli-guardar");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("fake_rpcs") || "[]").some((x) => x.name === "update:customers"));
  const up = (await rpcs(page, "update:customers")).pop().args;
  ok(up.phone === "9911-0099" && up.observaciones === "Sin lactosa. Prefiere mora." && up.sexo === "F", "56d guarda la ficha", up);
  const [descarga] = await Promise.all([page.waitForEvent("download"), page.click("#btn-cli-excel")]);
  ok(/^clientes_.*\.xlsx$/.test(descarga.suggestedFilename()), "57 descarga la lista en Excel", descarga.suggestedFilename());
  ok(await page.locator("#cli-reglas-card").isHidden(), "57a la gerente no ve las reglas de las categorías");
  ok(errores.filter((e) => !/no simulado/.test(e)).length === 0, "57b sin errores de JavaScript (módulo de clientes)", errores);
  await ctx.close();
}

/* ---------------- Costo y margen: solo la propietaria ---------------- */
{
  const g = await abrir("gerente");
  await g.page.click('.tab-btn[data-tab="venta"]');
  ok(!/costo|margen/i.test(await texto(g.page, "#tab-venta .ticket-card")), "29 la gerente tampoco ve costo ni margen al vender");
  await g.ctx.close();
  const o = await abrir("propietario");
  await o.page.click('.tab-btn[data-tab="venta"]');
  const t = await texto(o.page, "#tab-venta .ticket-card");
  ok(t.includes("Costo real") && t.includes("Margen"), "29b la propietaria sí ve costo y margen", t.slice(0, 200));
  ok(o.errores.length === 0, "29c sin errores de JavaScript (propietaria)", o.errores);
  await o.ctx.close();
}

await browser.close();
console.log(fallas ? `\n${fallas} FALLA(S)` : "\nTODAS LAS PRUEBAS DE LA CAJA PASARON");
process.exit(fallas ? 1 : 0);
