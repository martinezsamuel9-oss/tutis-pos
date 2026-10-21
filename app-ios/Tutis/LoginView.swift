import SwiftUI
import AuthenticationServices
import CryptoKit

// Entrar con Apple y, la primera vez, crear o vincular el carnet de puntos.
struct LoginView: View {
    @Environment(Estado.self) private var estado
    @Environment(\.dismiss) private var dismiss
    @State private var nonce = ""
    @State private var nombreApple = ""
    @State private var error: String?
    @State private var trabajando = false

    var body: some View {
        NavigationStack {
            Group {
                if estado.fase == .sinCarnet { CarnetNuevoView(nombreInicial: nombreApple, alTerminar: { dismiss() }) }
                else { entrar }
            }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cerrar") { dismiss() } } }
        }
        .onChange(of: estado.fase) { if estado.fase == .listo { dismiss() } }
    }

    private var entrar: some View {
        VStack(spacing: 22) {
            Spacer()
            Foto(nombre: "logo", modo: .fit).frame(height: 70)
            Text("Pide, junta puntos y regala").font(.titular(30)).multilineTextAlignment(.center)
            Text("Entra con tu Apple ID. Tuti's no ve tu contraseña, y puedes ocultar tu correo.")
                .multilineTextAlignment(.center).foregroundStyle(Color.tinta2).padding(.horizontal, 20)
            Spacer()
            if let error { Text(error).font(.system(size: 14)).foregroundStyle(Color.rojo).multilineTextAlignment(.center) }
            SignInWithAppleButton(.continue) { req in
                nonce = Self.nonceAleatorio()
                req.requestedScopes = [.fullName]
                req.nonce = Self.sha256(nonce)
            } onCompletion: { r in
                switch r {
                case .success(let a):
                    guard let c = a.credential as? ASAuthorizationAppleIDCredential,
                          let d = c.identityToken, let token = String(data: d, encoding: .utf8) else { error = "Apple no devolvió la identidad."; return }
                    nombreApple = [c.fullName?.givenName, c.fullName?.familyName].compactMap { $0 }.joined(separator: " ")
                    trabajando = true
                    Task {
                        do { try await estado.entrar(idToken: token, nonce: nonce) }
                        catch { self.error = error.localizedDescription }
                        trabajando = false
                    }
                case .failure(let e):
                    if (e as? ASAuthorizationError)?.code != .canceled { error = e.localizedDescription }
                }
            }
            .signInWithAppleButtonStyle(.black).frame(height: 54).clipShape(Capsule()).disabled(trabajando)
            .overlay { if trabajando { ProgressView().tint(.white) } }
        }
        .padding(24).background(Color.papel)
    }

    static func nonceAleatorio() -> String {
        let letras = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return String(bytes.map { letras[Int($0) % letras.count] })
    }
    static func sha256(_ s: String) -> String { SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }
}

struct CarnetNuevoView: View {
    @Environment(Estado.self) private var estado
    var nombreInicial: String
    var alTerminar: () -> Void
    @State private var tengo = false
    @State private var nombre = ""
    @State private var telefono = ""
    @State private var codigo = ""
    @State private var error: String?
    @State private var trabajando = false

    var body: some View {
        Form {
            Section {
                Picker("", selection: $tengo) { Text("Crear mi carnet").tag(false); Text("Ya tengo carnet").tag(true) }.pickerStyle(.segmented)
            } footer: {
                Text(tengo ? "Si te inscribieron en caja, escribe el código de tu carnet (10 letras y números) y el teléfono con que te inscribiste. Tus puntos se vienen contigo."
                           : "Tu carnet de Tuti's: ganas 1 punto por cada L \(Int(estado.montoPorPunto)) y cada punto vale L 1.")
            }
            if tengo {
                TextField("Código del carnet", text: $codigo).textInputAutocapitalization(.characters).autocorrectionDisabled()
            } else {
                TextField("Tu nombre", text: $nombre).textContentType(.name)
            }
            TextField("Teléfono", text: $telefono).keyboardType(.phonePad).textContentType(.telephoneNumber)
            if let error { Text(error).foregroundStyle(Color.rojo) }
            Button {
                trabajando = true; error = nil
                Task {
                    do {
                        if tengo { try await estado.vincular(codigo: codigo, telefono: telefono) }
                        else { try await estado.registrarme(nombre: nombre, telefono: telefono) }
                        estado.avisar("¡Listo! Ya tienes tu carnet"); alTerminar()
                    } catch { self.error = error.localizedDescription }
                    trabajando = false
                }
            } label: { HStack { Text(tengo ? "Vincular mi carnet" : "Crear mi carnet"); if trabajando { Spacer(); ProgressView() } } }
            .disabled(trabajando || telefono.filter(\.isNumber).count < 8 || (tengo ? codigo.count < 10 : nombre.trimmingCharacters(in: .whitespaces).count < 2))
            Section { Button("Usar otra cuenta", role: .destructive) { Task { await estado.salir() } } }
        }
        .navigationTitle("Tu carnet").navigationBarTitleDisplayMode(.inline)
        .onAppear { if nombre.isEmpty { nombre = nombreInicial } }
    }
}
