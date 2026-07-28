import SwiftUI

/// Rotating compass card: the rose turns under a fixed index mark, the way a real
/// card does, so the bearing you are making good sits under the mark at the top.
struct CompassRose: View {

    let course: Double?          // degrees, 0-359; nil when unknown
    let isMagnetic: Bool
    let palette: Palette

    var body: some View {
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height)
            let r = size / 2

            ZStack {
                Circle()
                    .fill(palette.panel)
                    .overlay(Circle().stroke(palette.trimDim, lineWidth: 1.5))

                ZStack {
                    ForEach(Array(stride(from: 0, to: 360, by: 30)), id: \.self) { deg in
                        let cardinal = deg % 90 == 0
                        Path { p in
                            let a = Double(deg - 90) * .pi / 180
                            p.move(to: CGPoint(x: r + cos(a) * r * 0.96, y: r + sin(a) * r * 0.96))
                            p.addLine(to: CGPoint(x: r + cos(a) * r * (cardinal ? 0.77 : 0.85),
                                                  y: r + sin(a) * r * (cardinal ? 0.77 : 0.85)))
                        }
                        .stroke(palette.trimDim, lineWidth: 1.5)
                    }

                    ForEach(Array(["N": 0, "E": 90, "S": 180, "W": 270]), id: \.key) { label, deg in
                        let a = Double(deg - 90) * .pi / 180
                        Text(label)
                            .font(.system(size: size * 0.115, weight: .semibold))
                            .foregroundStyle(label == "N" ? palette.trim : palette.textDim)
                            .position(x: r + cos(a) * r * 0.66, y: r + sin(a) * r * 0.66)
                    }
                }
                .rotationEffect(.degrees(-(course ?? 0)))
                .animation(.linear(duration: 0.3), value: course ?? 0)

                // Fixed index mark at the top.
                Path { p in
                    p.move(to: CGPoint(x: r, y: size * 0.03))
                    p.addLine(to: CGPoint(x: r - size * 0.05, y: size * 0.13))
                    p.addLine(to: CGPoint(x: r + size * 0.05, y: size * 0.13))
                    p.closeSubpath()
                }
                .fill(palette.accent)

                VStack(spacing: 1) {
                    Text(course.map { String(format: "%03d°", Int($0.rounded()) % 360) } ?? "---°")
                        .font(.system(size: size * 0.18, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(palette.text)
                    Text(isMagnetic ? "MAG" : "COG")
                        .font(.system(size: size * 0.085))
                        .foregroundStyle(palette.textDim)
                }
            }
            .frame(width: size, height: size)
        }
        .aspectRatio(1, contentMode: .fit)
    }
}
