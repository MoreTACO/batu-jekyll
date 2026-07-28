import SwiftUI

/// Nautical palette. These values are mirrored in `speedo/app.css` — change both together.
struct Palette {
    let bg: Color
    let panel: Color
    let line: Color
    let accent: Color
    let trim: Color
    let trimDim: Color
    let text: Color
    let textDim: Color
    let warn: Color
    let ok: Color

    /// Deep-water chart table: navy ground, brass trim, seafoam needle.
    static let day = Palette(
        bg:      Color(hex: 0x071A2B),
        panel:   Color(hex: 0x0E2C46),
        line:    Color(hex: 0x1B4468),
        accent:  Color(hex: 0x5FE3C0),
        trim:    Color(hex: 0xC8A34A),
        trimDim: Color(hex: 0x6E5A2C),
        text:    Color(hex: 0xEAE0C8),
        textDim: Color(hex: 0x8FA3B5),
        warn:    Color(hex: 0xE4483D),
        ok:      Color(hex: 0x2FBF71)
    )

    /// Red on black only, so the helm keeps its night vision.
    static let night = Palette(
        bg:      Color(hex: 0x000000),
        panel:   Color(hex: 0x140000),
        line:    Color(hex: 0x3A0B08),
        accent:  Color(hex: 0xFF4438),
        trim:    Color(hex: 0xB32B22),
        trimDim: Color(hex: 0x5C1712),
        text:    Color(hex: 0xFF6A5E),
        textDim: Color(hex: 0x8E2A22),
        warn:    Color(hex: 0xFF4438),
        ok:      Color(hex: 0xB32B22)
    )

    static func current(night: Bool) -> Palette { night ? .night : .day }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red:   Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >>  8) & 0xFF) / 255,
            blue:  Double( hex        & 0xFF) / 255,
            opacity: 1
        )
    }
}
