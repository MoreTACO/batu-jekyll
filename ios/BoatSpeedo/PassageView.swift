import SwiftUI

/// Second screen: tides, sun times and the saved trip log. Kept off the helm
/// screen so that one stays glanceable at planing speed.
struct PassageView: View {

    @ObservedObject var model: SpeedoModel
    private var p: Palette { Palette.current(night: model.night) }

    @State private var showStationPicker = false
    @State private var confirmClear = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("PASSAGE")
                    .font(.system(size: 15, weight: .bold)).kerning(2)
                    .foregroundStyle(p.trim)
                    .padding(.bottom, 8)
                    .overlay(Rectangle().frame(height: 1).foregroundStyle(p.line),
                             alignment: .bottom)

                tideCard
                sunCard
                logCard

                Text("Tides are predictions, not observations: actual water level "
                   + "varies with wind and barometric pressure.")
                    .font(.system(size: 10))
                    .foregroundStyle(p.textDim)
                    .padding(.top, 8)
                    .overlay(Rectangle().frame(height: 1).foregroundStyle(p.line),
                             alignment: .top)
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 20)
        }
        .background(p.bg)
    }

    // MARK: - tide

    private var tideCard: some View {
        card(title: "Tide", state: tideState, stateColor: tideStateColor) {
            HStack(alignment: .firstTextBaseline) {
                Text(model.tides.bundle?.stationName ?? "No station yet")
                    .font(.system(size: 11)).foregroundStyle(p.textDim)
                Spacer()
                Button(showStationPicker ? "done" : "change") { showStationPicker.toggle() }
                    .font(.system(size: 11)).foregroundStyle(p.trim)
            }

            if model.tides.coversNow(), let height = model.tides.height(at: Date()) {
                HStack(spacing: 14) {
                    HStack(alignment: .firstTextBaseline, spacing: 3) {
                        Text(String(format: "%.1f", height))
                            .font(.system(size: 38, weight: .bold)).monospacedDigit()
                            .foregroundStyle(p.text)
                        Text("ft").font(.system(size: 13)).foregroundStyle(p.trim)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.tides.isRising() == true ? "Rising" : "Falling")
                            .font(.system(size: 12)).foregroundStyle(p.textDim)
                        if let next = model.tides.nextEvent() {
                            Text("\(next.type == "H" ? "High" : "Low") "
                               + String(format: "%.1f", next.feet) + " ft at "
                               + SunTimes.clock(next.time))
                                .font(.system(size: 12)).monospacedDigit()
                                .foregroundStyle(p.textDim)
                        }
                    }
                }

                TideGraph(points: model.tides.window(),
                          extremes: model.tides.bundle?.hilo ?? [],
                          now: Date(),
                          palette: p)
                    .frame(height: 108)

                ForEach(upcoming, id: \.time) { e in
                    HStack {
                        Text("\(e.type == "H" ? "High" : "Low") \(SunTimes.clock(e.time))")
                            .foregroundStyle(e.type == "H" ? p.trim : p.textDim)
                        Spacer()
                        Text(String(format: "%.1f ft", e.feet)).foregroundStyle(p.textDim)
                    }
                    .font(.system(size: 11)).monospacedDigit()
                }
            } else {
                Text(tideNote)
                    .font(.system(size: 10))
                    .foregroundStyle(model.tides.errorText != nil ? p.warn : p.textDim)
            }

            if showStationPicker {
                VStack(alignment: .leading, spacing: 4) {
                    Text("NEAREST STATIONS")
                        .font(.system(size: 10)).kerning(1.1).foregroundStyle(p.textDim)
                    ForEach(model.tides.nearby) { s in
                        Button {
                            model.tides.pin(s)
                            showStationPicker = false
                            model.refreshTides(force: true)
                        } label: {
                            HStack {
                                Text(s.name).foregroundStyle(p.text)
                                Spacer()
                                Text(String(format: "%.1f NM",
                                            (s.distanceMeters ?? 0) / Units.metersPerNauticalMile))
                                    .foregroundStyle(p.textDim).monospacedDigit()
                            }
                            .font(.system(size: 12))
                            .padding(9)
                            .frame(maxWidth: .infinity)
                            .overlay(RoundedRectangle(cornerRadius: 7)
                                .stroke(s.id == model.tides.pinnedStationId ? p.trim : p.line,
                                        lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            Button("REFRESH TIDES") { model.refreshTides(force: true) }
                .font(.system(size: 11, weight: .bold)).kerning(1.2)
                .foregroundStyle(p.textDim)
                .frame(maxWidth: .infinity, minHeight: 44)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(p.line, lineWidth: 1))
        }
    }

    private var upcoming: [TideStore.Point] {
        (model.tides.bundle?.hilo ?? [])
            .filter { $0.time > Date().addingTimeInterval(-3600) }
            .prefix(4).map { $0 }
    }

    private var tideState: String {
        if model.tides.isBusy { return "FETCHING…" }
        if model.tides.bundle == nil { return "NO DATA" }
        if !model.tides.coversNow() { return "OUT OF DATE" }
        let age = Date().timeIntervalSince(model.tides.bundle!.fetchedAt)
        return age < 3600 ? "UP TO DATE" : "CACHED"
    }

    private var tideStateColor: Color {
        switch tideState {
        case "NO DATA", "OUT OF DATE": return p.warn
        case "UP TO DATE": return p.ok
        default: return p.textDim
        }
    }

    private var tideNote: String {
        if let err = model.tides.errorText { return err }
        if model.tides.bundle == nil {
            return "Tides cannot be computed offline. Connect once with a signal and "
                 + "the predictions are cached for several days."
        }
        return "The cached predictions do not cover right now, so no graph is drawn — "
             + "a stale tide curve is worse than none. Connect and refresh."
    }

    // MARK: - sun

    private var sunCard: some View {
        let t = model.sunTimes
        return card(title: "Sun", state: sunState, stateColor: p.textDim) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 6) {
                sunCell(SunTimes.clock(t?.sunrise), "SUNRISE")
                sunCell(SunTimes.clock(t?.sunset), "SUNSET")
                sunCell(dayLengthText, "DAYLIGHT")
                sunCell(SunTimes.clock(t?.civilDawn), "CIVIL DAWN")
                sunCell(SunTimes.clock(t?.civilDusk), "CIVIL DUSK")
                sunCell(SunTimes.clock(t?.solarNoon), "SOLAR NOON")
            }
            Toggle(isOn: $model.autoNight) {
                Text("Switch to night mode automatically at sunset")
                    .font(.system(size: 11)).foregroundStyle(p.textDim)
            }
            .tint(p.trim)
        }
    }

    private var sunState: String {
        guard let t = model.sunTimes else { return "NEEDS A FIX" }
        if t.polar == .day { return "MIDNIGHT SUN" }
        if t.polar == .night { return "POLAR NIGHT" }
        return "LOCAL TIME"
    }

    private var dayLengthText: String {
        guard let t = model.sunTimes else { return "--" }
        if t.polar == .day { return "24h" }
        if t.polar == .night { return "0h" }
        return SunTimes.duration(t.dayLength)
    }

    private func sunCell(_ value: String, _ key: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.system(size: 17, weight: .bold)).monospacedDigit()
                .foregroundStyle(p.text)
            Text(key).font(.system(size: 8)).kerning(1).foregroundStyle(p.textDim)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8).padding(.vertical, 7)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(p.line, lineWidth: 1))
    }

    // MARK: - trip log

    private var logCard: some View {
        card(title: "Trip log",
             state: model.tripLog.entries.isEmpty
                ? "NO TRIPS"
                : "\(model.tripLog.entries.count) TRIP\(model.tripLog.entries.count == 1 ? "" : "S")",
             stateColor: p.textDim) {

            ForEach(model.tripLog.entries) { e in
                HStack(spacing: 9) {
                    Text(shortDate(e.startedAt ?? e.endedAt))
                        .font(.system(size: 11)).foregroundStyle(p.textDim)
                        .frame(width: 66, alignment: .leading)
                    Text(String(format: "%.2f NM · %@ · %.1f avg · %.1f max",
                                e.distanceNM, duration(e.movingSeconds),
                                e.averageKnots, e.maxKnots))
                        .font(.system(size: 11)).monospacedDigit()
                        .foregroundStyle(p.text)
                    Spacer()
                    Button { model.tripLog.remove(e.id) } label: {
                        Image(systemName: "xmark").font(.system(size: 11))
                    }
                    .foregroundStyle(p.textDim)
                }
                .padding(.horizontal, 9).padding(.vertical, 8)
                .overlay(RoundedRectangle(cornerRadius: 7).stroke(p.line, lineWidth: 1))
            }

            if !model.tripLog.entries.isEmpty {
                Text(String(format: "%d trips · %.2f NM · %@ under way · %.1f kn best",
                            model.tripLog.entries.count,
                            model.tripLog.totalDistanceNM,
                            duration(model.tripLog.totalMovingSeconds),
                            model.tripLog.bestKnots))
                    .font(.system(size: 11)).monospacedDigit()
                    .foregroundStyle(p.textDim)

                HStack(spacing: 8) {
                    if let url = model.tripLog.csvFileURL() {
                        ShareLink(item: url) {
                            ghostLabel("EXPORT CSV")
                        }
                    }
                    Button {
                        // Two taps to wipe the log — one stray touch should not
                        // delete a season.
                        if confirmClear { model.tripLog.clear(); confirmClear = false }
                        else { confirmClear = true }
                    } label: {
                        ghostLabel(confirmClear ? "TAP AGAIN" : "CLEAR LOG")
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func ghostLabel(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11, weight: .bold)).kerning(1.2)
            .foregroundStyle(p.textDim)
            .frame(maxWidth: .infinity, minHeight: 44)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(p.line, lineWidth: 1))
    }

    private func shortDate(_ d: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "MMM d HH:mm"
        return f.string(from: d)
    }

    private func duration(_ s: TimeInterval) -> String {
        let m = Int(s / 60)
        return m >= 60 ? "\(m / 60)h \(String(format: "%02d", m % 60))m" : "\(m)m"
    }

    // MARK: - shell

    private func card<Content: View>(title: String,
                                     state: String,
                                     stateColor: Color,
                                     @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(p.text)
                Spacer()
                Text(state).font(.system(size: 10)).kerning(1.2).foregroundStyle(stateColor)
            }
            content()
        }
        .padding(.horizontal, 12).padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(p.panel))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(p.line, lineWidth: 1))
    }
}

