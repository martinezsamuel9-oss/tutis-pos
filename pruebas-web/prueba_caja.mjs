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

async function abrir(rol, { serial = true } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  await ctx.addInitScript((r) => { if (!localStorage.getItem("fake_role")) localStorage.setItem("fake_role", r); }, rol);
  if (serial) await ctx.addInitScript(fakeSerial);
  await ctx.route("**/vendor/supabase.min.js", (r) => r.fulfill({ contentType: "application/javascript", body: fakeSb }));
  const page = await ctx.newPage();
  const errores = [];
  page.on("pageerror", (e) => errores.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errores.push(m.text()); });
  await page.goto(BASE + "index.html");
  await page.waitForSelector("#app:not([hidden])");
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

await browser.close();
console.log(fallas ? `\n${fallas} FALLA(S)` : "\nTODAS LAS PRUEBAS DE LA CAJA PASARON");
process.exit(fallas ? 1 : 0);
