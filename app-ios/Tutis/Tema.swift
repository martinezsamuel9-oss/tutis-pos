import SwiftUI
import UIKit

// Colores de la marca (los de la web de Tuti's), con su versión de modo oscuro.
extension Color {
    static func dinamico(_ claro: UInt32, _ oscuro: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: oscuro) : UIColor(hex: claro) })
    }
    static let papel = dinamico(0xFAF7F5, 0x140C11)
    static let superficie = dinamico(0xFFFFFF, 0x20151B)
    static let hundido = dinamico(0xF2ECEA, 0x2A1C24)
    static let rubor = dinamico(0xFFE9F4, 0x3A1A2C)
    static let tinta = dinamico(0x2B1622, 0xFAEFF4)
    static let tinta2 = dinamico(0x6F5A66, 0xC6B0BC)
    static let linea = dinamico(0xE9DFE3, 0x392630)
    static let magenta = dinamico(0xED1C8E, 0xFF4FA8)
    static let magentaHondo = dinamico(0xB80E68, 0xFF7DBE)
    static let sobreMagenta = dinamico(0xFFFFFF, 0x2B0618)
    static let verde = dinamico(0x1E7A50, 0x7FD3A6)
    static let verdeFondo = dinamico(0xE2F3EA, 0x173327)
    static let rojo = dinamico(0xB3261E, 0xFF8A80)
    static let rojoFondo = dinamico(0xFBE4E2, 0x3B1A18)
    init(hex: UInt32) { self.init(UIColor(hex: hex)) }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

// Tipografía del sistema (SF Pro): títulos pesados y apretados, como las apps de cafetería.
extension Font {
    static func titular(_ size: CGFloat = 34) -> Font { .system(size: size, weight: .bold, design: .default) }
    static func display(_ size: CGFloat, _ peso: Font.Weight = .semibold) -> Font { .system(size: size, weight: peso) }
}

// Las fotos van como archivos dentro de la app (carpeta Fotos).
struct Foto: View {
    let nombre: String
    var modo: ContentMode = .fill
    var body: some View {
        if let img = UIImage(named: nombre + ".jpg") ?? UIImage(named: nombre) {
            Image(uiImage: img).resizable().aspectRatio(contentMode: modo)
        } else {
            Rectangle().fill(Color.rubor)
        }
    }
}

struct BotonPildora: ButtonStyle {
    var principal = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.display(17))
            .padding(.horizontal, 24).frame(minHeight: 50)
            .foregroundStyle(principal ? Color.sobreMagenta : Color.tinta)
            .background(principal ? AnyShapeStyle(Color.magenta) : AnyShapeStyle(Color.superficie), in: Capsule())
            .overlay(Capsule().stroke(principal ? Color.clear : Color.linea, lineWidth: 1.5))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct Tarjeta<Contenido: View>: View {
    @ViewBuilder var contenido: Contenido
    var body: some View {
        VStack(alignment: .leading, spacing: 12) { contenido }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.superficie, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .shadow(color: .black.opacity(0.06), radius: 10, y: 3)
    }
}

struct Etiqueta: View {
    let texto: String
    var body: some View {
        Text(texto.uppercased()).font(.system(size: 12, weight: .bold)).tracking(1.4).foregroundStyle(Color.tinta2)
    }
}

func lempiras(_ v: Double) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal; f.minimumFractionDigits = 2; f.maximumFractionDigits = 2
    f.locale = Locale(identifier: "es_HN")
    return "L " + (f.string(from: NSNumber(value: v)) ?? String(format: "%.2f", v))
}
