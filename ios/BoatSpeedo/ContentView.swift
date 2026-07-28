import SwiftUI

struct ContentView: View {

    @StateObject private var model = SpeedoModel()

    private var p: Palette { Palette.current(night: model.night) }

    /// Dial tops out at 30 kn, then rescales in 15 kn steps for faster boats.
    private var dialMax: Double {
        var m = 30.0
        while model.trip.maxKnots > m { m += 15 }
        return m
    }

    var body: some View {
        ZStack(alignment: .top) {
            p.bg.ignoresSafeArea()

            // Helm on the first page, passage detail on the second. The helm screen
            // stays glanceable at planing speed with nothing extra added to it.
            TabView {
                helmScreen
                PassageView(model: model)
            }
            .tabViewStyle(.page(indexDisplayMode: .always))
            .indexViewStyle(.page(backgroundDisplayMode: .interactive))

            if model.anchorWatch.isDragging || model.speedAlarm.isOverLimit {
                alarmBanner
            }
        }
        .preferredColorScheme(.dark)
        .statusBarHidden(false)
        .onAppear { model.start() }
    }

    private var helmScreen: some View {
        VStack(spacing: 9) {
            statusStrip
            SpeedDial(knots: model.knots,
                      mph: model.mph,
                      maxKnots: dialMax,
                      overLimit: model.speedAlarm.isOverLimit,
                      palette: p)
                .layoutPriority(1)
            SpeedSparkline(samples: model.spark, palette: p)
                .frame(height: 46)
            midRow
            anchorPanel
            noWakePanel
            toolsRow
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 14)
    }

    // MARK: - status

    private var statusStrip: some View {
        HStack {
            HStack(spacing: 5) {
                Circle().fill(fixColor).frame(width: 7, height: 7)
                Text(fixLabel)
            }
            Spacer()
            Text(model.accuracy.map { "±\(Int($0)) m" } ?? "± -- m")
            Spacer()
            Text(fixAge)
        }
        .font(.system(size: 11)).monospacedDigit()
        .kerning(1)
        .foregroundStyle(p.textDim)
        .padding(.bottom, 8)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(p.line), alignment: .bottom)
    }

    private var fixColor: Color {
        guard let a = model.accuracy else { return p.trimDim }
        if a <= 10 { return p.ok }
        return a <= TripStats.accuracyLimit ? p.trim : p.warn
    }

    private var fixLabel: String {
        guard let a = model.accuracy else { return "NO FIX" }
        return a <= TripStats.accuracyLimit ? "GPS FIX" : "WEAK FIX"
    }

    private var fixAge: String {
        guard let at = model.lastFixAt else { return "--" }
        return "\(min(999, Int(Date().timeIntervalSince(at))))s ago"
    }

    // MARK: - compass + trip

    private var midRow: some View {
        HStack(spacing: 12) {
            CompassRose(course: model.courseDegrees,
                        isMagnetic: model.courseIsMagnetic,
                        palette: p)
                .frame(width: 104, height: 104)

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 6) {
                cell(String(format: "%.2f", model.trip.distanceNM), "NM RUN")
                cell(String(format: "%.1f", model.trip.maxKnots), "MAX KN")
                cell(String(format: "%.1f", model.trip.averageKnots), "AVG KN")
                cell(Units.clock(model.trip.movingSeconds), "UNDERWAY")
            }
        }
    }

    private func cell(_ value: String, _ key: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.system(size: 20, weight: .bold)).monospacedDigit()
                .foregroundStyle(p.text)
            Text(key)
                .font(.system(size: 9)).kerning(1.1)
                .foregroundStyle(p.textDim)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 9).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 8).fill(p.panel))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(p.line, lineWidth: 1))
    }

    // MARK: - panels

    private var anchorPanel: some View {
        panel(title: "Anchor watch",
              state: anchorState,
              stateColor: model.anchorWatch.isDragging ? p.warn
                        : (model.anchorWatch.isSet ? p.ok : p.textDim),
              border: model.anchorWatch.isDragging ? p.warn
                    : (model.anchorWatch.isSet ? p.trim : p.line)) {

            slider(key: "Swing radius",
                   value: $model.anchorWatch.radiusMeters,
                   range: 10...120, step: 5,
                   label: "\(Int(model.anchorWatch.radiusMeters)) m")

            if let drift = model.anchorWatch.driftMeters {
                let pct = min(drift / model.anchorWatch.radiusMeters, 1)
                VStack(alignment: .leading, spacing: 4) {
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Capsule().fill(p.line)
                            Capsule()
                                .fill(pct >= 1 ? p.warn : (pct >= 0.7 ? p.trim : p.ok))
                                .frame(width: g.size.width * pct)
                        }
                    }
                    .frame(height: 5)
                    Text("Drift \(Int(drift)) m")
                        .font(.system(size: 11)).monospacedDigit()
                        .foregroundStyle(p.textDim)
                }
            }

            button(model.anchorWatch.isSet ? "WEIGH ANCHOR" : "DROP ANCHOR",
                   filled: !model.anchorWatch.isSet) {
                model.dropOrWeighAnchor()
            }
        }
    }

    private var anchorState: String {
        if model.anchorWatch.isDragging { return "DRAGGING" }
        return model.anchorWatch.isSet ? "WATCHING" : "OFF"
    }

    private var noWakePanel: some View {
        panel(title: "No-wake alarm",
              state: model.speedAlarm.isOverLimit ? "OVER LIMIT"
                   : (model.speedAlarm.isArmed ? "ARMED" : "OFF"),
              stateColor: model.speedAlarm.isOverLimit ? p.warn
                        : (model.speedAlarm.isArmed ? p.ok : p.textDim),
              border: model.speedAlarm.isOverLimit ? p.warn
                    : (model.speedAlarm.isArmed ? p.trim : p.line)) {

            slider(key: "Alert above",
                   value: $model.speedAlarm.limitKnots,
                   range: 1...40, step: 0.5,
                   label: String(format: "%.1f kn", model.speedAlarm.limitKnots))

            button(model.speedAlarm.isArmed ? "DISARM" : "ARM ALARM",
                   filled: !model.speedAlarm.isArmed) {
                model.speedAlarm.toggleArmed()
            }
        }
    }

    private func panel<Content: View>(title: String,
                                      state: String,
                                      stateColor: Color,
                                      border: Color,
                                      @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(p.text)
                Spacer()
                Text(state).font(.system(size: 10)).kerning(1.2).foregroundStyle(stateColor)
            }
            content()
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 10).fill(p.panel))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(border, lineWidth: 1))
    }

    private func slider(key: String, value: Binding<Double>,
                        range: ClosedRange<Double>, step: Double,
                        label: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(key).font(.system(size: 10)).kerning(1).foregroundStyle(p.textDim)
            HStack(spacing: 10) {
                Slider(value: value, in: range, step: step).tint(p.trim)
                Text(label)
                    .font(.system(size: 13, weight: .semibold)).monospacedDigit()
                    .foregroundStyle(p.trim)
                    .frame(width: 62, alignment: .trailing)
            }
        }
    }

    private func button(_ title: String, filled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: .bold)).kerning(1.4)
                // A big filled block is glare at night, so outline it instead.
                .foregroundStyle(filled && !model.night ? p.bg : p.trim)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(RoundedRectangle(cornerRadius: 8)
                    .fill(filled && !model.night ? p.trim : .clear))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(p.trim, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: - tools + alarm

    private var toolsRow: some View {
        HStack(spacing: 8) {
            ghost(model.night ? "DAY" : "NIGHT") { model.night.toggle() }
            ghost("END TRIP") { model.endTrip() }
        }
    }

    private func ghost(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11, weight: .bold)).kerning(1.2)
                .foregroundStyle(p.textDim)
                .frame(maxWidth: .infinity, minHeight: 44)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(p.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var alarmBanner: some View {
        HStack {
            Text(model.anchorWatch.isDragging
                 ? "ANCHOR DRAGGING"
                 : String(format: "OVER %.1f KN", model.speedAlarm.limitKnots))
                .font(.system(size: 15, weight: .heavy)).kerning(1)
            Spacer()
            Button("SILENCE") {
                model.anchorWatch.silence()
                model.speedAlarm.silence()
            }
            .font(.system(size: 12, weight: .heavy)).kerning(1.2)
            .foregroundStyle(.white)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(.white, lineWidth: 1))
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(p.warn)
    }

}

