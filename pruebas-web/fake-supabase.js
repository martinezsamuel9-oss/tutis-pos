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
    sales: JSON.parse(localStorage.getItem("fake_sales") || "[]"), loyalty_config: [], expenses: [], audit_log: [], customers: [], loyalty_transactions: [], sale_lines: [], purchases: [], products: JSON.parse(localStorage.getItem("fake_products") || "[]"),
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
      case "caja_cerrar": {
        localStorage.setItem("fake_caja", "cerrada");
        const contado = Object.entries(args.p_conteo).reduce((s, [v, n]) => s + Number(v) * n, 0);
        return { data: { id: "T1", fondo: 700, ventas_efectivo: 400, n_efectivo: 4, entradas: 0, retiros: 100, esperado: 1000, contado,
                         diferencia: contado - 1000, deja_fondo: args.p_deja_fondo, tarjeta: 300, n_tarjeta: 2, transferencia: 0, n_transferencia: 0,
                         abierto_por: "Cajera Uno", abierto_at: new Date().toISOString(), cerrado_por: "Cajera Uno", cerrado_at: new Date().toISOString() }, error: null };
      }
      case "caja_explicar": case "caja_revisar": return { data: null, error: null };
      case "caja_turnos": return { data: { turnos: [
          { id: "T9", abierto_por: "<b>Ana</b>", abierto_at: "2026-10-27T14:00:00Z", cerrado_por: "Bea", cerrado_at: "2026-10-27T20:00:00Z",
            fondo: 650, fondo_anterior: 700, diferencia_entrega: -50, contado: 980, esperado_al_cerrar: 1000, esperado: 1040, diferencia: -20,
            explicacion: "Di mal un vuelto", ventas_efectivo: 400, n_efectivo: 4, entradas: 0, retiros: 100, movimientos: [] }],
          fuera_de_turno: { ventas: 1, total: 25, folios: [27] } }, error: null };
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
