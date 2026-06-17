import SwiftUI

/// Colours mirror the web dashboard palette so the two views feel like one app.
enum Theme {
    static let palette: [Color] = [
        Color(hex: 0x4ade80), Color(hex: 0x38bdf8), Color(hex: 0xf472b6),
        Color(hex: 0xfbbf24), Color(hex: 0xa78bfa), Color(hex: 0xfb7185),
        Color(hex: 0x34d399), Color(hex: 0x60a5fa)
    ]

    static let accent = Color(hex: 0x4ade80)
    static let muted = Color(hex: 0x8b97a6)
    static let cardBg = Color(hex: 0x161b22)
    static let panelBg = Color(hex: 0x0d1117)

    static func color(_ index: Int) -> Color { palette[index % palette.count] }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255,
            opacity: 1
        )
    }
}