/// Ten minutes of speed history under the dial. Scaled to the samples it has, so
/// it spans the box from the first moments rather than being squashed against the
/// right-hand edge until the window fills.
struct SpeedSparkline: View {
    let samples: [(t: Date, ms: Double)]
    let palette: Palette

    /// Never scale below this, or a slow drift renders as dramatic mountains.
    private let floorKnots = 5.0

    var body: some View {
        VStack(spacing: 2) {
            GeometryReader { geo in
                let w = geo.size.width, h = geo.size.height

                if samples.count >= 2,
                   let tFrom = samples.first?.t, let tLast = samples.last?.t {
                    let span = max(tLast.timeIntervalSince(tFrom), 1)
                    let peak = max(floorKnots, (samples.map(\.ms).max() ?? 0) * Units.knotsPerMS)

                    let line = Path { path in
                        for (i, s) in samples.enumerated() {
                            let x = CGFloat(s.t.timeIntervalSince(tFrom) / span) * w
                            let y = h - CGFloat(s.ms * Units.knotsPerMS / peak) * (h - 2)
                            i == 0 ? path.move(to: CGPoint(x: x, y: y))
                                   : path.addLine(to: CGPoint(x: x, y: y))
                        }
                    }

                    ZStack {
                        var area = line
                        let _ = {
                            area.addLine(to: CGPoint(x: w, y: h))
                            area.addLine(to: CGPoint(x: 0, y: h))
                            area.closeSubpath()
                        }()
                        area.fill(palette.accent.opacity(0.13))
                        line.strokedPath(.init(lineWidth: 1.6, lineJoin: .round))
                            .foregroundStyle(palette.accent)
                    }
                }
            }

            HStack {
                Text(spanLabel)
                Spacer()
                Text(String(format: "%.1f kn peak",
                            (samples.map(\.ms).max() ?? 0) * Units.knotsPerMS))
            }
            .font(.system(size: 9)).kerning(0.9).monospacedDigit()
            .foregroundStyle(palette.textDim)
        }
    }

    private var spanLabel: String {
        guard let first = samples.first?.t, let last = samples.last?.t else { return "last 10 min" }
        let s = last.timeIntervalSince(first)
        return s >= 60 ? "last \(Int((s / 60).rounded())) min" : "last \(Int(s.rounded())) s"
    }
}

#Preview {
    ContentView()
}
