import SwiftUI
import Observation

// Lo que viene de la BASE: tiendas, tamaños de taza, productos con su precio,
// carnet y puntos, pedidos. Lo que sigue en la app: los sabores y toppings con
// sus fotos (el catálogo de la web de Tuti's; en la base todavía no está el
// real) y los diseños de tarjeta de regalo (aún sin respaldo en la base).

struct Sabor: Identifiable, Hashable { let id: String; let nombre: String }
struct Familia: Identifiable { let id: String; let nombre: String; let opciones: [String] }
struct Tamano: Identifiable, Hashable { let id: String; let nombre: String; let oz: Int; let precio: Double; let toppings: Int }
struct Producto: Identifiable, Hashable { let id: String; let tienda: String; let familia: String; let nombre: String; let precio: Double }
struct Tienda: Identifiable, Hashable { let id: String; let nombre: String; let lugar: String; var minutos: Int = 15 }
struct DisenoRegalo: Identifiable, Hashable { let id: String; let seccion: String; let mensaje: String; let foto: String; let fondo: UInt32; let tinta: UInt32 }

enum Catalogo {
    static let sabores: [Sabor] = [
        ("vainilla", "Vainilla"), ("fresa", "Fresa"), ("chocolate", "Chocolate"), ("taro", "Taro"), ("pistacho", "Pistacho"),
        ("mango", "Mango"), ("red-velvet", "Red Velvet"), ("cookies-and-cream", "Cookies & Cream"), ("salted-caramel", "Salted Caramel"),
        ("cheesecake-de-fresa", "Cheesecake de fresa"), ("birthday-cake", "Birthday Cake"), ("tiramisu", "Tiramisú"),
        ("key-lime-pie", "Key Lime Pie"), ("dulce-de-leche", "Dulce de leche"), ("cookie-dough", "Cookie Dough"),
        ("smores", "S'mores"), ("snickers", "Snickers"), ("sorbete-de-mora", "Sorbete de mora"),
        ("sorbete-de-maracuya", "Sorbete de maracuyá"), ("sorbete-de-mandarina", "Sorbete de mandarina"),
        ("sorbete-de-sandia-limon", "Sorbete sandía-limón"), ("sorbete-de-toronja", "Sorbete pink lemonade"), ("sorbete-de-fresa", "Sorbete de fresa"),
    ].map { Sabor(id: $0.0, nombre: $0.1) }

    static let familias: [Familia] = [
        Familia(id: "dulces", nombre: "Dulces", opciones: ["Marshmallows", "Candy Corn", "Sprinkles"]),
        Familia(id: "gummies", nombre: "Gomitas", opciones: ["Gummy Bears", "Delfines", "Donas", "Gusanos"]),
        Familia(id: "galletas", nombre: "Galletas", opciones: ["Oreo", "Waffle", "Cono", "Chips Ahoy", "Yippy"]),
        Familia(id: "chocolates", nombre: "Chocolates", opciones: ["Chispas de chocolate", "Brownie", "Milk Chocolate"]),
        Familia(id: "frutas", nombre: "Frutas", opciones: ["Fresas", "Tutti Frutti", "Coco", "Melocotón", "Cerezas", "Kiwi"]),
        Familia(id: "nueces-y-cereales", nombre: "Nueces y cereales", opciones: ["Maní", "Granola"]),
        Familia(id: "jaleas", nombre: "Jaleas", opciones: ["Fresa", "Piña", "Maracuyá", "Mora"]),
        Familia(id: "salsas", nombre: "Salsas", opciones: ["Peanut Butter", "Nutella", "Caramelo", "Hershey Syrup", "Leche condensada", "Marshmallow"]),
    ]
    static let premium = Familia(id: "toppings-premium", nombre: "Toppings premium", opciones: ["M&M's", "Almendras", "Sour Power", "Cookies & Cream", "Mini Reese's"])

