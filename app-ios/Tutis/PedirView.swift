import SwiftUI
import MapKit

struct PedirView: View {
    @Environment(Estado.self) private var estado
    @State private var ubicador = Ubicador()
    @State private var camara: MapCameraPosition = .region(Self.honduras)
    @State private var seleccion: String?
    @State private var encuadrado = false

    private static let honduras = MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: 14.8, longitude: -86.8),
                                                     span: MKCoordinateSpan(latitudeDelta: 4.5, longitudeDelta: 6))

    /// Las tiendas, las más cercanas primero cuando se sabe dónde está el cliente.
    private var tiendas: [Tienda] {
        guard ubicador.ubicacion != nil else { return estado.tiendas }
        return estado.tiendas.sorted { (ubicador.distancia(a: $0) ?? .infinity) < (ubicador.distancia(a: $1) ?? .infinity) }
    }
    private var enMapa: [Tienda] { estado.tiendas.filter { $0.coordenada != nil } }

    var body: some View {
        @Bindable var estado = estado
        VStack(spacing: 0) {
            Picker("Cómo lo quieres", selection: $estado.recoger) {
                Text("Recoger").tag(true); Text("Domicilio").tag(false)
            }.pickerStyle(.segmented).padding(.horizontal, 40).padding(.vertical, 12)

            if let e = estado.errorMenu {
                ScrollView {
                    ContentUnavailableView { Label("Sin conexión", systemImage: "wifi.slash") } description: { Text(e) } actions: {
                        Button("Reintentar") { Task { await estado.cargar() } }.buttonStyle(BotonPildora())
                    }
                }.refreshable { await estado.cargar() }
            } else if estado.recoger || estado.aceptaDomicilio { recoger } else { ScrollView { domicilio } }
        }
        .background(Color.papel)
        .navigationTitle("Pedir").navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: Tienda.self) { _ in MenuView() }
        .onAppear { ubicador.pedir(); seleccion = estado.tiendaId; encuadrar() }
        .onChange(of: estado.tiendas) { encuadrado = false; encuadrar() }
        .onChange(of: seleccion) { _, id in
            guard let id, let t = estado.tiendas.first(where: { $0.id == id }) else { return }
            estado.tiendaId = id
            if let c = t.coordenada {
                withAnimation(.easeInOut(duration: 0.6)) {
                    camara = .region(MKCoordinateRegion(center: c, span: MKCoordinateSpan(latitudeDelta: 0.012, longitudeDelta: 0.012)))
                }
            }
        }
    }

    // Encuadra todas las tiendas que tienen ubicación (una sola: de cerca).
    private func encuadrar() {
        guard !encuadrado, !enMapa.isEmpty else { return }
        encuadrado = true
        let lats = enMapa.compactMap(\.lat), lngs = enMapa.compactMap(\.lng)
        let centro = CLLocationCoordinate2D(latitude: (lats.min()! + lats.max()!) / 2, longitude: (lngs.min()! + lngs.max()!) / 2)
        let span = MKCoordinateSpan(latitudeDelta: max(0.015, (lats.max()! - lats.min()!) * 1.6),
                                    longitudeDelta: max(0.015, (lngs.max()! - lngs.min()!) * 1.6))
        camara = .region(MKCoordinateRegion(center: centro, span: span))
    }

    private var recoger: some View {
        VStack(spacing: 0) {
            Map(position: $camara, selection: $seleccion) {
                UserAnnotation()
                ForEach(enMapa) { t in
                    Annotation(t.nombreCorto, coordinate: t.coordenada!, anchor: .bottom) {
                        pin(t, elegida: seleccion == t.id)
                    }.tag(t.id)
                }
            }
            .mapControls { MapUserLocationButton(); MapCompass() }
            .frame(height: 280)
            .overlay(alignment: .bottom) {
                if !estado.tiendas.isEmpty && enMapa.isEmpty {
                    Text("Pronto verás las tiendas en el mapa").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.tinta)
                        .padding(.horizontal, 14).padding(.vertical, 8).background(.regularMaterial, in: Capsule()).padding(12)
                }
            }

            ScrollViewReader { lector in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if estado.tiendas.isEmpty { ProgressView().frame(maxWidth: .infinity).padding(30) }
                        TimelineView(.everyMinute) { reloj in
                            VStack(spacing: 0) {
                                ForEach(tiendas) { t in
                                    fila(t, ahora: reloj.date).id(t.id)
                                    Divider().padding(.leading, 20)
                                }
                            }
                        }
                        if ubicador.permiso == .denied {
                            Text("Para ver qué tienda te queda más cerca, permite la ubicación en Ajustes › Tuti's.")
                                .font(.system(size: 13)).foregroundStyle(Color.tinta2).padding(20)
                        }
                    }
                }
                .refreshable { await estado.cargar() }
                .onChange(of: seleccion) { _, id in if let id { withAnimation { lector.scrollTo(id, anchor: .top) } } }
            }
        }
    }

    private func pin(_ t: Tienda, elegida: Bool) -> some View {
        let lado: CGFloat = elegida ? 44 : 34
        return VStack(spacing: 0) {
            Image("helado").resizable().renderingMode(.template).scaledToFit().padding(elegida ? 9 : 7)
                .foregroundStyle(Color.sobreMagenta)
                .frame(width: lado, height: lado)
                .background(t.estado().abierta || t.horario == nil ? Color.magenta : Color.tinta2, in: Circle())
                .overlay(Circle().stroke(.white, lineWidth: 2.5))
                .shadow(color: .black.opacity(0.25), radius: 4, y: 2)
            Image(systemName: "triangle.fill").font(.system(size: 9)).rotationEffect(.degrees(180))
                .foregroundStyle(t.estado().abierta || t.horario == nil ? Color.magenta : Color.tinta2).offset(y: -3)
        }
        .animation(.spring(duration: 0.3), value: elegida)
        .accessibilityLabel("\(t.nombre), \(t.estado().texto)")
    }

    private func fila(_ t: Tienda, ahora: Date) -> some View {
        let elegida = estado.tiendaId == t.id
        let est = t.estado(ahora)
        let horas = t.horasParaRecoger(ahora)
        return VStack(alignment: .leading, spacing: 14) {
            Button { seleccion = t.id; estado.tiendaId = t.id } label: {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(est.texto)
                            .font(.system(size: 13, weight: .bold)).padding(.horizontal, 10).padding(.vertical, 3)
                            .foregroundStyle(est.color).background(est.fondo, in: RoundedRectangle(cornerRadius: 8))
                        Text(t.nombreCorto).font(.display(22)).foregroundStyle(Color.tinta)
                        if !t.lugar.isEmpty { Text(t.lugar).foregroundStyle(Color.tinta2) }
                        HStack(spacing: 6) {
                            if let d = ubicador.distancia(a: t) { Text(distanciaBonita(d)); Text("·") }
                            Text("Listo en unos \(t.minutos) min")
                        }.font(.system(size: 14)).foregroundStyle(Color.tinta2)
                    }
                    Spacer()
                    Image(systemName: elegida ? "checkmark.circle.fill" : "circle").font(.system(size: 24))
                        .foregroundStyle(elegida ? Color.magenta : Color.linea)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain)

            if elegida {
                HStack(spacing: 10) {
                    NavigationLink(value: t) {
                        Text(horas.isEmpty ? "Cerrado por hoy" : est.abierta || t.horario == nil ? "Pedir aquí" : "Programar").lineLimit(1).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(BotonPildora()).disabled(horas.isEmpty).opacity(horas.isEmpty ? 0.5 : 1)
                    if t.coordenada != nil { BotonComoLlegar(tienda: t) }
                    if let tel = t.telefono, let u = URL(string: "tel:" + tel.filter { $0.isNumber || $0 == "+" }) {
                        Link(destination: u) {
                            Image(systemName: "phone.fill").font(.system(size: 17)).frame(width: 50, height: 50)
                                .foregroundStyle(Color.tinta).background(Color.superficie, in: Circle())
                                .overlay(Circle().stroke(Color.linea, lineWidth: 1.5))
                        }.accessibilityLabel("Llamar a la tienda")
                    }
                }
                if !t.horarioSemana.isEmpty {
                    DisclosureGroup {
                        VStack(spacing: 6) {
                            ForEach(t.horarioSemana, id: \.dia) { d in
                                HStack { Text(d.dia); Spacer(); Text(d.texto).monospacedDigit() }
                                    .font(.system(size: 14, weight: d.dia == Tienda.nombresDia[hoyClave(t, ahora)] ? .bold : .regular))
                            }
                        }.padding(.top, 8)
                    } label: { Text("Horario").font(.display(15)) }
                    .tint(Color.tinta)
                }
            }
        }
        .padding(.vertical, 18).padding(.horizontal, 20)
        .background(elegida ? Color.rubor.opacity(0.5) : Color.clear)
        .animation(.snappy, value: elegida)
    }

    private func hoyClave(_ t: Tienda, _ ahora: Date) -> String {
        var c = Calendar(identifier: .gregorian); c.timeZone = t.zona
        return Tienda.dias[c.component(.weekday, from: ahora) - 1]
    }

    private var domicilio: some View {
        VStack(spacing: 18) {
            ZStack(alignment: .bottom) {
                LinearGradient(colors: [Color.magentaHondo, Color.magenta], startPoint: .top, endPoint: .bottom).frame(height: 280)
                Ellipse().fill(Color.papel).frame(width: 640, height: 260).offset(y: 160)
                Foto(nombre: "vainilla").frame(width: 210, height: 220).clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
                    .shadow(color: .black.opacity(0.2), radius: 16, y: 8).padding(.bottom, 10)
            }.clipped()
            Text("A domicilio, muy pronto").font(.titular(30)).multilineTextAlignment(.center)
            Text("Por ahora los pedidos son para recoger en tienda. Estamos definiendo las zonas de entrega para que tu yogurt llegue perfecto.")
                .font(.system(size: 15)).foregroundStyle(Color.tinta2).multilineTextAlignment(.center).padding(.horizontal, 30)
        }
    }
}

