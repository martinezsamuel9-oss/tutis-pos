import SwiftUI

struct TazaView: View {
    @Environment(Estado.self) private var estado
    @Environment(\.dismiss) private var dismiss
    @State private var taza = Taza(tamano: Tamano(id: "md", nombre: "Mediana", oz: 12, precio: 0, toppings: 3))
    @State private var abierta: String?
    @State private var listo = false
    private let saborInicial: String?
    private let tamanoInicial: Tamano?

    init(saborInicial: String? = nil, tamanoInicial: Tamano? = nil) {
        self.saborInicial = saborInicial; self.tamanoInicial = tamanoInicial
    }

    var body: some View {
        contenido
            .onAppear {
                // El tamaño y su precio vienen de la base (por defecto, el mediano).
                guard !listo else { return }
                listo = true
                if let tm = tamanoInicial ?? estado.tamanos.first(where: { $0.id == "md" }) ?? estado.tamanos.first { taza.tamano = tm }
                if let s = saborInicial { taza.sabores = [s] }
            }
    }

    private var contenido: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                ZStack(alignment: .bottom) {
                    Foto(nombre: "p-" + (taza.sabores.first ?? "vainilla")).frame(height: 240).frame(maxWidth: .infinity).clipped()
                        .animation(.easeInOut, value: taza.sabores.first)
                    LinearGradient(colors: [.clear, Color.papel], startPoint: .center, endPoint: .bottom).frame(height: 100)
                }.padding(.horizontal, -20)

                VStack(alignment: .leading, spacing: 6) {
                    Etiqueta(texto: "Taza \(taza.tamano.nombre.lowercased()) · \(taza.tamano.oz) oz")
                    Text(taza.sabores.isEmpty ? "Elige tus sabores" : taza.nombreSabores).font(.titular(30)).foregroundStyle(Color.tinta)
                }.padding(.top, -50)

                seccion("Tamaño") {
                    HStack(spacing: 10) {
                        ForEach(estado.tamanos) { t in
                            let on = t == taza.tamano
                            let lado: CGFloat = 14 + CGFloat(t.oz) * 1.2
                            Button {
                                taza.tamano = t
                                let tope = t.toppings
                                if taza.toppings.count > tope { taza.toppings = Array(taza.toppings.prefix(tope)) }
                            } label: {
                                VStack(spacing: 4) {
                                    Image("helado").resizable().scaledToFit().frame(width: lado, height: lado)
                                        .foregroundStyle(on ? Color.magenta : Color.tinta2).frame(height: 40)
                                    Text(t.nombre).font(.display(16))
                                    Text("\(t.oz) oz · \(lempiras(t.precio))").font(.system(size: 12)).foregroundStyle(Color.tinta2)
                                }
                                .frame(maxWidth: .infinity).padding(.vertical, 14)
                                .background(on ? Color.rubor : Color.superficie, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(on ? Color.magenta : Color.linea, lineWidth: 1.5))
                            }.buttonStyle(.plain).sensoryFeedback(.selection, trigger: taza.tamano)
                        }
                    }
                }

