import SwiftUI

struct CarritoView: View {
    @Environment(Estado.self) private var estado
    @Environment(\.dismiss) private var dismiss
    var alConfirmar: () -> Void

    private let horas = [("ya", "Ya"), ("15:30", "3:30 pm"), ("16:00", "4:00 pm"), ("16:30", "4:30 pm"), ("17:00", "5:00 pm")]

    var body: some View {
        @Bindable var estado = estado
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if estado.carrito.isEmpty {
                        ContentUnavailableView("Tu pedido está vacío", systemImage: "cup.and.saucer", description: Text("Arma una taza o agrega una bebida."))
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

                    Tarjeta {
                        Picker("Cómo lo quieres", selection: $estado.recoger) { Text("Recoger").tag(true); Text("Domicilio").tag(false) }.pickerStyle(.segmented)
                        Picker(estado.recoger ? "Recoger en" : "Sale de", selection: $estado.tienda) {
                            ForEach(Catalogo.tiendas) { Text($0.nombre).tag($0) }
                        }
                        if estado.recoger {
                            Etiqueta(texto: "Hora")
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(horas, id: \.0) { v, t in
                                        Button { estado.hora = v } label: {
                                            Text(v == "ya" ? "Ya · \(estado.tienda.minutos) min" : t).font(.system(size: 15, weight: .semibold))
                                                .padding(.horizontal, 14).frame(minHeight: 44)
                                                .foregroundStyle(estado.hora == v ? Color.papel : Color.tinta)
                                                .background(estado.hora == v ? Color.tinta : Color.superficie, in: RoundedRectangle(cornerRadius: 14))
                                                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.linea, lineWidth: estado.hora == v ? 0 : 1.5))
                                        }.buttonStyle(.plain)
                                    }
                                }
                            }
                        } else {
                            Text("Envío L 50 de ejemplo: faltan las zonas y quién entrega.").font(.system(size: 14)).foregroundStyle(Color.tinta2)
                        }
                    }

                    Tarjeta {
                        fila("Subtotal", estado.subtotal, suave: true)
                        if estado.envio > 0 { fila("Envío", estado.envio, suave: true) }
                        fila("Total", estado.subtotal + estado.envio, grande: true)
                        Text("Ganas \(Int(((estado.subtotal + estado.envio) / Catalogo.montoPorPunto).rounded(.down))) puntos con este pedido").font(.system(size: 14)).foregroundStyle(Color.tinta2)
                        NavigationLink { PagarView(alConfirmar: alConfirmar) } label: { Text("Continuar").frame(maxWidth: .infinity) }
                            .buttonStyle(BotonPildora()).disabled(estado.carrito.isEmpty)
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
    HStack {
        Text(t); Spacer(); Text(lempiras(v)).monospacedDigit()
    }
    .font(grande ? .display(22, .bold) : .system(size: 16))
    .foregroundStyle(color ?? (suave ? Color.tinta2 : Color.tinta))
}

struct PagarView: View {
    @Environment(Estado.self) private var estado
    var alConfirmar: () -> Void

