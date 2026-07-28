import CoreLocation

/// Running trip log. Pure value type so it can be unit-tested without CoreLocation
/// running. Same filtering rules as the web version in `speedo/app.js`.
struct TripStats: Codable, Equatable {

    /// Fixes worse than this never touch the log — a 60 m fix would invent distance.
    static let accuracyLimit: CLLocationAccuracy = 25
    /// Below this a "movement" is GPS jitter, not the boat going anywhere.
    static let minStepMeters: CLLocationDistance = 3
    /// Under way threshold, in knots, for the average-speed clock.
    static let movingKnots = 0.5
    /// Gaps longer than this are a suspended app, not time spent under way.
    static let maxGapSeconds: TimeInterval = 60

    var distanceMeters: CLLocationDistance = 0
    var maxSpeedMS: CLLocationSpeed = 0
    var movingSeconds: TimeInterval = 0

    var distanceNM: Double { distanceMeters / Units.metersPerNauticalMile }
    var maxKnots: Double { maxSpeedMS * Units.knotsPerMS }

    /// Average speed while actually under way, which is more useful on a boat than
    /// an average that counts the hour you spent rafted up at lunch.
    var averageMS: CLLocationSpeed {
        movingSeconds > 0 ? distanceMeters / movingSeconds : 0
    }
    var averageKnots: Double { averageMS * Units.knotsPerMS }

    /// Fold one new fix in. `previous` is the last fix that passed the accuracy gate.
    /// Returns the step distance in metres, or nil if this fix was rejected.
    @discardableResult
    mutating func ingest(_ fix: CLLocation,
                         previous: CLLocation?,
                         smoothedSpeedMS: CLLocationSpeed) -> CLLocationDistance? {

        guard fix.horizontalAccuracy >= 0,
              fix.horizontalAccuracy <= Self.accuracyLimit,
              let previous else { return nil }

        let dt = fix.timestamp.timeIntervalSince(previous.timestamp)
        guard dt > 0.2, dt < Self.maxGapSeconds else { return nil }

        let step = fix.distance(from: previous)
        let floor = max(Self.minStepMeters, fix.horizontalAccuracy * 0.5)

        var counted: CLLocationDistance?
        if step >= floor {
            distanceMeters += step
            counted = step
        }

        if smoothedSpeedMS * Units.knotsPerMS >= Self.movingKnots {
            movingSeconds += dt
        }
        maxSpeedMS = max(maxSpeedMS, smoothedSpeedMS)

        return counted
    }

    mutating func reset() {
        distanceMeters = 0
        maxSpeedMS = 0
        movingSeconds = 0
    }
}

enum Units {
    static let knotsPerMS = 1.9438445
    static let mphPerMS = 2.2369363
    static let metersPerNauticalMile = 1852.0

    static func clock(_ seconds: TimeInterval) -> String {
        let s = Int(seconds)
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0
            ? String(format: "%d:%02d:%02d", h, m, sec)
            : String(format: "%d:%02d", m, sec)
    }
}
