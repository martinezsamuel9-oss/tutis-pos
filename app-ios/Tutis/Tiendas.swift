import SwiftUI
import MapKit
import CoreLocation

// Las tiendas tal como las configura cada una en la caja (Configuración →
// En la app de clientes): ubicación, horario por día, teléfono y cuánto
// tarda un pedido. La app hace las mismas cuentas que la base
// (motivo_hora_no_valida, sql/18) para no ofrecer una hora que la base va a
// rechazar; la que manda sigue siendo la base.

struct Franja: Codable, Hashable { let abre: String; let cierra: String }

struct Tienda: Identifiable, Hashable {
    let id: String; let nombre: String; let lugar: String
    var lat: Double? = nil; var lng: Double? = nil
    var horario: [String: Franja?]? = nil
    var telefono: String? = nil
    var minutos: Int = 15
    var zona = TimeZone(identifier: "America/Tegucigalpa")!

    var nombreCorto: String { nombre.replacingOccurrences(of: "Tuti's ", with: "") }
    var coordenada: CLLocationCoordinate2D? {
        guard let lat, let lng else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
    var ubicacion: CLLocation? { lat.flatMap { la in lng.map { CLLocation(latitude: la, longitude: $0) } } }

    static let dias = ["dom", "lun", "mar", "mie", "jue", "vie", "sab"]          // índice = weekday − 1
    static let nombresDia = ["dom": "Domingo", "lun": "Lunes", "mar": "Martes", "mie": "Miércoles", "jue": "Jueves", "vie": "Viernes", "sab": "Sábado"]

    private var calendario: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = zona; return c }
    private func clave(_ fecha: Date) -> String { Self.dias[calendario.component(.weekday, from: fecha) - 1] }
    func franja(_ fecha: Date) -> Franja? { horario?[clave(fecha)] ?? nil }
    /// Minutos desde medianoche, hora de la tienda.
    private func minuto(_ fecha: Date) -> Int { let c = calendario.dateComponents([.hour, .minute], from: fecha); return c.hour! * 60 + c.minute! }

    enum Estado { case sinHorario, abierta(hasta: String), cierraPronto(a: String), abre(cuando: String), cerrada }

    func estado(_ ahora: Date = .now) -> Estado {
        guard horario != nil else { return .sinHorario }
        let m = minuto(ahora)
        if let f = franja(ahora) {
            if m < minutos(f.abre) { return .abre(cuando: "hoy a las \(horaBonita(f.abre))") }
            if m < minutos(f.cierra) { return minutos(f.cierra) - m <= 30 ? .cierraPronto(a: horaBonita(f.cierra)) : .abierta(hasta: horaBonita(f.cierra)) }
        }
        // Próximo día que abre.
        for i in 1...7 {
            guard let dia = calendario.date(byAdding: .day, value: i, to: ahora), let f = franja(dia) else { continue }
            let cuando = i == 1 ? "mañana" : "el \(Self.nombresDia[clave(dia)]!.lowercased())"
            return .abre(cuando: "\(cuando) a las \(horaBonita(f.abre))")
        }
        return .cerrada
    }

    /// Lo mismo que motivo_hora_no_valida en la base: nil si se puede pedir para esa hora.
    func motivo(_ hora: String, _ ahora: Date = .now) -> String? {
        guard horario != nil else { return nil }
        guard let f = franja(ahora) else { return "La tienda no abre hoy" }
        let m = minuto(ahora) + 1          // +1: la base cuenta también los segundos
        let listo = m + minutos
        if listo >= 24 * 60 { return "La tienda ya cerró por hoy" }
        if hora == "ya" {
            if m - 1 < minutos(f.abre) { return "La tienda abre a las \(horaBonita(f.abre))" }
            if listo > minutos(f.cierra) { return "La tienda ya cerró por hoy" }
            return nil
        }
        let p = minutos(hora)
        if p < minutos(f.abre) || p > minutos(f.cierra) { return "Hoy la tienda abre de \(horaBonita(f.abre)) a \(horaBonita(f.cierra))" }
        if p < listo { return "Esa hora ya pasó o no da tiempo de prepararlo" }
        return nil
    }

    /// Las horas que se pueden elegir hoy para recoger: "ya" si está abierta,
    /// y luego cada media hora hasta el cierre.
    func horasParaRecoger(_ ahora: Date = .now) -> [(valor: String, texto: String)] {
        guard horario != nil else { return [("ya", "Lo antes posible")] }
        guard let f = franja(ahora) else { return [] }
        var horas: [(String, String)] = motivo("ya", ahora) == nil ? [("ya", "Lo antes posible")] : []
        var m = max(minutos(f.abre), minuto(ahora) + 1 + minutos)
        m = (m + 14) / 15 * 15
        while m <= minutos(f.cierra) {
            let v = String(format: "%02d:%02d", m / 60, m % 60)
            if motivo(v, ahora) == nil { horas.append((v, horaBonita(v))) }
            m += m % 30 == 0 ? 30 : 15
        }
        return horas
    }