    var body: some View {
        @Bindable var estado = estado
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Tarjeta {
                    Etiqueta(texto: estado.recoger ? "Recoges en" : "Sale de")
                    Text(estado.tienda.nombre).font(.display(19))
                    Text("\(estado.tienda.lugar) · " + (estado.recoger ? (estado.hora == "ya" ? "listo en \(estado.tienda.minutos) min" : "a las \(estado.hora)") : "a domicilio"))
                        .foregroundStyle(Color.tinta2)
                }
                Text("Forma de pago").font(.display(18))
                opcion("Pagar al recoger", "Efectivo o tarjeta en la caja", activa: true)
                if let g = estado.misTarjetas.first { opcion("Tarjeta de regalo · \(lempiras(g.saldo))", "Fase 2: el saldo se descuenta como los puntos.", activa: false, deshabilitada: true) }
                opcion("Apple Pay o tarjeta en línea", "Fase 2 con BAC Credomatic.", activa: false, deshabilitada: true)
                Toggle(isOn: $estado.usarPuntos) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Usar mis puntos").font(.display(16))
                        Text("Tienes \(lempiras(Double(estado.puntos))) · cubren hasta la mitad").font(.system(size: 14)).foregroundStyle(Color.tinta2)
                    }
                }.padding(14).background(Color.superficie, in: RoundedRectangle(cornerRadius: 16)).tint(Color.magenta)

                Tarjeta {
                    ForEach(estado.carrito) { l in fila("\(l.cantidad) × \(l.nombre)", l.precio * Double(l.cantidad)) }
                    if estado.envio > 0 { fila("Envío", estado.envio, suave: true) }
                    if estado.descuento > 0 { fila("Puntos", -estado.descuento, color: Color.verde) }
                    fila("A pagar", estado.aPagar, grande: true)
                    Button { estado.confirmar(); alConfirmar() } label: { Text("Hacer pedido").frame(maxWidth: .infinity) }
                        .buttonStyle(BotonPildora()).sensoryFeedback(.success, trigger: estado.pedido?.folio)
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

    static func etapa(_ p: PedidoEnCurso) -> (titulo: String, detalle: String) {
        [("Recibido", "La tienda ya tiene tu pedido"), ("Preparando", "Estamos sirviendo tu taza"),
         (p.recoger ? "Listo para recoger" : "En camino", p.recoger ? "Pasa a la caja y di tu número" : "Va saliendo hacia ti"),
         ("Entregado", "Ganaste \(p.puntos) puntos")][p.paso]
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if let p = estado.pedido {
                    let e = Self.etapa(p)
                    VStack(spacing: 22) {
                        ZStack {
                            Circle().stroke(Color.linea, lineWidth: 10)
                            Circle().trim(from: 0, to: CGFloat(p.paso + 1) / 4).stroke(Color.magenta, style: StrokeStyle(lineWidth: 10, lineCap: .round))
                                .rotationEffect(.degrees(-90)).animation(.spring(duration: 0.6), value: p.paso)
                            Text("#\(p.folio)").font(.system(size: 30, weight: .heavy)).monospacedDigit()
                        }.frame(width: 144, height: 144).padding(.top, 10)
                        VStack(spacing: 6) {
                            Text(e.titulo).font(.titular(32)).contentTransition(.opacity)
                            Text(e.detalle).foregroundStyle(Color.tinta2)
                        }
                        if p.paso < 3 {
                            Button("Simular siguiente paso") { withAnimation { estado.avanzar() } }.buttonStyle(BotonPildora(principal: false))
                                .sensoryFeedback(.impact, trigger: p.paso)
                        } else {
                            Button("Listo") { dismiss() }.buttonStyle(BotonPildora())
                        }
                        Tarjeta {
                            Etiqueta(texto: p.recoger ? "Recoges en" : "Sale de")
                            Text(p.tienda.nombre).font(.display(18)); Text(p.tienda.lugar).foregroundStyle(Color.tinta2)
                        }
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Así le llega a la tienda").font(.display(18))
                            VStack(alignment: .leading, spacing: 8) {
                                HStack { Text("#\(p.folio)").font(.system(size: 26, weight: .heavy)); Spacer()
                                    Etiqueta(texto: (p.recoger ? "Para recoger" : "Domicilio") + " · " + (p.hora == "ya" ? "lo antes posible" : p.hora)) }
                                Text("\(estado.nombre) · carnet \(estado.codigo)")
                                ForEach(p.lineas) { l in
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("\(l.cantidad) × \(l.nombre)").font(.system(size: 16, weight: .semibold))
                                        if !l.detalle.isEmpty { Text(l.detalle).font(.system(size: 14)).foregroundStyle(Color.tinta2) }
                                    }
                                }
                                fila("Paga al recoger", p.total)
                            }
                            .padding(16).background(Color.superficie, in: RoundedRectangle(cornerRadius: 20))
                            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6, 4])).foregroundStyle(Color.linea))
                            Text("En la caja aparece en una pestaña \"Pedidos\" con aviso. Al entregarlo entra como venta normal: cierre, libro de ventas y puntos.")
                                .font(.system(size: 14)).foregroundStyle(Color.tinta2)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(20)
                }
            }
            .background(Color.papel)
            .navigationTitle("Tu pedido").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cerrar") { dismiss() } } }
        }
    }
}
