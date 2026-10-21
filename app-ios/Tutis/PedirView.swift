import SwiftUI
import MapKit

struct PedirView: View {
    @Environment(Estado.self) private var estado
    @State private var lugares: [MKMapItem] = []
    @State private var camara: MapCameraPosition = .automatic

    // Horario de mall de ejemplo: 10:00 a 21:00.
    private var abierta: Bool { let h = Calendar.current.component(.hour, from: Date()); return h >= 10 && h < 21 }

    var body: some View {
        @Bindable var estado = estado
        ScrollView {
            VStack(spacing: 0) {
                Picker("Cómo lo quieres", selection: $estado.recoger) {
                    Text("Recoger").tag(true); Text("Domicilio").tag(false)
                }.pickerStyle(.segmented).padding(.horizontal, 40).padding(.vertical, 12)

                if estado.recoger { recoger } else { domicilio }
            }
        }
        .background(Color.papel)
        .navigationTitle("Pedir").navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: Tienda.self) { _ in MenuView() }
        .task { await buscarTiendas() }
    }

    private var recoger: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Mapa de Apple con las tiendas de Tuti's que encuentre Apple Maps.
            Map(position: $camara) {
                ForEach(lugares, id: \.self) { l in
                    Annotation(l.name ?? "Tuti's", coordinate: l.placemark.coordinate) {
                        Image(systemName: "cup.and.saucer.fill").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                            .frame(width: 32, height: 32).background(Color.magenta, in: Circle())
                            .overlay(Circle().stroke(.white, lineWidth: 2))
                    }
                }
                UserAnnotation()
            }
            .frame(height: 260)
            .overlay { if lugares.isEmpty { Text("Buscando tiendas en el mapa…").font(.system(size: 14)).foregroundStyle(Color.tinta2).padding(10).background(.thinMaterial, in: Capsule()) } }

            ForEach(Catalogo.tiendas) { t in
                NavigationLink(value: t) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(abierta ? "Abierto · hasta 9 pm" : "Cerrado · abre 10 am")
                                .font(.system(size: 13, weight: .bold)).padding(.horizontal, 10).padding(.vertical, 3)
                                .foregroundStyle(abierta ? Color.verde : Color.rojo)
                                .background(abierta ? Color.verdeFondo : Color.rojoFondo, in: RoundedRectangle(cornerRadius: 8))
                            Text(t.nombre.replacingOccurrences(of: "Tuti's ", with: "")).font(.display(22)).foregroundStyle(Color.tinta)
                            Text(t.lugar).foregroundStyle(Color.tinta2)
                            Text("Listo en \(t.minutos) min").font(.system(size: 14)).foregroundStyle(Color.tinta2)
                        }
                        Spacer()
                        Image(systemName: "info.circle").font(.system(size: 24, weight: .light)).foregroundStyle(Color.tinta2)
                    }
                    .padding(.vertical, 18).padding(.horizontal, 20).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .simultaneousGesture(TapGesture().onEnded { estado.tienda = t })
                Divider().padding(.leading, 20)
            }
            Text("Horario de ejemplo. Los pines salen de Apple Maps; si una tienda no aparece, hay que darla de alta en Apple Business Connect.")
                .font(.system(size: 13)).foregroundStyle(Color.tinta2).padding(20)
        }
    }

    private var domicilio: some View {
        VStack(spacing: 18) {
            ZStack(alignment: .bottom) {
                LinearGradient(colors: [Color.magentaHondo, Color.magenta], startPoint: .top, endPoint: .bottom).frame(height: 280)
                Ellipse().fill(Color.papel).frame(width: 640, height: 260).offset(y: 160)
                Foto(nombre: "vainilla").frame(width: 210, height: 220).clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
                    .shadow(color: .black.opacity(0.2), radius: 16, y: 8).padding(.bottom, 10)
            }.clipped()
            Text("Hoy se antoja a domicilio").font(.titular(30)).multilineTextAlignment(.center)
            NavigationLink(value: estado.tienda) { Text("Empezar") }.buttonStyle(BotonPildora())
            Text("Envío L 50 de ejemplo. Falta decidir zonas y si entregan repartidores propios o PedidosYa/Hugo, y hasta qué distancia llega sin derretirse.")
                .font(.system(size: 14)).foregroundStyle(Color.tinta2).multilineTextAlignment(.center).padding(.horizontal, 30)
        }
    }

    private func buscarTiendas() async {
        let pedido = MKLocalSearch.Request()
        pedido.naturalLanguageQuery = "Tuti's Frozen Yogurt"
        pedido.region = MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: 14.8, longitude: -87.2),
                                           span: MKCoordinateSpan(latitudeDelta: 4, longitudeDelta: 5))
        if let r = try? await MKLocalSearch(request: pedido).start() {
            lugares = r.mapItems.filter { ($0.name ?? "").localizedCaseInsensitiveContains("tuti") }
        }
    }
}

struct MenuView: View {
    @Environment(Estado.self) private var estado
    @State private var categoria = "tazas"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Etiqueta(texto: estado.recoger ? "Recoger en" : "Domicilio desde")
                        Text(estado.tienda.nombre).font(.display(17)).foregroundStyle(Color.tinta)
                    }
                    Spacer()
                    Text("\(estado.tienda.minutos) min").font(.system(size: 14)).foregroundStyle(Color.tinta2)
                }.padding(16).background(Color.superficie, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

                LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                    ForEach(Catalogo.categorias) { c in
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
                    ForEach(Array(Catalogo.tamanos.enumerated()), id: \.offset) { i, t in
                        NavigationLink { TazaView(tamanoInicial: t) } label: {
                            fila(nombre: "Taza \(t.nombre.lowercased()) · \(t.oz) oz", detalle: "Hasta 3 sabores y \(t.toppings) toppings", precio: t.precio, foto: ["vainilla", "fresa", "taro"][i])
                        }.buttonStyle(.plain)
                    }
                    Text("Precios de ejemplo. Hoy la taza se cobra por peso; para la app hacen falta tamaños con precio fijo.")
                        .font(.system(size: 13)).foregroundStyle(Color.tinta2).padding(12).background(Color.hundido, in: RoundedRectangle(cornerRadius: 14))
                } else {
                    ForEach(Catalogo.productos.filter { $0.categoria == categoria }) { p in
                        Button { estado.agregar(LineaPedido(nombre: p.nombre, precio: p.precio, foto: p.foto, detalle: "", cantidad: 1)) } label: {
                            fila(nombre: p.nombre, detalle: p.detalle, precio: p.precio, foto: p.foto)
                        }.buttonStyle(.plain)
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
