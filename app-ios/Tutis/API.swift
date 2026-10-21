import Foundation
import Security

// Conexión con la base de Tuti's (Supabase) sin librerías: la API de Auth
// para la sesión y las funciones (RPC) para todo lo demás. La llave es la
// PÚBLICA, la misma de la caja: lo que protege los datos son las reglas de la
// base, no esconder la llave.
enum Config {
    static let url = URL(string: "https://cykvmzendayjvkxzbhha.supabase.co")!
    static let anon = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5a3ZtemVuZGF5anZreHpiaGhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4NjcyNTEsImV4cCI6MjEwNTQ0MzI1MX0.-7XCQS4FvwEVqlL6YeSbeuOh8hPIPgIJZ7nYAUimXDw"
}

struct Sesion: Codable { var access_token: String; var refresh_token: String; var expires_at: Double }

struct ErrorAPI: LocalizedError { let mensaje: String; var errorDescription: String? { mensaje } }

final class API: @unchecked Sendable {
    static let shared = API()
    private(set) var sesion: Sesion? = Llavero.leer()
    var conSesion: Bool { sesion != nil }

    // --- Sesión -------------------------------------------------------------
    func entrarConApple(idToken: String, nonce: String) async throws {
        let s: Sesion = try await auth("token?grant_type=id_token", ["provider": "apple", "id_token": idToken, "nonce": nonce])
        guardar(s)
    }
    func salir() async {
        if let s = sesion {
            var r = URLRequest(url: Config.url.appending(path: "auth/v1/logout"))
            r.httpMethod = "POST"; r.setValue(Config.anon, forHTTPHeaderField: "apikey")
            r.setValue("Bearer \(s.access_token)", forHTTPHeaderField: "Authorization")
            _ = try? await URLSession.shared.data(for: r)
        }
        sesion = nil; Llavero.borrar()
    }
    private func refrescarSiHaceFalta() async throws {
        guard let s = sesion, Date().timeIntervalSince1970 > s.expires_at - 60 else { return }
        do {
            let n: Sesion = try await auth("token?grant_type=refresh_token", ["refresh_token": s.refresh_token])
            guardar(n)
        } catch { sesion = nil; Llavero.borrar(); throw ErrorAPI(mensaje: "Tu sesión venció. Vuelve a entrar.") }
    }
    private func guardar(_ s: Sesion) { sesion = s; Llavero.guardar(s) }

    private func auth<T: Decodable>(_ ruta: String, _ cuerpo: [String: String]) async throws -> T {
        var r = URLRequest(url: URL(string: Config.url.absoluteString + "/auth/v1/" + ruta)!)
        r.httpMethod = "POST"
        r.setValue(Config.anon, forHTTPHeaderField: "apikey")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONSerialization.data(withJSONObject: cuerpo)
        let (d, resp) = try await URLSession.shared.data(for: r)
        guard (resp as? HTTPURLResponse)?.statusCode ?? 500 < 300 else { throw error(de: d) }
        return try JSONDecoder().decode(T.self, from: d)
    }

    // --- Funciones de la base -------------------------------------------------
    func rpc<T: Decodable>(_ nombre: String, _ params: [String: Any] = [:]) async throws -> T {
        try await refrescarSiHaceFalta()
        var r = URLRequest(url: Config.url.appending(path: "rest/v1/rpc/\(nombre)"))
        r.httpMethod = "POST"
        r.setValue(Config.anon, forHTTPHeaderField: "apikey")
        r.setValue("Bearer \(sesion?.access_token ?? Config.anon)", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONSerialization.data(withJSONObject: params)
        let (d, resp) = try await URLSession.shared.data(for: r)
        guard (resp as? HTTPURLResponse)?.statusCode ?? 500 < 300 else { throw error(de: d) }
        return try JSONDecoder().decode(T.self, from: d)
    }

    private func error(de d: Data) -> ErrorAPI {
        let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
        let m = (j?["message"] ?? j?["msg"] ?? j?["error_description"]) as? String
        return ErrorAPI(mensaje: m ?? "No se pudo conectar con Tuti's. Revisa tu internet.")
    }
}

// La sesión va en el Llavero del iPhone, no en un archivo.
enum Llavero {
    private static let cuenta = "sesion-tutis"
    static func guardar(_ s: Sesion) {
        guard let d = try? JSONEncoder().encode(s) else { return }
        borrar()
        SecItemAdd([kSecClass: kSecClassGenericPassword, kSecAttrAccount: cuenta, kSecValueData: d,
                    kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly] as CFDictionary, nil)
    }
    static func leer() -> Sesion? {
        var out: AnyObject?
        guard SecItemCopyMatching([kSecClass: kSecClassGenericPassword, kSecAttrAccount: cuenta, kSecReturnData: true] as CFDictionary, &out) == errSecSuccess,
              let d = out as? Data else { return nil }
        return try? JSONDecoder().decode(Sesion.self, from: d)
    }
    static func borrar() { SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrAccount: cuenta] as CFDictionary) }
}

// --- Lo que devuelve la base ------------------------------------------------
struct MenuServidor: Decodable {
    struct T: Decodable { let id: String; let nombre: String; let lugar: String }
    struct Tam: Decodable { let id: String; let nombre: String; let oz: Int; let precio: Double; let toppings: Int }
    struct P: Decodable { let id: String; let tienda: String; let familia: String; let nombre: String; let precio: Double }
    let tiendas: [T]; let tamanos: [Tam]; let productos: [P]
    let premium: Double; let domicilio: Bool; let envio: Double; let monto_por_punto: Double?
}
struct CarnetServidor: Decodable { let nombre: String; let nombre_completo: String; let codigo: String; let puntos: Int; let valor: Double }
struct MovimientoServidor: Decodable, Identifiable {
    var id: String { cuando + tipo }
    let tipo: String; let puntos: Int; let monto: Double?; let cuando: String; let tienda: String?
}
struct PedidoServidor: Decodable, Identifiable {
    struct Item: Decodable { let nombre: String; let cantidad: Int; let precio: Double; let sabores: [String]?; let toppings: [String]?; let premium: [String]? }
    let id: String; let folio: Int; let tienda: String; let lugar: String; let modo: String; let hora: String
    let items: [Item]; let total: Double; let estado: String; let creado: String
}
