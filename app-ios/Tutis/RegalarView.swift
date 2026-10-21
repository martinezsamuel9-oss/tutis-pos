import SwiftUI
import CoreImage.CIFilterBuiltins

// Una tarjeta de regalo: color de fondo + foto real de Tuti's + mensaje.
struct TarjetaRegaloVista: View {
    let diseno: DisenoRegalo
    var grande = false
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .topLeading) {
                Color(hex: diseno.fondo)
                Foto(nombre: diseno.foto, modo: .fit).frame(height: g.size.height * 1.04)
                    .blendMode(.multiply).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing).offset(x: g.size.width * 0.06, y: g.size.height * 0.04)
                VStack(alignment: .leading) {
                    Text(diseno.mensaje).font(.system(size: g.size.width * (grande ? 0.1 : 0.085), weight: .heavy)).tracking(-0.5)
                        .foregroundStyle(Color(hex: diseno.tinta)).frame(width: g.size.width * 0.58, alignment: .leading).lineSpacing(-4)
                    Spacer()
                    Foto(nombre: "logo", modo: .fit).frame(height: g.size.height * 0.15)
                }.padding(.horizontal, g.size.width * 0.07).padding(.vertical, g.size.height * 0.11)
            }
        }
        .aspectRatio(1.586, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: .black.opacity(0.14), radius: 10, y: 5)
        .environment(\.colorScheme, .light)
    }
}

struct RegalarView: View {
    @Environment(Estado.self) private var estado
    @State private var agregar = false
    private var secciones: [String] { Catalogo.regalos.reduce(into: [String]()) { if !$0.contains($1.seccion) { $0.append($1.seccion) } } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                Button { agregar = true } label: {
                    HStack(spacing: 16) {
                        Image(systemName: "creditcard").font(.system(size: 30, weight: .light)).foregroundStyle(Color.tinta2)
                        Text("¿Te regalaron una? Agrégala aquí").font(.display(18)).foregroundStyle(Color.tinta)
                        Spacer()
                    }.padding(18).background(Color.superficie, in: RoundedRectangle(cornerRadius: 18))
                }.buttonStyle(.plain).shadow(color: .black.opacity(0.06), radius: 10, y: 3)

                VStack(alignment: .leading, spacing: 12) {
                    Text("Destacada").font(.display(23, .bold))
                    NavigationLink(value: Catalogo.regalos[0]) { TarjetaRegaloVista(diseno: Catalogo.regalos[0], grande: true) }.buttonStyle(.plain)
                }
                ForEach(secciones, id: \.self) { s in
                    VStack(alignment: .leading, spacing: 12) {
                        HStack { Etiqueta(texto: s); Spacer(); Text("Ver \(Catalogo.regalos.filter { $0.seccion == s }.count)").font(.display(16)).foregroundStyle(Color.magentaHondo) }
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 14) {
                                ForEach(Catalogo.regalos.filter { $0.seccion == s }) { d in
                                    NavigationLink(value: d) { TarjetaRegaloVista(diseno: d).frame(width: 270) }.buttonStyle(.plain)
                                }
                            }.padding(.horizontal, 20).padding(.vertical, 8).scrollTargetLayout()
                        }.scrollTargetBehavior(.viewAligned).padding(.horizontal, -20)
                    }
                }
            }.padding(.horizontal, 20).padding(.bottom, 30)
        }
        .background(Color.papel)
        .navigationTitle("Tarjetas de regalo")
        .navigationDestination(for: DisenoRegalo.self) { ComprarRegaloView(diseno: $0) }
        .sheet(isPresented: $agregar) { AgregarRegaloView().environment(estado).presentationDetents([.medium, .large]) }
    }
}

