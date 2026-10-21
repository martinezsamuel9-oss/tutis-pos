import SwiftUI

@main
struct TutisApp: App {
    @State private var estado = Estado()
    var body: some Scene {
        WindowGroup {
            Raiz().environment(estado).tint(Color.magenta)
        }
    }
}

enum Pestana: Hashable { case inicio, pedir, regalar, puntos }

struct Raiz: View {
    @Environment(Estado.self) private var estado
    @State private var pestana: Pestana = .inicio
    @State private var bienvenida = true
    @State private var verPedido = false
    @State private var verSeguimiento = false

    var body: some View {
        ZStack {
            pestanas
            if bienvenida { Bienvenida().transition(.opacity).zIndex(2) }
            if let t = estado.aviso {
                VStack {
                    Text(t).font(.system(size: 15, weight: .semibold)).padding(.horizontal, 18).padding(.vertical, 10)
                        .background(.regularMaterial, in: Capsule()).shadow(radius: 8, y: 4)
                    Spacer()
                }.padding(.top, 8).transition(.move(edge: .top).combined(with: .opacity)).zIndex(3)
            }
        }
        .task {
            try? await Task.sleep(for: .seconds(1.4))
            withAnimation(.easeOut(duration: 0.45)) { bienvenida = false }
        }
        .sheet(isPresented: $verPedido) {
            CarritoView(alConfirmar: { verPedido = false; DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { verSeguimiento = true } })
                .environment(estado)
        }
        .sheet(isPresented: $verSeguimiento) { SeguimientoView().environment(estado).presentationDetents([.large]) }
    }

    @ViewBuilder private var pestanas: some View {
        let tabs = TabView(selection: $pestana) {
            Tab("Inicio", systemImage: "house.fill", value: .inicio) { NavigationStack { InicioView(irA: { pestana = $0 }) } }
            Tab("Pedir", systemImage: "cup.and.saucer.fill", value: .pedir) { NavigationStack { PedirView() } }
            Tab("Regalar", systemImage: "gift.fill", value: .regalar) { NavigationStack { RegalarView() } }
            Tab("Puntos", systemImage: "star.fill", value: .puntos) { NavigationStack { PuntosView() } }
        }
        if #available(iOS 26.0, *) {
            // La barra del pedido va pegada a la barra de pestañas de vidrio, como un reproductor mini.
            tabs.tabViewBottomAccessory { barraPedido }
        } else {
            tabs.safeAreaInset(edge: .bottom) { barraPedido.padding(.horizontal, 16).padding(.bottom, 4) }
        }
    }

    @ViewBuilder private var barraPedido: some View {
        if estado.piezas > 0 {
            Button { verPedido = true } label: {
                HStack(spacing: 12) {
                    Text("\(estado.piezas)").font(.system(size: 15, weight: .bold)).frame(width: 30, height: 30)
                        .background(Color.magenta, in: RoundedRectangle(cornerRadius: 9)).foregroundStyle(Color.sobreMagenta)
                    Text("Ver pedido").font(.display(16))
                    Spacer()
                    Text(lempiras(estado.subtotal)).font(.system(size: 15, weight: .semibold)).monospacedDigit()
                }.padding(.horizontal, 14).frame(maxWidth: .infinity, minHeight: 48)
            }.buttonStyle(.plain)
        } else if let p = estado.pedido, p.paso < 3 {
            Button { verSeguimiento = true } label: {
                HStack(spacing: 12) {
                    Image(systemName: "bag.fill").foregroundStyle(Color.magenta)
                    Text("Pedido #\(p.folio) · \(SeguimientoView.etapa(p).titulo)").font(.display(15))
                    Spacer(); Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold))
                }.padding(.horizontal, 14).frame(maxWidth: .infinity, minHeight: 48)
            }.buttonStyle(.plain)
        }
    }
}

struct Bienvenida: View {
    var body: some View {
        ZStack {
            Foto(nombre: "splash").ignoresSafeArea()
            Circle().fill(.white).frame(width: 136, height: 136).shadow(color: .black.opacity(0.18), radius: 16, y: 8)
                .overlay(Foto(nombre: "logo", modo: .fit).padding(20))
        }
    }
}