    var horarioSemana: [(dia: String, texto: String)] {
        guard let h = horario else { return [] }
        return ["lun", "mar", "mie", "jue", "vie", "sab", "dom"].map { d in
            (Self.nombresDia[d]!, (h[d] ?? nil).map { "\(horaBonita($0.abre)) – \(horaBonita($0.cierra))" } ?? "Cerrado")
        }
    }

    private func minutos(_ hhmm: String) -> Int {
        let p = hhmm.split(separator: ":").compactMap { Int($0) }
        return p.count == 2 ? p[0] * 60 + p[1] : 0
    }
}

/// "15:30" → "3:30 pm"
func horaBonita(_ hhmm: String) -> String {
    let p = hhmm.split(separator: ":").compactMap { Int($0) }
    guard p.count == 2 else { return hhmm }
    let h12 = p[0] % 12 == 0 ? 12 : p[0] % 12
    return String(format: "%d:%02d %@", h12, p[1], p[0] < 12 ? "am" : "pm")
}

extension Tienda.Estado {
    var texto: String {
        switch self {
        case .sinHorario: "Horario por confirmar"
        case .abierta(let h): "Abierto · hasta las \(h)"
        case .cierraPronto(let h): "Cierra pronto · \(h)"
        case .abre(let c): "Cerrado · abre \(c)"
        case .cerrada: "Cerrado"
        }
    }
    var abierta: Bool { switch self { case .abierta, .cierraPronto: true; default: false } }
    var color: Color { switch self { case .abierta: .verde; case .sinHorario: .tinta2; case .cierraPronto: .magentaHondo; default: .rojo } }
    var fondo: Color { switch self { case .abierta: .verdeFondo; case .sinHorario: .hundido; case .cierraPronto: .rubor; default: .rojoFondo } }
}

// --- Dónde está el cliente -----------------------------------------------------
// Solo "mientras se usa la app", y solo para ordenar las tiendas por cercanía.
// No se guarda ni se manda a ningún lado.
@MainActor @Observable
final class Ubicador: NSObject, CLLocationManagerDelegate {
    var ubicacion: CLLocation?
    var permiso: CLAuthorizationStatus
    private let gestor = CLLocationManager()

    override init() {
        permiso = gestor.authorizationStatus
        super.init()
        gestor.delegate = self
        gestor.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    var concedido: Bool { permiso == .authorizedWhenInUse || permiso == .authorizedAlways }

    func pedir() {
        if permiso == .notDetermined { gestor.requestWhenInUseAuthorization() } else if concedido { gestor.requestLocation() }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ g: CLLocationManager) {
        let s = g.authorizationStatus
        Task { @MainActor in
            self.permiso = s
            if self.concedido { self.gestor.requestLocation() }
        }
    }
    nonisolated func locationManager(_ g: CLLocationManager, didUpdateLocations l: [CLLocation]) {
        let u = l.last
        Task { @MainActor in self.ubicacion = u }
    }
    nonisolated func locationManager(_ g: CLLocationManager, didFailWithError error: Error) {}

    func distancia(a t: Tienda) -> CLLocationDistance? {
        guard let u = ubicacion, let d = t.ubicacion else { return nil }
        return u.distance(from: d)
    }
}

func distanciaBonita(_ m: CLLocationDistance) -> String {
    m < 1000 ? "a \(Int((m / 50).rounded()) * 50) m" : m < 100_000 ? String(format: "a %.1f km", m / 1000) : "a \(Int(m / 1000)) km"
}

// --- Cómo llegar ----------------------------------------------------------------
// En Honduras se usa mucho Waze; se ofrecen los tres. Son enlaces universales:
// abren la app si está instalada y, si no, el navegador.
enum Ruta: CaseIterable {
    case apple, google, waze
    var nombre: String { switch self { case .apple: "Apple Maps"; case .google: "Google Maps"; case .waze: "Waze" } }
    func url(_ t: Tienda) -> URL? {
        guard let lat = t.lat, let lng = t.lng else { return nil }
        let nombre = t.nombre.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        switch self {
        case .apple: return URL(string: "https://maps.apple.com/?daddr=\(lat),\(lng)&q=\(nombre)&dirflg=d")
        case .google: return URL(string: "https://www.google.com/maps/dir/?api=1&destination=\(lat),\(lng)&travelmode=driving")
        case .waze: return URL(string: "https://waze.com/ul?ll=\(lat),\(lng)&navigate=yes")
        }
    }
}

struct BotonComoLlegar: View {
    let tienda: Tienda
    var principal = false
    @Environment(\.openURL) private var abrir
    var body: some View {
        Menu {
            ForEach(Ruta.allCases, id: \.self) { r in
                Button(r.nombre) { if let u = r.url(tienda) { abrir(u) } }
            }
        } label: {
            Label("Cómo llegar", systemImage: "arrow.triangle.turn.up.right.diamond.fill")
                .font(.display(16)).padding(.horizontal, 18).frame(minHeight: 50)
                .foregroundStyle(Color.tinta)
                .background(Color.superficie, in: Capsule())
                .overlay(Capsule().stroke(Color.linea, lineWidth: 1.5))
        }
        .disabled(tienda.coordenada == nil)
    }
}