    static let regalos = [
        DisenoRegalo(id: "cumple", seccion: "Cumpleaños", mensaje: "¡Feliz cumple!", foto: "g-cumple", fondo: 0xFFE36E, tinta: 0x2B1622),
        DisenoRegalo(id: "redvelvet", seccion: "Cumpleaños", mensaje: "Otro año más dulce", foto: "g-redvelvet", fondo: 0xFFD3DC, tinta: 0x7A1030),
        DisenoRegalo(id: "gracias", seccion: "Gracias", mensaje: "Gracias por tanto", foto: "g-gracias", fondo: 0xFFF0F3, tinta: 0xB80E68),
        DisenoRegalo(id: "pistacho", seccion: "Gracias", mensaje: "Te lo debía", foto: "g-pistacho", fondo: 0xE4F2CF, tinta: 0x2F5A12),
        DisenoRegalo(id: "amor", seccion: "Con amor", mensaje: "Te quiero un montón", foto: "g-amor", fondo: 0xFFE1EC, tinta: 0xC30F4A),
        DisenoRegalo(id: "taro", seccion: "Con amor", mensaje: "Para mi persona favorita", foto: "g-taro", fondo: 0xEBDDF6, tinta: 0x4B2470),
        DisenoRegalo(id: "celebra", seccion: "Celebración", mensaje: "¡Lo lograste!", foto: "g-celebra", fondo: 0xFFF1C9, tinta: 0x9A4A00),
        DisenoRegalo(id: "paraTi", seccion: "Celebración", mensaje: "Un antojo para ti", foto: "g-paraTi", fondo: 0xF3E6D8, tinta: 0x5A3218),
    ]
    static func sabor(_ id: String) -> Sabor? { sabores.first { $0.id == id } }

    // Foto para cada familia de productos de la caja.
    static func fotoFamilia(_ f: String) -> String {
        switch f.lowercased() {
        case "bebidas": return "sorbete-de-toronja"
        case "toppings": return "t-toppings-especiales"
        case "temporada": return "smores"
        default: return "t-dulces"
        }
    }
    static func fotoProducto(_ nombre: String) -> String? {
        let n = nombre.lowercased()
        if n.contains("premium") { return "t-toppings-premium" }
        if n.contains("topping") { return "t-galletas" }
        if n.contains("crocante") || n.contains("chocolate") { return "t-chocolates" }
        if n.contains("pistacho") { return "pistacho" }
        if n.contains("cobertura") { return "t-salsas" }
        if n.contains("s'more") || n.contains("smore") { return "smores" }
        return nil
    }
}

enum ItemPedido: Equatable {
    case taza(tamano: String, sabores: [String], toppings: [String], premium: [String])
    case producto(id: String)
}

struct LineaPedido: Identifiable, Equatable {
    let id = UUID()
    let nombre: String
    let precio: Double
    let foto: String?
    let detalle: String
    var cantidad: Int
    let item: ItemPedido

    var payload: [String: Any] {
        switch item {
        case let .taza(t, s, tp, p): return ["tipo": "taza", "tamano": t, "sabores": s, "toppings": tp, "premium": p, "cantidad": cantidad]
        case let .producto(id): return ["tipo": "producto", "producto": id, "cantidad": cantidad]
        }
    }
}

struct Taza {
    var tamano: Tamano
    var sabores: [String] = []
    var toppings: [String] = []      // "familia:opción"
    var premium: [String] = []
    var cantidad = 1
    func precio(premium p: Double) -> Double { tamano.precio + Double(premium.count) * p }
    var nombreSabores: String { sabores.compactMap { Catalogo.sabor($0)?.nombre }.joined(separator: " + ") }
}

enum Fase { case cargando, invitado, sinCarnet, listo }

@MainActor @Observable
final class Estado {
    var fase: Fase = .cargando
    var carnet: CarnetServidor?
    var movimientos: [MovimientoServidor] = []
    var pedidos: [PedidoServidor] = []
    var errorMenu: String?

    var tiendas: [Tienda] = []
    var tamanos: [Tamano] = []
    var productos: [Producto] = []
    var precioPremium = 30.0
    var aceptaDomicilio = false
    var costoEnvio = 50.0
    var montoPorPunto = 27.0

    var recoger = true
    var tiendaId: String?
    var hora = "ya"
    var usarPuntos = false
    var carrito: [LineaPedido] = []
    var aviso: String?
    var pidiendoLogin = false
    var misTarjetas: [(diseno: DisenoRegalo, saldo: Double, numero: String)] = []

    var nombre: String { carnet?.nombre ?? "" }
    var puntos: Int { carnet?.puntos ?? 0 }
    var tienda: Tienda? { tiendas.first { $0.id == tiendaId } ?? tiendas.first }
    var piezas: Int { carrito.reduce(0) { $0 + $1.cantidad } }
    var subtotal: Double { carrito.reduce(0) { $0 + $1.precio * Double($1.cantidad) } }
    var envio: Double { !recoger && !carrito.isEmpty ? costoEnvio : 0 }
    var pedidoActivo: PedidoServidor? { pedidos.first { ["recibido", "preparando", "listo"].contains($0.estado) } }
    var familias: [String] {
        guard let t = tienda else { return [] }
        return productos.filter { $0.tienda == t.id }.map(\.familia).reduce(into: []) { if !$0.contains($1) { $0.append($1) } }
    }

