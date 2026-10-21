import SwiftUI

struct CarritoView: View {
    @Environment(Estado.self) private var estado
    @Environment(\.dismiss) private var dismiss
    var alConfirmar: () -> Void

    private let horas = [("ya", "Ya"), ("15:30", "3:30 pm"), ("16:00", "4:00 pm"), ("16:30", "4:30 pm"), ("17:00", "5:00 pm"), ("18:00", "6:00 pm")]

    var body: some View {
        @Bindable var estado = estado
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if estado.carrito.isEmpty {
                        ContentUnavailableView("Tu pedido está vacío", image: "helado", description: Text("Arma una taza o agrega una bebida."))
                    }
                    ForEach($estado.carrito) { $l in
                        HStack(alignment: .top, spacing: 12) {
                            Group { if let f = l.foto { Foto(nombre: f) } else { ZStack { Color.rubor; Image(systemName: "takeoutbag.and.cup.and.straw.fill").foregroundStyle(Color.magenta) } } }
                                .frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 14))
                            VStack(alignment: .leading, spacing: 4) {
                                Text(l.nombre).font(.display(17))
                                if !l.detalle.isEmpty { Text(l.detalle).font(.system(size: 14)).foregroundStyle(Color.tinta2) }
                                Stepper(value: $l.cantidad, in: 0...20) { Text("\(l.cantidad)").monospacedDigit() }.fixedSize()
                            }
                            Spacer()
                            Text(lempiras(l.precio * Double(l.cantidad))).font(.system(size: 16, weight: .semibold)).monospacedDigit()
                        }
                        Divider()
                    }
                    .onChange(of: estado.carrito.map(\.cantidad)) { estado.carrito.removeAll { $0.cantidad == 0 } }

                    if !estado.carrito.isEmpty {
                        Tarjeta {
                            Etiqueta(texto: "Recoger en")
                            Picker("Tienda", selection: $estado.tiendaId) {
                                ForEach(estado.tiendas) { Text($0.nombre).tag(Optional($0.id)) }
                            }.pickerStyle(.menu).tint(Color.tinta)
                            Etiqueta(texto: "Hora")
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(horas, id: \.0) { v, t in
                                        Button { estado.hora = v } label: {
                                            Text(v == "ya" ? "Lo antes posible" : t).font(.system(size: 15, weight: .semibold))
                                                .padding(.horizontal, 14).frame(minHeight: 44)
                                                .foregroundStyle(estado.hora == v ? Color.papel : Color.tinta)
                                                .background(estado.hora == v ? Color.tinta : Color.superficie, in: RoundedRectangle(cornerRadius: 14))
                                                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.linea, lineWidth: estado.hora == v ? 0 : 1.5))
                                        }.buttonStyle(.plain)
                                    }
                                }
                            }
                        }
                        Tarjeta {
                            fila("Total", estado.subtotal, grande: true)
                            Text("Ganas unos \(Int((estado.subtotal / estado.montoPorPunto).rounded(.down))) puntos al pagar con tu carnet").font(.system(size: 14)).foregroundStyle(Color.tinta2)
                            NavigationLink { PagarView(alConfirmar: alConfirmar) } label: { Text("Continuar").frame(maxWidth: .infinity) }
                                .buttonStyle(BotonPildora())
                        }
                    }
                }.padding(20)
            }
            .background(Color.papel)
            .navigationTitle("Tu pedido").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cerrar") { dismiss() } } }
        }
    }
}

func fila(_ t: String, _ v: Double, suave: Bool = false, grande: Bool = false, color: Color? = nil) -> some View {
    HStack { Text(t); Spacer(); Text(lempiras(v)).monospacedDigit() }
        .font(grande ? .display(22, .bold) : .system(size: 16))
        .foregroundStyle(color ?? (suave ? Color.tinta2 : Color.tinta))
}

struct PagarView: View {
    @Environment(Estado.self) private var estado
    var alConfirmar: () -> Void
    @State private var enviando = false
    @State private var error: String?

    var body: some View {
        @Bindable var estado = estado
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let t = estado.tienda {
                    Tarjeta {
                        Etiqueta(texto: "Recoges en")
                        Text(t.nombre).font(.display(19))
                        Text((t.lugar.isEmpty ? "" : "\(t.lugar) · ") + (estado.hora == "ya" ? "lo antes posible" : "a las \(estado.hora)")).foregroundStyle(Color.tinta2)
                    }
                }
                Text("Forma de pago").font(.display(18))
                opcion("Pagar al recoger", "Efectivo o tarjeta en la caja. Muestra tu carnet para sumar puntos.", activa: true)
                opcion("Apple Pay o tarjeta en línea", "Próximamente, con BAC Credomatic.", activa: false, deshabilitada: true)
                if estado.fase == .listo {
                    Toggle(isOn: $estado.usarPuntos) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Quiero usar mis puntos").font(.display(16))
                            Text("Tienes \(lempiras(Double(estado.puntos))). Se descuentan en caja al pagar, hasta la mitad.").font(.system(size: 14)).foregroundStyle(Color.tinta2)
                        }
                    }.padding(14).background(Color.superficie, in: RoundedRectangle(cornerRadius: 16)).tint(Color.magenta)
                }
                Tarjeta {
                    ForEach(estado.carrito) { l in fila("\(l.cantidad) × \(l.nombre)", l.precio * Double(l.cantidad)) }
                    fila("Total", estado.subtotal, grande: true)
                    if let error { Text(error).font(.system(size: 14)).foregroundStyle(Color.rojo) }
                    Button {
                        guard estado.fase == .listo else { estado.pidiendoLogin = true; return }
                        enviando = true; error = nil
                        Task {
                            do { try await estado.confirmar(); alConfirmar() }
                            catch { self.error = error.localizedDescription }
                            enviando = false
                        }
                    } label: {
                        HStack { if enviando { ProgressView().tint(.white) }; Text(estado.fase == .listo ? "Hacer pedido" : "Entra para hacer tu pedido") }.frame(maxWidth: .infinity)
                    }
                    .buttonStyle(BotonPildora()).disabled(enviando).sensoryFeedback(.success, trigger: estado.pedidoActivo?.id)
                    Text("El total lo confirma la tienda con los precios vigentes.").font(.system(size: 13)).foregroundStyle(Color.tinta2)
                }
            }.padding(20)
        }
        .background(Color.papel)
        .navigationTitle("Confirmar").navigationBarTitleDisplayMode(.inline)
    }

    private func opcion(_ t: String, _ d: String, activa: Bool, deshabilitada: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: activa ? "largecircle.fill.circle" : "circle").font(.system(size: 22)).foregroundStyle(activa ? Color.magenta : Color.linea)
            VStack(alignment: .leading, spacing: 2) { Text(t).font(.display(16)); Text(d).font(.system(size: 14)).foregroundStyle(Color.tinta2) }
            Spacer()
        }
        .padding(14).background(activa ? Color.rubor : Color.superficie, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(activa ? Color.magenta : Color.linea, lineWidth: 1.5))
        .opacity(deshabilitada ? 0.55 : 1)
    }
}

