import SwiftUI

struct InicioView: View {
    @Environment(Estado.self) private var estado
    var irA: (Pestana) -> Void

    private var saludo: String {
        let h = Calendar.current.component(.hour, from: Date())
        return h < 12 ? "Buenos días" : h < 18 ? "Buenas tardes" : "Buenas noches"
    }
    private let favoritos = ["pistacho", "red-velvet", "mango", "salted-caramel", "cheesecake-de-fresa", "cookies-and-cream"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                Text(estado.nombre.isEmpty ? "\(saludo). ¿Qué se te antoja hoy?" : "\(saludo), \(estado.nombre). ¿Qué se te antoja hoy?")
                    .font(.titular(34)).tracking(-0.6).foregroundStyle(Color.tinta).padding(.top, 8)

                HStack(spacing: 22) {
                    Button { irA(.puntos) } label: { Label("Mi carnet", systemImage: "qrcode") }
                    Button { irA(.pedir) } label: { Label("Tiendas", systemImage: "mappin.and.ellipse") }
                    Spacer()
                    Button { if estado.fase != .listo { estado.pidiendoLogin = true } else { irA(.puntos) } } label: {
                        Group { if estado.nombre.isEmpty { Image(systemName: "person") } else { Text(String(estado.nombre.prefix(1))) } }
                            .font(.display(17, .bold)).foregroundStyle(Color.magentaHondo)
                            .frame(width: 40, height: 40).overlay(Circle().stroke(Color.linea, lineWidth: 1.5))
                    }
                }
                .font(.display(17, .medium)).foregroundStyle(Color.tinta).buttonStyle(.plain)
                .padding(.bottom, 14).overlay(alignment: .bottom) { Rectangle().fill(Color.linea).frame(height: 1) }

                destacado
                tarjetaPuntos

                VStack(alignment: .leading, spacing: 14) {
                    HStack { Text("Sabores favoritos").font(.display(23, .bold)); Spacer()
                        Button("Ver menú") { irA(.pedir) }.font(.display(16)).foregroundStyle(Color.magentaHondo) }
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 14) {
                            ForEach(favoritos, id: \.self) { id in
                                NavigationLink { TazaView(saborInicial: id) } label: {
                                    VStack(alignment: .leading, spacing: 0) {
                                        Foto(nombre: id).frame(width: 236, height: 189).clipped()
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(Catalogo.sabor(id)?.nombre ?? id).font(.display(17)).foregroundStyle(Color.tinta)
                                            Text("Pídelo en tu taza").font(.system(size: 14)).foregroundStyle(Color.tinta2)
                                        }.padding(14)
                                    }
                                    .background(Color.superficie).clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                                    .shadow(color: .black.opacity(0.06), radius: 10, y: 3)
                                }.buttonStyle(.plain)
                            }
                        }.padding(.horizontal, 20).padding(.vertical, 6).scrollTargetLayout()
                    }.scrollTargetBehavior(.viewAligned).padding(.horizontal, -20)
                }

                Button { irA(.regalar) } label: {
                    VStack(alignment: .leading, spacing: 14) {
                        Etiqueta(texto: "Tarjetas de regalo")
                        Text("Regala un antojo").font(.display(23, .bold)).foregroundStyle(Color.tinta)
                        TarjetaRegaloVista(diseno: Catalogo.regalos[0])
                        Text("Elegir tarjeta").font(.display(16)).foregroundStyle(Color.magentaHondo)
                    }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.superficie, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                }.buttonStyle(.plain).shadow(color: .black.opacity(0.06), radius: 10, y: 3)
            }
            .padding(.horizontal, 20).padding(.bottom, 30)
        }
        .background(Color.papel)
        .toolbar(.hidden, for: .navigationBar)
    }

    private var destacado: some View {
        VStack(alignment: .leading, spacing: 0) {
            Foto(nombre: "p-taro").frame(height: 210).frame(maxWidth: .infinity).clipped()
            VStack(alignment: .leading, spacing: 10) {
                Etiqueta(texto: "Nuevo en tiendas")
                Text("El Taro llegó para quedarse").font(.display(23, .bold)).foregroundStyle(Color.tinta)
                Text("Cremoso, suave y un poquito dulce. Pruébalo con Oreo y leche condensada, la combinación favorita de la casa.")
                    .font(.system(size: 16)).foregroundStyle(Color.tinta2).fixedSize(horizontal: false, vertical: true)
                NavigationLink { TazaView(saborInicial: "taro") } label: { Text("Pídelo ya") }.buttonStyle(BotonPildora())
            }.padding(20)
        }
        .background(Color.superficie).clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .shadow(color: .black.opacity(0.06), radius: 10, y: 3)
    }

    @ViewBuilder private var tarjetaPuntos: some View {
        if estado.fase == .listo {
            Button { irA(.puntos) } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 6) {
                        Etiqueta(texto: "Tuti's Puntos")
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("\(estado.puntos)").font(.system(size: 38, weight: .heavy)).monospacedDigit().foregroundStyle(Color.tinta)
                            Text("= \(lempiras(Double(estado.puntos)))").font(.system(size: 15)).foregroundStyle(Color.tinta2)
                        }
                        ProgressView(value: min(1, Double(estado.puntos) / 100)).tint(Color.magenta)
                    }
                    Spacer(minLength: 16)
                    Image(systemName: "chevron.right").font(.system(size: 14, weight: .bold)).frame(width: 34, height: 34).background(Color.hundido, in: Circle())
                }.padding(18).background(Color.superficie, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            }.buttonStyle(.plain).foregroundStyle(Color.tinta).shadow(color: .black.opacity(0.06), radius: 10, y: 3)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                Etiqueta(texto: "Tuti's Puntos")
                Text("Junta puntos con cada compra").font(.display(21, .bold)).foregroundStyle(Color.tinta)
                Text("1 punto por cada L \(Int(estado.montoPorPunto)); cada punto vale L 1. Si ya tienes carnet de la caja, tus puntos se vienen contigo.")
                    .font(.system(size: 15)).foregroundStyle(Color.tinta2).fixedSize(horizontal: false, vertical: true)
                Button("Únete o entra") { estado.pidiendoLogin = true }.buttonStyle(BotonPildora())
            }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.superficie, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .shadow(color: .black.opacity(0.06), radius: 10, y: 3)
        }
    }
}