    // --- Arranque ------------------------------------------------------------
    func cargar() async {
        do {
            let m: MenuServidor = try await API.shared.rpc("app_menu")
            tiendas = m.tiendas.map { Tienda(id: $0.id, nombre: $0.nombre, lugar: $0.lugar) }
            tamanos = m.tamanos.map { Tamano(id: $0.id, nombre: $0.nombre, oz: $0.oz, precio: $0.precio, toppings: $0.toppings) }
            productos = m.productos.map { Producto(id: $0.id, tienda: $0.tienda, familia: $0.familia, nombre: $0.nombre, precio: $0.precio) }
            precioPremium = m.premium; aceptaDomicilio = m.domicilio; costoEnvio = m.envio
            if let mp = m.monto_por_punto { montoPorPunto = mp }
            if tiendaId == nil { tiendaId = tiendas.first?.id }
            errorMenu = nil
        } catch { errorMenu = error.localizedDescription }
        await cargarCliente()
    }

    func cargarCliente() async {
        guard API.shared.conSesion else { fase = .invitado; carnet = nil; return }
        do {
            let c: CarnetServidor? = try await API.shared.rpc("app_mi_carnet")
            carnet = c
            fase = c == nil ? .sinCarnet : .listo
            if c != nil { await refrescar() }
        } catch { fase = API.shared.conSesion ? .sinCarnet : .invitado }
    }

    func refrescar() async {
        guard fase == .listo else { return }
        if let p: [PedidoServidor] = try? await API.shared.rpc("app_mis_pedidos") { pedidos = p }
        if let m: [MovimientoServidor] = try? await API.shared.rpc("app_movimientos") { movimientos = m }
        if let c: CarnetServidor? = try? await API.shared.rpc("app_mi_carnet"), let c { carnet = c }
    }

    // --- Cuenta y carnet -------------------------------------------------------
    func entrar(idToken: String, nonce: String) async throws {
        try await API.shared.entrarConApple(idToken: idToken, nonce: nonce)
        await cargarCliente()
    }
    func registrarme(nombre: String, telefono: String) async throws {
        let c: CarnetServidor = try await API.shared.rpc("app_registrarme", ["p_nombre": nombre, "p_telefono": telefono])
        carnet = c; fase = .listo; await refrescar()
    }
    func vincular(codigo: String, telefono: String) async throws {
        let c: CarnetServidor = try await API.shared.rpc("app_vincular_carnet", ["p_codigo": codigo, "p_telefono": telefono])
        carnet = c; fase = .listo; await refrescar()
    }
    func salir() async {
        await API.shared.salir()
        carnet = nil; pedidos = []; movimientos = []; fase = .invitado
    }

    // --- Pedido ---------------------------------------------------------------
    func agregar(_ l: LineaPedido) {
        if let i = carrito.firstIndex(where: { $0.item == l.item }) { carrito[i].cantidad += l.cantidad } else { carrito.append(l) }
        avisar("\(l.nombre) agregado")
    }
    func avisar(_ t: String) {
        withAnimation(.spring(duration: 0.3)) { aviso = t }
        Task { try? await Task.sleep(for: .seconds(1.8)); withAnimation(.easeOut(duration: 0.25)) { if aviso == t { aviso = nil } } }
    }
    func confirmar() async throws {
        guard let t = tienda else { throw ErrorAPI(mensaje: "Elige una tienda") }
        let p: PedidoServidor = try await API.shared.rpc("app_crear_pedido", ["payload": [
            "tienda": t.id, "modo": recoger ? "recoger" : "domicilio", "hora": hora, "usar_puntos": usarPuntos,
            "items": carrito.map(\.payload)] as [String: Any]])
        pedidos.insert(p, at: 0)
        carrito = []; usarPuntos = false
    }
    func cancelar(_ id: String) async throws {
        let p: PedidoServidor = try await API.shared.rpc("app_cancelar_pedido", ["p_id": id])
        if let i = pedidos.firstIndex(where: { $0.id == id }) { pedidos[i] = p }
    }
}
