import Foundation
import Combine

/// Saved trips. Persisted to UserDefaults, newest first, capped so it cannot grow
/// without bound. Mirrors `speedo/trips.js`.
final class TripLog: ObservableObject {

    private static let key = "boat-speedo.trips.v1"
    private static let maxTrips = 100

    /// Below this a "trip" is someone testing the app on the dock, not a passage.
    static let minLoggableMeters: Double = 100

    struct Entry: Codable, Identifiable, Equatable {
        let id: String
        let startedAt: Date?
        let endedAt: Date
        let distanceMeters: Double
        let maxSpeedMS: Double
        let movingSeconds: TimeInterval

        var distanceNM: Double { distanceMeters / Units.metersPerNauticalMile }
        var maxKnots: Double { maxSpeedMS * Units.knotsPerMS }
        var averageKnots: Double {
            movingSeconds > 0 ? (distanceMeters / movingSeconds) * Units.knotsPerMS : 0
        }
    }

    @Published private(set) var entries: [Entry] = []

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        load()
    }

    // MARK: - persistence

    private func load() {
        guard let data = defaults.data(forKey: Self.key),
              let decoded = try? JSONDecoder().decode([Entry].self, from: data)
        else { return }
        entries = decoded
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(Array(entries.prefix(Self.maxTrips))) else { return }
        defaults.set(data, forKey: Self.key)
    }

    // MARK: - mutation

    static func isLoggable(_ trip: TripStats) -> Bool {
        trip.distanceMeters >= minLoggableMeters
    }

    /// File a finished run. Returns nil when it was too short to be worth keeping.
    @discardableResult
    func add(_ trip: TripStats, startedAt: Date?, endedAt: Date = Date()) -> Entry? {
        guard Self.isLoggable(trip) else { return nil }
        let entry = Entry(
            id: "\(startedAt?.timeIntervalSince1970 ?? endedAt.timeIntervalSince1970)-"
              + "\(Int(trip.distanceMeters))",
            startedAt: startedAt,
            endedAt: endedAt,
            distanceMeters: trip.distanceMeters,
            maxSpeedMS: trip.maxSpeedMS,
            movingSeconds: trip.movingSeconds
        )
        entries.insert(entry, at: 0)
        persist()
        return entry
    }

    func remove(_ id: String) {
        entries.removeAll { $0.id == id }
        persist()
    }

    func clear() {
        entries.removeAll()
        persist()
    }

    // MARK: - totals and export

    var totalDistanceNM: Double {
        entries.reduce(0) { $0 + $1.distanceMeters } / Units.metersPerNauticalMile
    }
    var totalMovingSeconds: TimeInterval { entries.reduce(0) { $0 + $1.movingSeconds } }
    var bestKnots: Double { entries.map(\.maxKnots).max() ?? 0 }

    func csv() -> String {
        let iso = ISO8601DateFormatter()
        var rows = ["started,ended,distance_nm,duration_min,max_kn,avg_kn"]
        for e in entries {
            rows.append([
                e.startedAt.map { iso.string(from: $0) } ?? "",
                iso.string(from: e.endedAt),
                String(format: "%.2f", e.distanceNM),
                String(format: "%.1f", e.movingSeconds / 60),
                String(format: "%.1f", e.maxKnots),
                String(format: "%.1f", e.averageKnots)
            ].joined(separator: ","))
        }
        return rows.joined(separator: "\n") + "\n"
    }

    /// Writes the CSV to a temporary file for the iOS share sheet to pick up.
    func csvFileURL() -> URL? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("boat-speedo-trips.csv")
        do {
            try csv().write(to: url, atomically: true, encoding: .utf8)
            return url
        } catch {
            return nil
        }
    }
}
