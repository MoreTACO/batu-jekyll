import CoreLocation
import Combine
import SwiftUI

/// Ties the raw fixes from `LocationManager` to the trip log and the two alarms.
/// The smoothing and fallback rules here are the same ones in `speedo/app.js`,
/// so both versions of the app show the same number on the same track.
final class SpeedoModel: ObservableObject {

    /// EMA weight on the newest fix. Low enough that the needle does not twitch
    /// at anchor, high enough to keep up with a boat coming onto plane.
    private static let speedAlpha = 0.3
    /// GPS course is meaningless below this, so hold the last good one instead.
    private static let courseMinKnots = 1.0
    /// After this long with no fix, show zero rather than a comforting stale number.
    private static let staleSeconds: TimeInterval = 8
    /// Stopped this long ends the trip by itself, whether or not anyone tapped.
    private static let autoSaveStopSeconds: TimeInterval = 20 * 60
    /// The sparkline covers this much history, sampled at this interval.
    static let sparkWindow: TimeInterval = 10 * 60
    static let sparkStep: TimeInterval = 2

    @Published private(set) var smoothedSpeedMS: CLLocationSpeed = 0
    @Published private(set) var courseDegrees: CLLocationDirection?
    @Published private(set) var courseIsMagnetic = false
    @Published private(set) var accuracy: CLLocationAccuracy?
    @Published private(set) var lastFixAt: Date?
    @Published var trip = TripStats()
    @Published private(set) var tripStartedAt: Date?
    @Published private(set) var spark: [(t: Date, ms: CLLocationSpeed)] = []

    @AppStorage("night") var night = false
    @AppStorage("autoNight") var autoNight = false {
        didSet { lastAutoDark = nil; applyAutoNight() }
    }

    let locations = LocationManager()
    let anchorWatch = AnchorWatch()
    let speedAlarm = SpeedAlarm()
    let tripLog = TripLog()
    let tides = TideStore()

    /// Sun times for the current position, recomputed as the day rolls over.
    var sunTimes: SunTimes.Result? {
        guard let fix = previousFix else { return nil }
        return SunTimes.times(latitude: fix.coordinate.latitude,
                              longitude: fix.coordinate.longitude)
    }

    private var previousFix: CLLocation?
    private var stoppedSince: Date?
    private var lastSparkAt: Date?
    private var lastAutoDark: Bool?
    private var bag = Set<AnyCancellable>()

    var knots: Double { displaySpeedMS * Units.knotsPerMS }
    var mph: Double { displaySpeedMS * Units.mphPerMS }

    var hasFreshFix: Bool {
        guard let lastFixAt else { return false }
        return Date().timeIntervalSince(lastFixAt) <= Self.staleSeconds
    }

    private var displaySpeedMS: CLLocationSpeed { hasFreshFix ? smoothedSpeedMS : 0 }