                seccion("Sabores", detalle: "\(taza.sabores.count) de 3") {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                        ForEach(Catalogo.sabores) { s in
                            let on = taza.sabores.contains(s.id)
                            Button { alternar(&taza.sabores, s.id, tope: 3) } label: {
                                Foto(nombre: s.id).aspectRatio(1.25, contentMode: .fit).frame(maxWidth: .infinity)
                                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(on ? Color.magenta : .clear, lineWidth: 3))
                                    .overlay(alignment: .topTrailing) {
                                        if on { Image(systemName: "checkmark.circle.fill").font(.system(size: 26)).foregroundStyle(.white, Color.magenta).padding(6) }
                                    }
                                    .scaleEffect(on ? 0.96 : 1).opacity(!on && taza.sabores.count >= 3 ? 0.4 : 1)
                                    .accessibilityLabel(s.nombre)
                            }.buttonStyle(.plain).sensoryFeedback(.selection, trigger: on)
                        }
                    }
                }

                seccion("Toppings incluidos", detalle: "\(taza.toppings.count) de \(taza.tamano.toppings)") {
                    ForEach(Catalogo.familias) { f in familiaVista(f, tope: taza.tamano.toppings, lista: $taza.toppings, prefijo: f.id + ":") }
                }
                seccion("Premium", detalle: "+ \(lempiras(estado.precioPremium)) c/u, porción aparte") {
                    familiaVista(Catalogo.premium, tope: 99, lista: $taza.premium, prefijo: "")
                }
                Text("Tamaños y precios de ejemplo: los define la dueña.")
                    .font(.system(size: 13)).foregroundStyle(Color.tinta2).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.hundido, in: RoundedRectangle(cornerRadius: 14))
            }
            .padding(.horizontal, 20).padding(.bottom, 120)
        }
        .background(Color.papel)
        .navigationTitle("Arma tu taza").navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 14) {
                HStack(spacing: 4) {
                    Button { if taza.cantidad > 1 { taza.cantidad -= 1 } } label: { Image(systemName: "minus").frame(width: 36, height: 36) }
                    Text("\(taza.cantidad)").font(.system(size: 17, weight: .bold)).monospacedDigit().frame(minWidth: 18)
                    Button { taza.cantidad += 1 } label: { Image(systemName: "plus").frame(width: 36, height: 36) }
                }.foregroundStyle(Color.tinta).overlay(Capsule().stroke(Color.linea, lineWidth: 1.5))
                Button {
                    let det = [taza.nombreSabores,
                               taza.toppings.compactMap { $0.split(separator: ":").last.map(String.init) }.joined(separator: ", "),
                               taza.premium.map { $0 + " (premium)" }.joined(separator: ", ")].filter { !$0.isEmpty }.joined(separator: " · ")
                    estado.agregar(LineaPedido(nombre: "Taza \(taza.tamano.nombre.lowercased()) \(taza.tamano.oz) oz", precio: taza.precio(premium: estado.precioPremium),
                                               foto: taza.sabores.first, detalle: det, cantidad: taza.cantidad,
                                               item: .taza(tamano: taza.tamano.id, sabores: taza.sabores.compactMap { Catalogo.sabor($0)?.nombre },
                                                           toppings: taza.toppings.compactMap { $0.split(separator: ":").last.map(String.init) }, premium: taza.premium)))
                    dismiss()
                } label: {
                    Text(taza.sabores.isEmpty ? "Elige un sabor" : "Agregar · \(lempiras(taza.precio(premium: estado.precioPremium) * Double(taza.cantidad)))").frame(maxWidth: .infinity)
                }.buttonStyle(BotonPildora()).disabled(taza.sabores.isEmpty).opacity(taza.sabores.isEmpty ? 0.5 : 1)
            }
            .padding(14).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .padding(.horizontal, 14).padding(.bottom, 6)
        }
    }

    private func alternar(_ lista: inout [String], _ v: String, tope: Int) {
        if let i = lista.firstIndex(of: v) { lista.remove(at: i) } else if lista.count < tope { lista.append(v) }
    }

    @ViewBuilder
    private func seccion<C: View>(_ titulo: String, detalle: String? = nil, @ViewBuilder _ contenido: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text(titulo).font(.display(18)); Spacer(); if let d = detalle { Text(d).font(.system(size: 14)).foregroundStyle(Color.tinta2) } }
            contenido()
        }
    }

    private func familiaVista(_ f: Familia, tope: Int, lista: Binding<[String]>, prefijo: String) -> some View {
        let elegidos = f.opciones.filter { lista.wrappedValue.contains(prefijo + $0) }.count
        let abiertaAqui = abierta == f.id
        return VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(.snappy) { abierta = abiertaAqui ? nil : f.id } } label: {
                HStack(spacing: 12) {
                    Foto(nombre: "t-" + f.id).frame(width: 60, height: 60).clipShape(RoundedRectangle(cornerRadius: 12))
                    Text(f.nombre).font(.display(17)).foregroundStyle(Color.tinta)
                    Spacer()
                    if elegidos > 0 {
                        Text("\(elegidos)").font(.system(size: 14, weight: .bold)).frame(minWidth: 30, minHeight: 30)
                            .background(Color.magenta, in: Capsule()).foregroundStyle(Color.sobreMagenta)
                    } else {
                        Image(systemName: abiertaAqui ? "chevron.up" : "chevron.down").font(.system(size: 13, weight: .bold))
                            .frame(width: 30, height: 30).background(Color.hundido, in: Circle()).foregroundStyle(Color.tinta2)
                    }
                }.padding(10).background(Color.superficie, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }.buttonStyle(.plain).shadow(color: .black.opacity(0.05), radius: 8, y: 2)
            if abiertaAqui {
                FlowLayout(spacing: 8) {
                    ForEach(f.opciones, id: \.self) { o in
                        let k = prefijo + o, on = lista.wrappedValue.contains(k)
                        let lleno = !on && (prefijo.isEmpty ? false : lista.wrappedValue.count >= tope)
                        Button { alternar(&lista.wrappedValue, k, tope: prefijo.isEmpty ? 99 : tope) } label: {
                            Text(o).font(.system(size: 15, weight: .semibold)).padding(.horizontal, 14).frame(minHeight: 40)
                                .foregroundStyle(on ? Color.sobreMagenta : Color.tinta)
                                .background(on ? Color.magenta : Color.superficie, in: Capsule())
                                .overlay(Capsule().stroke(on ? Color.clear : Color.linea, lineWidth: 1.5))
                        }.buttonStyle(.plain).disabled(lleno).opacity(lleno ? 0.4 : 1).sensoryFeedback(.selection, trigger: on)
                    }
                }.transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}

// Fila de botones que salta de línea cuando no caben.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let ancho = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, alto: CGFloat = 0
        for s in subviews {
            let t = s.sizeThatFits(.unspecified)
            if x + t.width > ancho, x > 0 { x = 0; y += alto + spacing; alto = 0 }
            x += t.width + spacing; alto = max(alto, t.height)
        }
        return CGSize(width: ancho == .infinity ? x : ancho, height: y + alto)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, alto: CGFloat = 0
        for s in subviews {
            let t = s.sizeThatFits(.unspecified)
            if x + t.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += alto + spacing; alto = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(t))
            x += t.width + spacing; alto = max(alto, t.height)
        }
    }
}
