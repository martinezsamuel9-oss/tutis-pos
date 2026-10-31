// Doble en memoria del SDK de Supabase, solo para pruebas.
(function () {
  const rol = localStorage.getItem("fake_role") || "cajera";
  const DB = {
    locations: [{ id: "L1", name: "Tuti's Galerías", legal_name: "Tuti's", country_code: "HN", currency_code: "HNL",
      price_per_gram: 0.45, include_cup_weight_in_price: true, margin_target_pct: 10, default_weight_unit: "g",
      active: true, address: "Mall" }],
    flavors: [{ id: "F1", location_id: "L1", name: "Yogurt natural", cost_per_gram: 0.03, stock_grams: 8000, active: true }],
    toppings: [{ id: "T1", location_id: "L1", name: "Oreo", category: "dulce", cost_per_gram: 0.048, tier: 1,
      surcharge_per_gram: 0, stock_grams: 2000, active: true }],
    supplies: [
      { id: "S1", location_id: "L1", name: "Vaso 8oz", kind: "vaso", tare_weight_g: 15, cost_per_unit: 2, stock_qty: 500, active: true },
      { id: "S2", location_id: "L1", name: "Cuchara", kind: "cuchara", tare_weight_g: 0, cost_per_unit: 0.38, stock_qty: 900, active: true },
    ],
    profiles: [{ id: "U1", role: rol, location_id: rol === "propietario" ? null : "L1", active: true, full_name: rol === "cajera" ? "Cajera Uno" : "Gerente Uno" }],
    sales: JSON.parse(localStorage.getItem("fake_sales") || "[]"),
    loyalty_config: localStorage.getItem("fake_loyalty") === "1"
      ? [{ id: true, activo: true, monto_por_punto: 27, valor_punto: 1, compra_minima: 0, canje_minimo: 50, canje_max_pct: 50 }] : [],
    // La pregunta "¿Es cliente?" se prende solo en las pruebas que la revisan.
    clientes_config: [{ id: true, vip_monto_90d: 1500, vip_visitas_90d: 8, frecuente_visitas_90d: 3, nuevo_dias: 30,
      inactivo_dias: 45, aviso_cumple_dias: 7, preguntar_en_caja: localStorage.getItem("fake_preguntar") === "1" }], expenses: [], audit_log: [], customers: [], loyalty_transactions: [], sale_lines: [], purchases: [], products: JSON.parse(localStorage.getItem("fake_products") || "[]"),
  };
  const log = JSON.parse(localStorage.getItem("fake_rpcs") || "[]");
  function anotar(name, args) { log.push({ name, args }); localStorage.setItem("fake_rpcs", JSON.stringify(log)); }

  function query(table) {
    let rows = (DB[table] || []).slice();
    let single = false;
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
      gte() { return q; }, lte() { return q; }, lt() { return q; }, gt() { return q; }, in() { return q; },
      ilike() { return q; }, or() { return q; }, neq() { return q; }, not() { return q; }, is() { return q; },
      eq(col, val) { rows = rows.filter((r) => r[col] === undefined || r[col] === val); return q; },
      single() { single = true; return q; }, maybeSingle() { single = true; return q; },
      insert(o) { anotar("insert:" + table, o); return q; }, update(o) { anotar("update:" + table, o); return q; }, delete() { return q; }, upsert() { return q; },
      then(res, rej) { return Promise.resolve({ data: single ? (rows[0] || null) : rows, error: null }).then(res, rej); },
    };
    return q;
  }

  async function rpc(name, args) {
    anotar(name, args);
    if (!navigator.onLine) throw new TypeError("Failed to fetch");
    switch (name) {
      case "process_sale": return { data: { folio: log.filter((x) => x.name === "process_sale").length, sale_id: "V1", total: 0, weight_source: args.payload.weight_mode }, error: null };
      case "gerentes_para_autorizar": return { data: [{ id: "G1", full_name: "Gerente Galerías" }], error: null };
      case "autorizar_peso_manual":
        return args.p_pin === "4829"
          ? { data: { ok: true, id: "AUTH-1", authorized_by_name: "Gerente Galerías" }, error: null }
          : { data: { ok: false, error: "PIN incorrecto." }, error: null };
      case "registrar_anulacion": return { data: { ok: true }, error: null };
      case "autorizar_peso_presencial":
        return this && this.__gerente
          ? { data: { ok: true, id: "AUTH-H", authorized_by_name: "Gerente Galerías" }, error: null }
          : { data: null, error: { message: "Para autorizar con huella hay que confirmarla en el teléfono en ese momento", code: "P0001" } };
      case "tengo_pin": return { data: false, error: null };
      case "tienda_pedidos": return { data: JSON.parse(localStorage.getItem("fake_pedidos_app") || "[]"), error: null };
      case "tienda_pedido_estado": {
        const l = JSON.parse(localStorage.getItem("fake_pedidos_app") || "[]"); const x = l.find((p) => p.id === args.p_id);
        if (x) x.estado = args.p_estado; localStorage.setItem("fake_pedidos_app", JSON.stringify(l)); return { data: x, error: null };
      }
      case "daily_closing": return { data: { ventas: 3, ingresos: 250.5, vasos: 3, cucharas: 3, peso_helado_g: 450, peso_toppings_g: 90, toppings: [],
        por_pago: [{ metodo: "efectivo", ventas: 2, total: 170.5 }, { metodo: "tarjeta", ventas: 1, total: 80 }], descuentos: 10, anulaciones: 1, anulado_g: 185.5,
        vouchers: [{ folio: 7, hora: "2026-10-21T18:00:00Z", total: 80, autorizacion: "123456", ultimos4: "4321" },
                   { folio: 9, hora: "2026-10-21T19:00:00Z", total: 50, autorizacion: "123456", ultimos4: null },
                   { folio: 11, hora: "2026-10-21T20:00:00Z", total: 40, autorizacion: null, ultimos4: null },
                   { folio: 12, hora: "2026-10-21T21:00:00Z", total: 30, autorizacion: "<b>X</b>", ultimos4: "9999" }],
        tarjeta_sin_autorizacion: 1 }, error: null };
      case "set_manager_pin": return args.p_pin === "1234" ? { data: null, error: { message: "Ese PIN es demasiado fácil de adivinar. Elige otro." } } : { data: null, error: null };
      case "control_pesos": return { data: {
        por_cajera: [{ cajera: "Cajera Uno", ventas_pesadas: 10, bascula: 8, no_cuadra: 0, manual_autorizado: 1, manual_sin_autorizar: 1, sin_dato: 0, anulaciones: 2, gramos_anulados: 340 }],
        incidentes: [
          { tipo: "venta", fecha: "2026-10-07T18:00:00Z", folio: 12, cajera: "Cajera Uno", clase: "manual_sin_autorizar", peso_g: 180, autorizo: null, motivo: null },
          { tipo: "venta", fecha: "2026-10-07T17:00:00Z", folio: 11, cajera: "Cajera Uno", clase: "manual_autorizado", peso_g: 200, autorizo: "Gerente <b>Galerías</b>", metodo: "pin", motivo: "La báscula no conecta" },
          { tipo: "venta", fecha: "2026-10-07T16:00:00Z", folio: 10, cajera: "Cajera Uno", clase: "manual_autorizado", peso_g: 150, autorizo: "Gerente Galerías", metodo: "huella", motivo: "La báscula no conecta" },
        ] }, error: null };
      // La caja: abierta por defecto (así cobran las demás pruebas); "fake_caja"
      // = "cerrada" la arranca cerrada. El esperado lo "calcula" el doble: 1000.
      case "caja_estado": {
        const abierta = localStorage.getItem("fake_caja") !== "cerrada";
        return { data: abierta ? { abierta: true, turno: { id: "T1", abierto_por: "Cajera Uno", abierto_at: new Date().toISOString(), es_mio: true, movimientos: [] } }
                               : { abierta: false, ultimo_cierre: null }, error: null };
      }
      case "caja_abrir": {
        localStorage.setItem("fake_caja", "abierta");
        const fondo = Object.entries(args.p_conteo).reduce((s, [v, n]) => s + Number(v) * n, 0);
        return { data: { id: "T1", fondo, fondo_anterior: 700, diferencia_entrega: fondo - 700 }, error: null };
      }
      case "caja_movimiento": return { data: { abierta: true, turno: { id: "T1", abierto_por: "Cajera Uno", abierto_at: new Date().toISOString(), es_mio: true,
                                        movimientos: [{ tipo: args.p_tipo, monto: args.p_monto, motivo: args.p_motivo }] } }, error: null };
      // Pre-cierre: dos vouchers del turno (uno sin autorización).
      case "caja_precierre": return { data: { desde: new Date().toISOString(), ventas: 2, monto: 300, sin_autorizacion: 1, vouchers: [
          { folio: 31, hora: new Date().toISOString(), monto: 200, autorizacion: "000123", ultimos4: "2640", cajera: "Cajera Uno", repetida: false },
          { folio: 32, hora: new Date().toISOString(), monto: 100, autorizacion: null, ultimos4: null, cajera: "<b>Cajera</b>", repetida: false }] }, error: null };
      // El sistema "tiene": efectivo 1000 esperado, tarjeta 300 (2), Pedidos Ya 150 (1).
      case "caja_cerrar": {
        if (!args.p_lote) return { data: null, error: { message: "Hubo ventas con tarjeta: primero haz el cierre del datáfono y anota el lote" } };
        localStorage.setItem("fake_caja", "cerrada");
        const contado = Object.entries(args.p_conteo).reduce((s, [v, n]) => s + Number(v) * n, 0);
        const dec = args.p_declarado || {};
        const sis = { efectivo: 1000, tarjeta: 300, transferencia: 0, pedidosya: 150, hugo: 0 };
        const formas = Object.keys(sis).map((k) => {
          const d = k === "efectivo" ? contado : Number(dec[k] || 0);
          return { metodo: k, sistema: sis[k], declarado: d, diferencia: Math.round((d - sis[k]) * 100) / 100, n: sis[k] ? 1 : 0 };
        });
        const tot = (f) => formas.reduce((s, x) => s + x[f], 0);
        return { data: { id: "T1", fondo: 700, ventas_efectivo: 400, n_efectivo: 4, entradas: 0, retiros: 100, esperado: 1000, contado,
                         diferencia: contado - 1000, deja_fondo: args.p_deja_fondo, tarjeta: 300, n_tarjeta: 2, transferencia: 0, n_transferencia: 0,
                         formas, total_sistema: tot("sistema"), total_declarado: tot("declarado"), diferencia_total: Math.round((tot("declarado") - tot("sistema")) * 100) / 100,
                         lote: args.p_lote, lote_diferencia: args.p_lote.monto - 300, lote_ventas_diferencia: args.p_lote.ventas - 2,
                         abierto_por: "Cajera Uno", abierto_at: new Date().toISOString(), cerrado_por: "Cajera Uno", cerrado_at: new Date().toISOString() }, error: null };
      }
      case "caja_explicar": case "caja_revisar": return { data: null, error: null };
      case "caja_turnos": return { data: { turnos: [
          { id: "T9", abierto_por: "<b>Ana</b>", abierto_at: "2026-10-27T14:00:00Z", cerrado_por: "Bea", cerrado_at: "2026-10-27T20:00:00Z",
            fondo: 650, fondo_anterior: 700, diferencia_entrega: -50, contado: 980, esperado_al_cerrar: 1000, esperado: 1040, diferencia: -20,
            explicacion: "Di mal un vuelto", ventas_efectivo: 400, n_efectivo: 4, entradas: 0, retiros: 100, movimientos: [],
            por_pago: { efectivo: { n: 4, total: 400 }, pedidosya: { n: 1, total: 150 } },
            formas: [{ metodo: "efectivo", sistema: 1000, declarado: 980, diferencia: -20 }, { metodo: "pedidosya", sistema: 150, declarado: 140, diferencia: -10 }],
            diferencia_total: -30, lote_tarjeta: { lote: "000389", ventas: 0, monto: 0 } }],
          fuera_de_turno: { ventas: 1, total: 25, folios: [27] } }, error: null };
      case "loyalty_buscar": {
        const d = String(args.p_texto).replace(/\D/g, "");
        return { data: d.endsWith("99110001") ? [{ id: "C1", card_code: "VALE234567", full_name: "Valeria <i>R</i>", phone: "99110001",
          points_balance: 120, visits: 9, active: true, observaciones: "Sin lactosa", dias_para_cumple: 0, categoria: "vip", exacto: true }] : [], error: null };
      }
      case "clientes_inscribir": {
        const p = args.p || {};
        if (String(p.telefono || "").replace(/\D/g, "") === "99110001") return { data: null, error: { message: "Ya hay un cliente con ese teléfono" } };
        return { data: { id: "C2", card_code: "NUEVO23456", full_name: p.nombre, phone: String(p.telefono).replace(/\D/g, ""),
          points_balance: 0, visits: 0, active: true, categoria: "sin_compras", observaciones: p.observaciones || null }, error: null };
      }
      case "loyalty_canje_maximo": return { data: { puntos: 60, descuento: 60 }, error: null };
      case "clientes_resumen": return { data: [
        { id: "C1", nombre: "Valeria <i>R</i>", telefono: "99110001", carnet: "VALE234567", cumpleanos: "1999-10-30", dias_para_cumple: 0,
          sexo: "F", identidad: "0801-1999-00001", observaciones: "Sin lactosa", puntos: 120, activo: true, inscrito: "2026-01-02T15:00:00Z",
          categoria: "vip", visitas: 12, total: 1800, ticket_promedio: 150, primera: "2026-01-02T15:00:00Z", ultima: new Date(Date.now() - 2 * 864e5).toISOString(),
          dias_sin_venir: 2, cada_cuantos_dias: 25.1, visitas_90: 5, monto_90: 900 },
        { id: "C3", nombre: "Óscar Pérez", telefono: "99110003", carnet: "OSCA234567", cumpleanos: null, dias_para_cumple: null,
          sexo: "M", identidad: null, observaciones: null, puntos: 10, activo: true, inscrito: "2026-03-02T15:00:00Z",
          categoria: "inactivo", visitas: 2, total: 200, ticket_promedio: 100, primera: "2026-03-02T15:00:00Z", ultima: "2026-06-01T15:00:00Z",
          dias_sin_venir: 151, cada_cuantos_dias: 91, visitas_90: 0, monto_90: 0 },
        { id: "C4", nombre: "Nadia Sin Compras", telefono: "99110004", carnet: "NADI234567", cumpleanos: null, dias_para_cumple: null,
          sexo: null, identidad: null, observaciones: null, puntos: 0, activo: true, inscrito: "2026-10-20T15:00:00Z",
          categoria: "sin_compras", visitas: 0, total: 0, ticket_promedio: 0, primera: null, ultima: null,
          dias_sin_venir: null, cada_cuantos_dias: null, visitas_90: 0, monto_90: 0 }], error: null };
      case "clientes_cumpleanos": return { data: [{ id: "C1", nombre: "Valeria <i>R</i>", telefono: "99110001", cumpleanos: "1999-10-30", dias: 0, cumple: 27, categoria: "vip" }], error: null };
      case "cliente_detalle": return { data: { categoria: "vip",
        ultimas: [{ fecha: "2026-10-28T20:00:00Z", folio: 41, tienda: "Tuti's Galerías", total: 150, pago: "tarjeta", puntos_canjeados: 0 }],
        consumo: [{ tipo: "producto", nombre: "Shake <b>Mora</b>", veces: 7, unidades: 7, peso_g: 0, monto: 840 },
                  { tipo: "helado", nombre: "Yogurt natural", veces: 5, unidades: 5, peso_g: 1500, monto: 600 }],
        por_dia: { "6": 7, "2": 1 }, por_hora: { "16": 6, "11": 2 }, pagos: { tarjeta: 9, efectivo: 3 } }, error: null };
      default: return { data: null, error: { message: "no simulado: " + name, code: "X" } };
    }
  }

  let clientes = 0;
  window.supabase = {
    createClient(url, key, opts) {
      const n = ++clientes;          // el 1 es el de la caja; los demás, sesiones aparte
      const c = {
        __n: n, __gerente: false,
        auth: {
          getSession: async () => ({ data: { session: (n === 1 && localStorage.getItem("fake_logged_out") !== "1") ? { user: { id: "U1" } } : null } }),
          onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
          signOut: async (o) => { anotar("signOut", { cliente: n, scope: o && o.scope }); return {}; },
          signInWithPassword: async () => { localStorage.removeItem("fake_logged_out"); return { error: null }; },
          signInWithPasskey: async () => {
            anotar("signInWithPasskey", { cliente: n, experimental: opts && opts.auth && opts.auth.experimental });
            if (n === 1) { localStorage.removeItem("fake_logged_out"); return { data: { session: { user: { id: "U1" } } }, error: null }; }
            c.__gerente = true;
            return { data: { session: { user: { id: "G1" } } }, error: null };
          },
          registerPasskey: async () => { anotar("registerPasskey", {}); return { data: {}, error: null }; },
          passkey: {
            list: async () => ({ data: [{ id: "PK1", friendly_name: "iPhone de <i>Ana</i>", created_at: "2026-10-01T10:00:00Z", last_used_at: null }], error: null }),
            delete: async (a) => { anotar("deletePasskey", a); return { error: null }; },
          },
        },
        from: query,
        rpc: (name, args) => rpc.call(c, name, args),
        channel() { return { on() { return this; }, subscribe() { return this; } }; },
        removeChannel() {},
      };
      return c;
    },
  };
})();