struct ComprarRegaloView: View {
    let diseno: DisenoRegalo
    @State private var monto = 200
    @State private var nombre = ""
    @State private var contacto = ""
    @State private var mensaje = "¡Disfrútalo! Te mando un antojo de Tuti's."
    @State private var enviada = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                TarjetaRegaloVista(diseno: diseno, grande: true)
                if enviada {
                    VStack(spacing: 10) {
                        Image(systemName: "gift").font(.system(size: 44)).foregroundStyle(Color.magenta)
                        Text("Muy pronto").font(.titular(28))
                        Text("Comprar tarjetas de regalo desde la app llega cuando esté el pago en línea. Por ahora, se compran en la tienda.").multilineTextAlignment(.center).foregroundStyle(Color.tinta2)
                    }.frame(maxWidth: .infinity)
                } else {
                    Text("Monto").font(.display(18))
                    HStack(spacing: 8) {
                        ForEach([100, 200, 300, 500], id: \.self) { m in
                            Button { monto = m } label: {
                                Text("L \(m)").font(.display(16)).frame(maxWidth: .infinity, minHeight: 50)
                                    .foregroundStyle(monto == m ? Color.magentaHondo : Color.tinta)
                                    .background(monto == m ? Color.rubor : Color.superficie, in: RoundedRectangle(cornerRadius: 14))
                                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(monto == m ? Color.magenta : Color.linea, lineWidth: 1.5))
                            }.buttonStyle(.plain).sensoryFeedback(.selection, trigger: monto)
                        }
                    }
                    Text("¿Para quién?").font(.display(18))
                    campo("Nombre", $nombre, "Ej. Sofía")
                    campo("Teléfono o correo", $contacto, "Le llega por WhatsApp o correo")
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Mensaje").font(.system(size: 14, weight: .bold))
                        TextField("Mensaje", text: $mensaje, axis: .vertical).lineLimit(3...6).padding(14)
                            .background(Color.superficie, in: RoundedRectangle(cornerRadius: 14)).overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.linea, lineWidth: 1.5))
                    }
                    Tarjeta {
                        fila("Tarjeta de regalo", Double(monto))
                        Text("Se paga con Apple Pay o tarjeta en línea (fase 2, con BAC). Vale en Galerías y Multiplaza, en caja o en la app.")
                            .font(.system(size: 14)).foregroundStyle(Color.tinta2)
                        Button { withAnimation { enviada = true } } label: { Text("Comprar y enviar · \(lempiras(Double(monto)))").frame(maxWidth: .infinity) }
                            .buttonStyle(BotonPildora()).sensoryFeedback(.success, trigger: enviada)
                    }
                }
            }.padding(20)
        }
        .background(Color.papel)
        .navigationTitle("Tarjeta de regalo").navigationBarTitleDisplayMode(.inline)
    }

    private func campo(_ t: String, _ v: Binding<String>, _ ph: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(t).font(.system(size: 14, weight: .bold))
            TextField(ph, text: v).padding(14).frame(minHeight: 50)
                .background(Color.superficie, in: RoundedRectangle(cornerRadius: 14)).overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.linea, lineWidth: 1.5))
        }
    }
}

struct AgregarRegaloView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("Muy pronto", systemImage: "creditcard")
            } description: {
                Text("Las tarjetas de regalo de Tuti's todavía no están en el sistema. Cuando estén, aquí agregas la tuya con su número y su código, y la usas en caja o en tus pedidos.")
            } actions: { Button("Entendido") { dismiss() }.buttonStyle(BotonPildora()) }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cerrar") { dismiss() } } }
        }
    }
}

struct PuntosView: View {
    @Environment(Estado.self) private var estado

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                Foto(nombre: "p-cheesecake-de-fresa").frame(height: 240).frame(maxWidth: .infinity).clipped().padding(.horizontal, -20)
                VStack(spacing: 8) {
                    Text("Tu próximo antojo puede ser gratis").font(.titular(28)).multilineTextAlignment(.center)
                    Text("Cada compra suma puntos, y cada punto vale un lempira en tu siguiente pedido.").multilineTextAlignment(.center).foregroundStyle(Color.tinta2)
                }.frame(maxWidth: .infinity)