    init() {
        locations.$location
            .compactMap { $0 }
            .sink { [weak self] in self?.ingest($0) }
            .store(in: &bag)

        // The magnetometer is the only heading source that works at rest, so it
        // wins whenever it is available.
        locations.$heading
            .compactMap { $0 }
            .sink { [weak self] heading in
                self?.courseDegrees = heading
                self?.courseIsMagnetic = true
            }
            .store(in: &bag)

        // Nested ObservableObjects do not propagate to the view on their own, so
        // forward their changes up. Without this the drift bar and the armed state
        // only refresh on the next timer tick.
        anchorWatch.objectWillChange
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &bag)
        speedAlarm.objectWillChange
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &bag)
        tripLog.objectWillChange
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &bag)
        tides.objectWillChange
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &bag)

        // Keep the stale-fix handling and the fix-age readout honest between fixes.
        Timer.publish(every: 1, on: .main, in: .common)
            .autoconnect()
            .sink { [weak self] _ in
                guard let self else { return }
                self.speedAlarm.evaluate(knots: self.knots, hasFreshFix: self.hasFreshFix)
                self.pushSpark(self.displaySpeedMS)
                self.maybeAutoSave()
                self.applyAutoNight()
                self.refreshTides(force: false)
                self.objectWillChange.send()
            }
            .store(in: &bag)
    }

    func start() {
        locations.start()
    }

    private func ingest(_ fix: CLLocation) {
        accuracy = fix.horizontalAccuracy >= 0 ? fix.horizontalAccuracy : nil
        lastFixAt = Date()

        let usable = fix.horizontalAccuracy >= 0
            && fix.horizontalAccuracy <= TripStats.accuracyLimit

        // Prefer the chip's own speed. It reports a negative value when it cannot
        // measure one — typically at very low speed — so fall back to distance
        // over time, which is also what makes this testable without a boat.
        var rawSpeed: CLLocationSpeed
        if fix.speed >= 0 {
            rawSpeed = fix.speed
        } else if let previousFix, usable {
            let dt = fix.timestamp.timeIntervalSince(previousFix.timestamp)
            rawSpeed = dt > 0.2 ? fix.distance(from: previousFix) / dt : smoothedSpeedMS
        } else {
            rawSpeed = smoothedSpeedMS
        }

        smoothedSpeedMS += Self.speedAlpha * (rawSpeed - smoothedSpeedMS)
        if smoothedSpeedMS < 0.02 { smoothedSpeedMS = 0 }

        if usable {
            trip.ingest(fix, previous: previousFix, smoothedSpeedMS: smoothedSpeedMS)

            // A trip starts the first time the boat actually moves, not when the
            // app was opened, so the log shows time under way rather than time
            // sitting on the dock.
            if smoothedSpeedMS * Units.knotsPerMS >= TripStats.movingKnots {
                if tripStartedAt == nil { tripStartedAt = Date() }
                stoppedSince = nil
            } else if stoppedSince == nil {
                stoppedSince = Date()
            }

            if !courseIsMagnetic,
               fix.course >= 0,
               smoothedSpeedMS * Units.knotsPerMS >= Self.courseMinKnots {
                courseDegrees = fix.course
            }

            previousFix = fix
        }

        anchorWatch.evaluate(fix)
        speedAlarm.evaluate(knots: knots, hasFreshFix: true)
    }

    // MARK: - actions

    func dropOrWeighAnchor() {
        if anchorWatch.isSet {
            anchorWatch.weigh()
            locations.disableBackgroundUpdates()
        } else if let fix = previousFix {
            anchorWatch.drop(at: fix)
            // Only ask for background permission when there is a reason to.
            locations.enableBackgroundUpdates()
        }
    }

    /// File the current run and start a fresh one. Returns nil when the run was
    /// too short to be worth keeping.
    @discardableResult
    func endTrip() -> TripLog.Entry? {
        let saved = tripLog.add(trip, startedAt: tripStartedAt)
        trip.reset()
        tripStartedAt = nil
        stoppedSince = nil
        return saved
    }

    /// Safety net: a run stopped for twenty minutes is over, whether or not anyone
    /// remembered to tap END TRIP.
    private func maybeAutoSave() {
        guard TripLog.isLoggable(trip), let since = stoppedSince,
              Date().timeIntervalSince(since) >= Self.autoSaveStopSeconds
        else { return }
        endTrip()
    }

    // MARK: - sparkline

    private func pushSpark(_ ms: CLLocationSpeed) {
        let now = Date()
        if let last = lastSparkAt, now.timeIntervalSince(last) < Self.sparkStep { return }
        lastSparkAt = now
        spark.append((t: now, ms: ms))
        let cutoff = now.addingTimeInterval(-Self.sparkWindow)
        while let first = spark.first, first.t < cutoff { spark.removeFirst() }
    }

    // MARK: - night mode

    /// Flip the palette at sunrise and sunset. A manual tap wins until the next
    /// transition, rather than being undone a second later.
    private func applyAutoNight() {
        guard autoNight, let fix = previousFix else { return }
        let dark = SunTimes.isDark(latitude: fix.coordinate.latitude,
                                   longitude: fix.coordinate.longitude)
        guard dark != lastAutoDark else { return }
        lastAutoDark = dark
        if night != dark { night = dark }
    }

    // MARK: - tides

    func refreshTides(force: Bool) {
        guard let fix = previousFix else { return }
        Task { await tides.refreshIfNeeded(near: fix.coordinate, force: force) }
    }
}