/// The tide curve. Scaled to the points it has so it always spans the box —
/// hourly data rarely starts exactly on the window edge, and a curve stopping
/// short looks like missing data rather than a rounding detail.
struct TideGraph: View {
    let points: [TideStore.Point]
    let extremes: [TideStore.Point]
    let now: Date
    let palette: Palette

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height, pad: CGFloat = 6

            if points.count >= 2,
               let tFrom = points.first?.time, let tTo = points.last?.time,
               tTo > tFrom {

                let vMin = points.map(\.feet).min() ?? 0
                let vMaxRaw = points.map(\.feet).max() ?? 1
                let vMax = (vMaxRaw - vMin) < 0.1 ? vMin + 0.1 : vMaxRaw

                let x: (Date) -> CGFloat = { t in
                    CGFloat(t.timeIntervalSince(tFrom) / tTo.timeIntervalSince(tFrom)) * w
                }
                let y: (Double) -> CGFloat = { v in
                    pad + (1 - CGFloat((v - vMin) / (vMax - vMin))) * (h - pad * 2)
                }

                let line = Path { path in
                    for (i, p) in points.enumerated() {
                        let pt = CGPoint(x: x(p.time), y: y(p.feet))
                        i == 0 ? path.move(to: pt) : path.addLine(to: pt)
                    }
                }

                ZStack {
                    line.strokedPath(.init(lineWidth: 1.8, lineJoin: .round))
                        .foregroundStyle(palette.accent)

                    var area = line
                    let _ = {
                        area.addLine(to: CGPoint(x: x(points.last!.time), y: h))
                        area.addLine(to: CGPoint(x: x(points.first!.time), y: h))
                        area.closeSubpath()
                    }()
                    area.fill(palette.accent.opacity(0.14))

                    Path { p in
                        p.move(to: CGPoint(x: x(now), y: 0))
                        p.addLine(to: CGPoint(x: x(now), y: h))
                    }
                    .stroke(palette.trim, style: .init(lineWidth: 1, dash: [3, 3]))

                    ForEach(extremes.filter { $0.time >= tFrom && $0.time <= tTo }, id: \.time) { e in
                        Path { p in
                            let px = x(e.time), py = y(e.feet)
                            p.move(to: CGPoint(x: px, y: py))
                            p.addLine(to: CGPoint(x: px, y: py + (e.type == "H" ? -7 : 7)))
                        }
                        .stroke(palette.trim, lineWidth: 1.5)
                    }
                }
            }
        }
    }
}
