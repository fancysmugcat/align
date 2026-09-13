import SwiftUI

/// Colors, spacing and type styles taken from the ALIGN design mockups.
enum Theme {
    // Brand
    static let green      = Color(hex: 0x1B6B37)   // headings, logo
    static let greenSoft  = Color(hex: 0x9CCBAA)   // filled pills, good arc
    static let greenPale  = Color(hex: 0xCDE6D5)

    // Surfaces
    static let background = Color(hex: 0xFFFFFF)
    static let card       = Color(hex: 0xEBEBEB)
    static let cardInner  = Color(hex: 0xF7F7F7)
    static let track      = Color(hex: 0xBDBDBD)
    static let silhouette = Color(hex: 0xC7C7C7)
    static let hairline   = Color(hex: 0xD6D6D6)

    // Posture zones
    static let zoneGood   = Color(hex: 0x5FB37A)
    static let zoneFair   = Color(hex: 0xD9CE4A)
    static let zonePoor   = Color(hex: 0xE39B3C)
    static let zoneBad    = Color(hex: 0xE05B54)

    static let corner: CGFloat = 22
    static let cardPadding: CGFloat = 18
    static let gutter: CGFloat = 16
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red:   Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue:  Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

extension Font {
    static func alignTitle(_ size: CGFloat = 20) -> Font { .system(size: size, weight: .bold, design: .rounded) }
    static func alignBody(_ size: CGFloat = 14) -> Font { .system(size: size, weight: .medium, design: .rounded) }
    static func alignCaption(_ size: CGFloat = 11) -> Font { .system(size: size, weight: .medium, design: .rounded) }
}