struct MenuView: View {
    @Environment(Estado.self) private var estado
    @State private var categoria = "tazas"

    private var categorias: [(id: String, nombre: String, detalle: String, foto: String)] {
        [("tazas", "Tazas de yogurt", "Arma la tuya", "taro")] +
        estado.familias.map { ($0, $0 == "Toppings" ? "Toppings para llevar" : $0, $0 == "Temporada" ? "Por tiempo limitado" : "En porción", Catalogo.fotoFamilia($0)) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let t = estado.tienda {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Etiqueta(texto: "Recoger en")
                            Text(t.nombre).font(.display(17)).foregroundStyle(Color.tinta)
                        }
                        Spacer()
                        Text("Unos \(t.minutos) min").font(.system(size: 14)).foregroundStyle(Color.tinta2)
                    }.padding(16).background(Color.superficie, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }

                LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                    ForEach(categorias, id: \.id) { c in
                        Button { withAnimation { categoria = c.id } } label: {
                            ZStack(alignment: .bottomLeading) {
                                Foto(nombre: c.foto).frame(height: 176).frame(maxWidth: .infinity).clipped()
                                LinearGradient(colors: [.clear, Color(hex: 0x2B1622).opacity(0.85)], startPoint: .center, endPoint: .bottom)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(c.nombre).font(.display(17, .bold))
                                    Text(c.detalle).font(.system(size: 13)).opacity(0.9)
                                }.foregroundStyle(.white).padding(12)
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(categoria == c.id ? Color.magenta : .clear, lineWidth: 3))
                        }.buttonStyle(.plain)
                    }
                }

                if categoria == "tazas" {
                    ForEach(Array(estado.tamanos.enumerated()), id: \.offset) { i, t in
                        NavigationLink { TazaView(tamanoInicial: t) } label: {
                            fila(nombre: "Taza \(t.nombre.lowercased()) · \(t.oz) oz", detalle: "Hasta 3 sabores y \(t.toppings) toppings", precio: t.precio, foto: ["vainilla", "fresa", "taro"][i % 3])
                        }.buttonStyle(.plain)
                    }
                    Text("Precios de ejemplo. Hoy la taza se cobra por peso; para la app hacen falta tamaños con precio fijo.")
                        .font(.system(size: 13)).foregroundStyle(Color.tinta2).padding(12).background(Color.hundido, in: RoundedRectangle(cornerRadius: 14))
                } else {
                    ForEach(estado.productos.filter { $0.tienda == estado.tienda?.id && $0.familia == categoria }) { p in
                        Button {
                            estado.agregar(LineaPedido(nombre: p.nombre, precio: p.precio, foto: Catalogo.fotoProducto(p.nombre), detalle: "", cantidad: 1, item: .producto(id: p.id)))
                        } label: { fila(nombre: p.nombre, detalle: p.familia, precio: p.precio, foto: Catalogo.fotoProducto(p.nombre)) }.buttonStyle(.plain)
                    }
                }
            }.padding(20)
        }
        .background(Color.papel)
        .navigationTitle("Menú").navigationBarTitleDisplayMode(.inline)
    }

    private func fila(nombre: String, detalle: String, precio: Double, foto: String?) -> some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(nombre).font(.display(18)).foregroundStyle(Color.tinta)
                Text(detalle).font(.system(size: 14)).foregroundStyle(Color.tinta2)
                Text(lempiras(precio)).font(.system(size: 16, weight: .bold)).monospacedDigit().foregroundStyle(Color.tinta)
            }
            Spacer()
            ZStack(alignment: .bottomTrailing) {
                Group {
                    if let f = foto { Foto(nombre: f) } else {
                        ZStack { Color.rubor; Image(systemName: "takeoutbag.and.cup.and.straw.fill").font(.system(size: 34)).foregroundStyle(Color.magenta) }
                    }
                }.frame(width: 96, height: 96).clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                Image(systemName: "plus").font(.system(size: 15, weight: .bold)).foregroundStyle(Color.magentaHondo)
                    .frame(width: 30, height: 30).background(Color.superficie, in: Circle()).shadow(radius: 3).padding(6)
            }
        }
        .padding(.vertical, 8).contentShape(Rectangle())
    }
}
