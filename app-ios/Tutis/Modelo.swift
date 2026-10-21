import SwiftUI
import Observation

// Datos del prototipo. Sabores y toppings: los de la web de Tuti's (con sus
// fotos). Bebidas y porciones: el catálogo de la caja. Tamaños de taza, envío
// y montos de tarjeta de regalo: de ejemplo. Puntos: L 27 = 1 punto = L 1.

struct Sabor: Identifiable, Hashable { let id: String; let nombre: String }
struct Familia: Identifiable { let id: String; let nombre: String; let opciones: [String] }
struct Tamano: Identifiable, Hashable { let id: String; let nombre: String; let oz: Int; let precio: Double; let toppings: Int }
struct Producto: Identifiable, Hashable { var id: String { nombre }; let categoria: String; let nombre: String; let precio: Double; let detalle: String; let foto: String? }
struct Categoria: Identifiable, Hashable { let id: String; let nombre: String; let detalle: String; let foto: String }
struct Tienda: Identifiable, Hashable { let id: String; let nombre: String; let lugar: String; let minutos: Int }
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
    static let precioPremium = 30.0

    static let tamanos = [
        Tamano(id: "ch", nombre: "Chica", oz: 8, precio: 95, toppings: 2),
        Tamano(id: "md", nombre: "Mediana", oz: 12, precio: 135, toppings: 3),
        Tamano(id: "gr", nombre: "Grande", oz: 16, precio: 175, toppings: 4),
    ]
    static let categorias = [
        Categoria(id: "tazas", nombre: "Tazas de yogurt", detalle: "Arma la tuya", foto: "taro"),
        Categoria(id: "bebidas", nombre: "Bebidas", detalle: "Frías y para llevar", foto: "sorbete-de-toronja"),
        Categoria(id: "llevar", nombre: "Toppings para llevar", detalle: "Porciones", foto: "t-toppings-especiales"),
        Categoria(id: "temporada", nombre: "Temporada", detalle: "Por tiempo limitado", foto: "smores"),
    ]
    static let productos = [
        Producto(categoria: "bebidas", nombre: "Agua en botella", precio: 25, detalle: "Para acompañar tu taza", foto: nil),
        Producto(categoria: "bebidas", nombre: "Latte frío", precio: 65, detalle: "Espresso y leche sobre hielo", foto: nil),
        Producto(categoria: "bebidas", nombre: "Limonada frappé", precio: 80, detalle: "Limón natural, granizado", foto: nil),
        Producto(categoria: "llevar", nombre: "Topping normal", precio: 20, detalle: "Porción para llevar", foto: "t-galletas"),
        Producto(categoria: "llevar", nombre: "Topping premium", precio: 30, detalle: "Porción para llevar", foto: "t-toppings-premium"),
        Producto(categoria: "llevar", nombre: "Crocante chocolate", precio: 60, detalle: "Porción premium", foto: "t-chocolates"),
        Producto(categoria: "llevar", nombre: "Cobertura pistacho", precio: 60, detalle: "Porción premium", foto: "pistacho"),
        Producto(categoria: "temporada", nombre: "S'more fibra miel", precio: 45, detalle: "Solo por temporada", foto: "smores"),
    ]
    static let tiendas = [
        Tienda(id: "gal", nombre: "Tuti's Galerías", lugar: "Mall Galerías", minutos: 12),
        Tienda(id: "mul", nombre: "Tuti's Multiplaza", lugar: "Mall Multiplaza", minutos: 18),
    ]
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
    static let montoPorPunto = 27.0
    static func sabor(_ id: String) -> Sabor? { sabores.first { $0.id == id } }
}

struct LineaPedido: Identifiable, Equatable {
    let id = UUID()
    let nombre: String
    let precio: Double
    let foto: String?
    let detalle: String
    var cantidad: Int
}

struct Taza {
    var tamano: Tamano = Catalogo.tamanos[1]
    var sabores: [String] = []
    var toppings: [String] = []      // "familia:opción"
    var premium: [String] = []
    var cantidad = 1
    var precio: Double { tamano.precio + Double(premium.count) * Catalogo.precioPremium }
    var nombreSabores: String { sabores.compactMap { Catalogo.sabor($0)?.nombre }.joined(separator: " + ") }
}

struct PedidoEnCurso {
    let folio: Int
    var paso: Int
    let total: Double
    let recoger: Bool
    let tienda: Tienda
    let hora: String
    let lineas: [LineaPedido]
    let puntos: Int
}

struct TarjetaRegalo: Identifiable { let id = UUID(); let diseno: DisenoRegalo; var saldo: Double; let numero: String }

@Observable
final class Estado {
    var nombre = "Andrea"
    var puntos = 86
    let codigo = "TK7RMQPAYB"
    var recoger = true
    var tienda = Catalogo.tiendas[0]
    var hora = "ya"
    var usarPuntos = false
    var carrito: [LineaPedido] = []
    var pedido: PedidoEnCurso?
    var misTarjetas = [TarjetaRegalo(diseno: Catalogo.regalos[0], saldo: 250, numero: "6831 9902")]
    var aviso: String?

    var piezas: Int { carrito.reduce(0) { $0 + $1.cantidad } }
    var subtotal: Double { carrito.reduce(0) { $0 + $1.precio * Double($1.cantidad) } }
    var envio: Double { !recoger && !carrito.isEmpty ? 50 : 0 }
    var descuento: Double { usarPuntos ? min(Double(puntos), ((subtotal + envio) * 0.5).rounded(.down)) : 0 }
    var aPagar: Double { subtotal + envio - descuento }

    func agregar(_ l: LineaPedido) {
        if let i = carrito.firstIndex(where: { $0.nombre == l.nombre && $0.detalle == l.detalle }) {
            carrito[i].cantidad += l.cantidad
        } else { carrito.append(l) }
        avisar("\(l.nombre) agregado")
    }
    func avisar(_ t: String) {
        withAnimation(.spring(duration: 0.3)) { aviso = t }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
            withAnimation(.easeOut(duration: 0.25)) { if self?.aviso == t { self?.aviso = nil } }
        }
    }
    func confirmar() {
        let total = aPagar
        puntos -= Int(descuento)
        pedido = PedidoEnCurso(folio: Int.random(in: 140...199), paso: 0, total: total, recoger: recoger, tienda: tienda,
                               hora: hora, lineas: carrito, puntos: Int((total / Catalogo.montoPorPunto).rounded(.down)))
        carrito = []; usarPuntos = false
    }
    func avanzar() {
        guard var p = pedido, p.paso < 3 else { return }
        p.paso += 1
        if p.paso == 3 { puntos += p.puntos }
        pedido = p
    }
}