                if let c = estado.carnet {
                    // El carnet: el mismo código que lee la caja, como QR.
                    VStack(spacing: 16) {
                        HStack {
                            Text(c.nombre_completo).font(.system(size: 15, weight: .bold))
                            Spacer()
                            Text("\(c.puntos) puntos · \(lempiras(c.valor))").font(.system(size: 15, weight: .bold)).monospacedDigit()
                        }
                        if let qr = qr(c.codigo) {
                            Image(uiImage: qr).interpolation(.none).resizable().scaledToFit().padding(12).frame(width: 190, height: 190)
                                .background(.white, in: RoundedRectangle(cornerRadius: 18))
                        }
                        Text(c.codigo).font(.system(size: 18, weight: .bold)).tracking(4).textSelection(.enabled)
                        Text("Muéstralo en caja para sumar o usar tus puntos").font(.system(size: 14)).opacity(0.9)
                    }
                    .foregroundStyle(.white).padding(22).frame(maxWidth: .infinity)
                    .background(RadialGradient(colors: [Color(hex: 0xFF6DB5), Color(hex: 0xED1C8E), Color(hex: 0xB80E68)], center: .topTrailing, startRadius: 10, endRadius: 420),
                                in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                    .shadow(color: Color(hex: 0xB80E68).opacity(0.3), radius: 18, y: 10)
                } else {
                    VStack(spacing: 14) {
                        Text("Únete al programa de puntos").font(.display(21, .bold))
                        Text("Si ya tienes carnet de la caja, entra y vincúlalo: tus puntos se vienen contigo.").multilineTextAlignment(.center).foregroundStyle(Color.tinta2)
                        Button(estado.fase == .sinCarnet ? "Crear o vincular mi carnet" : "Entrar con Apple") { estado.pidiendoLogin = true }.buttonStyle(BotonPildora())
                    }.padding(22).frame(maxWidth: .infinity).background(Color.superficie, in: RoundedRectangle(cornerRadius: 24))
                }

                VStack(spacing: 22) {
                    Text("Cómo funciona").font(.display(23, .bold))
                    paso("sparkles", "Junta puntos", "1 punto por cada L \(Int(estado.montoPorPunto)) que pagas, en caja o en la app.")
                    paso("star.circle", "Disfrútalos", "Cada punto vale L 1. Paga con ellos hasta la mitad de tu pedido.")
                    paso("storefront", "En cualquier Tuti's", "Valen en todas las tiendas. Son los mismos del carnet de la caja.")
                }.padding(22).background(Color.hundido, in: RoundedRectangle(cornerRadius: 26, style: .continuous))

                if estado.carnet != nil {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Movimientos").font(.display(18)).padding(.bottom, 6)
                        if estado.movimientos.isEmpty { Text("Todavía no hay movimientos.").foregroundStyle(Color.tinta2).padding(.vertical, 12) }
                        ForEach(estado.movimientos) { m in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(m.tipo == "gana" ? "Compra" : m.tipo == "canje" ? "Canje de puntos" : "Ajuste").font(.display(16))
                                    Text([m.tienda, Self.fecha(m.cuando)].compactMap { $0 }.joined(separator: " · ")).font(.system(size: 14)).foregroundStyle(Color.tinta2)
                                }
                                Spacer()
                                Text(m.puntos > 0 ? "+\(m.puntos)" : "\(m.puntos)").font(.system(size: 16, weight: .bold)).monospacedDigit()
                                    .foregroundStyle(m.puntos > 0 ? Color.verde : Color.tinta2)
                            }.padding(.vertical, 12)
                            Divider()
                        }
                    }
                    Button("Salir de mi cuenta", role: .destructive) { Task { await estado.salir() } }.frame(maxWidth: .infinity)
                }
            }.padding(.horizontal, 20).padding(.bottom, 30)
        }
        .background(Color.papel)
        .refreshable { await estado.refrescar() }
        .navigationTitle("Tuti's Puntos")
    }

    static func fecha(_ iso: String) -> String? {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }
        return d.formatted(.dateTime.day().month(.abbreviated).locale(Locale(identifier: "es_HN")))
    }

    private func paso(_ icono: String, _ t: String, _ d: String) -> some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: icono).font(.system(size: 30, weight: .light)).frame(width: 44)
            VStack(alignment: .leading, spacing: 4) { Text(t).font(.display(19)); Text(d).foregroundStyle(Color.tinta2) }
            Spacer(minLength: 0)
        }
    }

    private func qr(_ texto: String) -> UIImage? {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(texto.utf8); f.correctionLevel = "M"
        guard let img = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let cg = CIContext().createCGImage(img, from: img.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
