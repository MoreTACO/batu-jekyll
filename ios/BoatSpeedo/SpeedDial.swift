import SwiftUI

/// The speed gauge. The pointer rides on the rim rather than sweeping through the
/// middle, which leaves the whole interior free for the readout.
struct SpeedDial: View {

    let knots: Double
    let mph: Double
    let maxKnots: Double
    let overLimit: Bool
    let palette: Palette

    private let startAngle = 135.0
    private let sweep = 270.0

    private var fraction: Double { min(max(knots / maxKnots, 0), 1) }

    var body: some View {
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height)
            let center = CGPoint(x: size / 2, y: size / 2)
            let r = size / 2

            ZStack {
                Circle()
                    .fill(palette.panel)
                    .overlay(Circle().stroke(palette.trimDim, lineWidth: 2))

                arc(fraction: 1, r: r * 0.853, center: center)
                    .stroke(palette.line, style: .init(lineWidth: size * 0.027, lineCap: .round))

                arc(fraction: fraction, r: r * 0.853, center: center)
                    .stroke(overLimit ? palette.warn : palette.accent,
                            style: .init(lineWidth: size * 0.027, lineCap: .round))
                    .animation(.linear(duration: 0.28), value: fraction)

                ticks(size: size, center: center)

                pointer(size: size, center: center)
                    .fill(overLimit ? palette.warn : palette.accent)
                    .animation(.linear(duration: 0.28), value: fraction)

                readout(size: size)
            }
            .frame(width: size, height: size)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .aspectRatio(1, contentMode: .fit)
    }

    // MARK: - pieces

    private func arc(fraction: Double, r: CGFloat, center: CGPoint) -> Path {
        Path { p in
            p.addArc(center: center,
                     radius: r,
                     startAngle: .degrees(startAngle),
                     endAngle: .degrees(startAngle + sweep * fraction),
                     clockwise: false)
        }
    }

    private func ticks(size: CGFloat, center: CGPoint) -> some View {
        let step: Double = maxKnots <= 30 ? 5 : 10
        let majors = stride(from: 0.0, through: maxKnots, by: step).map { $0 }
        let minors = stride(from: 0.0, through: maxKnots, by: step / 5).map { $0 }
            .filter { ($0 / step).rounded() != ($0 / step) }

        return ZStack {
            ForEach(minors, id: \.self) { v in
                tick(value: v, from: 0.773, to: 0.727, size: size, center: center)
                    .stroke(palette.trimDim, lineWidth: 2)
            }
            ForEach(majors, id: \.self) { v in
                tick(value: v, from: 0.773, to: 0.693, size: size, center: center)
                    .stroke(palette.trim, lineWidth: 3)
                Text("\(Int(v))")
                    .font(.system(size: size * 0.045, weight: .regular))
                    .foregroundStyle(palette.textDim)
                    .position(point(value: v, radius: size * 0.30, center: center))
            }
        }
    }

    private func tick(value: Double, from: CGFloat, to: CGFloat,
                      size: CGFloat, center: CGPoint) -> Path {
        Path { p in
            p.move(to: point(value: value, radius: size * from / 2, center: center))
            p.addLine(to: point(value: value, radius: size * to / 2, center: center))
        }
    }

    private func pointer(size: CGFloat, center: CGPoint) -> Path {
        let angle = Angle.degrees(startAngle + sweep * fraction)
        let inner = size * 0.393
        let outer = size * 0.473
        let halfWidth = size * 0.012

        return Path { p in
            let cos = CoreGraphics.cos(angle.radians)
            let sin = CoreGraphics.sin(angle.radians)
            // Perpendicular offset, so the bar has thickness across the arc.
            let px = -sin * halfWidth
            let py =  cos * halfWidth

            p.move(to:    CGPoint(x: center.x + cos * inner + px, y: center.y + sin * inner + py))
            p.addLine(to: CGPoint(x: center.x + cos * outer + px, y: center.y + sin * outer + py))
            p.addLine(to: CGPoint(x: center.x + cos * outer - px, y: center.y + sin * outer - py))
            p.addLine(to: CGPoint(x: center.x + cos * inner - px, y: center.y + sin * inner - py))
            p.closeSubpath()
        }
    }

    private func readout(size: CGFloat) -> some View {
        VStack(spacing: size * 0.012) {
            HStack(alignment: .firstTextBaseline, spacing: size * 0.014) {
                Text(String(format: "%.1f", knots))
                    .font(.system(size: size * 0.20, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(palette.text)
                Text("kn")
                    .font(.system(size: size * 0.065, weight: .semibold))
                    .foregroundStyle(palette.trim)
            }
            Text(String(format: "%.1f mph", mph))
                .font(.system(size: size * 0.055))
                .monospacedDigit()
                .foregroundStyle(palette.textDim)
        }
    }

    private func point(value: Double, radius: CGFloat, center: CGPoint) -> CGPoint {
        let a = (startAngle + sweep * (value / maxKnots)) * .pi / 180
        return CGPoint(x: center.x + CoreGraphics.cos(a) * radius,
                       y: center.y + CoreGraphics.sin(a) * radius)
    }
}