struct SeguimientoView: View {
    @Environment(Estado.self) private var estado
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?

    static func titulo(_ e: String) -> String {
        ["recibido": "Recibido", "preparando": "Preparando", "listo": "Listo para recoger", "entregado": "Entregado", "cancelado": "Cancelado"][e] ?? e
    }
    static func detalle(_ e: String) -> String {
        ["recibido": "La tienda ya tiene tu pedido", "preparando": "Estamos sirviendo tu taza", "listo": "Pasa a la caja y di tu número",
         "entregado": "¡Que lo disfrutes!", "cancelado": "Este pedido se canceló"][e] ?? ""
    }
    static func paso(_ e: String) -> Int { ["recibido": 0, "preparando": 1, "listo": 2, "entregado": 3][e] ?? 0 }

    var body: some View {
        NavigationStack {
            ScrollView {
                if let p = estado.pedidoActivo ?? estado.pedidos.first {
                    let paso = Self.paso(p.estado), cancelado = p.estado == "cancelado"
                    VStack(spacing: 22) {
                        ZStack {
                            Circle().stroke(Color.linea, lineWidth: 10)
                            Circle().trim(from: 0, to: cancelado ? 0 : CGFloat(paso + 1) / 4).stroke(Color.magenta, style: StrokeStyle(lineWidth: 10, lineCap: .round))
                                .rotationEffect(.degrees(-90)).animation(.spring(duration: 0.6), value: paso)
                            Text("#\(p.folio)").font(.system(size: 30, weight: .heavy)).monospacedDigit()
                        }.frame(width: 144, height: 144).padding(.top, 10)
                        VStack(spacing: 6) {
                            Text(Self.titulo(p.estado)).font(.titular(32)).contentTransition(.opacity)
                            Text(Self.detalle(p.estado)).foregroundStyle(Color.tinta2)
                        }
                        .sensoryFeedback(.success, trigger: p.estado)
                        Tarjeta {
                            Etiqueta(texto: "Recoges en")
                            Text(p.tienda).font(.display(18)); if !p.lugar.isEmpty { Text(p.lugar).foregroundStyle(Color.tinta2) }
                            Text(p.hora == "ya" ? "Lo antes posible" : "A las \(p.hora)").foregroundStyle(Color.tinta2)
                        }
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Tu pedido").font(.display(18))
                            ForEach(Array(p.items.enumerated()), id: \.offset) { _, i in
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack { Text("\(i.cantidad) × \(i.nombre)").font(.system(size: 16, weight: .semibold)); Spacer(); Text(lempiras(i.precio)).monospacedDigit() }
                                    let det = [(i.sabores ?? []).joined(separator: " + "), (i.toppings ?? []).joined(separator: ", "),
                                               (i.premium ?? []).map { $0 + " (premium)" }.joined(separator: ", ")].filter { !$0.isEmpty }.joined(separator: " · ")
                                    if !det.isEmpty { Text(det).font(.system(size: 14)).foregroundStyle(Color.tinta2) }
                                }
                            }
                            Divider()
                            fila("Pagas al recoger", p.total, grande: true)
                            Text("Muestra tu carnet en caja para sumar puntos.").font(.system(size: 14)).foregroundStyle(Color.tinta2)
                        }.padding(16).background(Color.superficie, in: RoundedRectangle(cornerRadius: 20))
                        if let error { Text(error).font(.system(size: 14)).foregroundStyle(Color.rojo) }
                        if p.estado == "recibido" {
                            Button("Cancelar pedido", role: .destructive) {
                                Task { do { try await estado.cancelar(p.id) } catch { self.error = error.localizedDescription } }
                            }
                        }
                    }.padding(20)
                } else {
                    ContentUnavailableView("Sin pedidos", image: "helado", description: Text("Cuando hagas un pedido, aquí ves cómo va."))
                }
            }
            .background(Color.papel)
            .refreshable { await estado.refrescar() }
            .navigationTitle("Tu pedido").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cerrar") { dismiss() } } }
        }
    }
}
