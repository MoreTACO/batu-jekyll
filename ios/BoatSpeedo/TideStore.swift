import Foundation
import CoreLocation
import Combine

/// Tide predictions from NOAA CO-OPS.
///
/// Tides cannot be computed offline — prediction needs harmonic constants measured
/// at a specific station — so this fetches and caches aggressively. With no signal
/// you get the last download, labelled with its age; if that download does not
/// cover today, the UI refuses to draw rather than showing a wrong curve.
///
/// Mirrors `speedo/tides.js`. Note the native app has no CORS restriction, so
/// unlike the web version this is guaranteed to reach the API.
@MainActor
final class TideStore: ObservableObject {

    private static let bundleKey = "boat-speedo.tides.v1"
    private static let stationsKey = "boat-speedo.tideStations.v1"
    private static let pinnedKey = "boat-speedo.tideStation.v1"

    private static let stationsTTL: TimeInterval = 30 * 24 * 3600
    private static let refreshInterval: TimeInterval = 6 * 3600
    private static let host = "https://api.tidesandcurrents.noaa.gov"

    // MARK: - model

    struct Station: Codable, Identifiable, Equatable {
        let id: String
        let name: String
        let lat: Double
        let lon: Double
        var distanceMeters: Double?
    }

    struct Point: Codable, Equatable {
        let time: Date
        let feet: Double
        let type: String?          // "H", "L", or nil for a curve sample
    }

    struct Bundle: Codable, Equatable {
        let stationId: String
        let stationName: String
        let distanceMeters: Double?
        let fetchedAt: Date
        let hilo: [Point]
        let curve: [Point]
    }

    @Published private(set) var bundle: Bundle?
    @Published private(set) var nearby: [Station] = []
    @Published private(set) var isBusy = false
    @Published private(set) var errorText: String?

    private var stations: [Station] = []
    private var lastAttempt: Date?
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        bundle = Self.read(Bundle.self, from: defaults, key: Self.bundleKey)
        if let cached = Self.read(CachedStations.self, from: defaults, key: Self.stationsKey) {
            stations = cached.stations
        }
    }

    // MARK: - reading the cache

    /// True when the cached curve brackets the given moment. A curve that stops
    /// before now cannot be drawn honestly.
    func coversNow(_ now: Date = Date()) -> Bool {
        guard let b = bundle, let first = b.curve.first, let last = b.curve.last else { return false }
        return first.time <= now && last.time >= now
    }

    func height(at when: Date) -> Double? {
        guard let c = bundle?.curve, c.count >= 2,
              let first = c.first, let last = c.last,
              when >= first.time, when <= last.time else { return nil }
        for i in 1..<c.count where c[i].time >= when {
            let span = c[i].time.timeIntervalSince(c[i - 1].time)
            let f = span > 0 ? when.timeIntervalSince(c[i - 1].time) / span : 0
            return c[i - 1].feet + (c[i].feet - c[i - 1].feet) * f
        }
        return nil
    }

    func nextEvent(after when: Date = Date()) -> Point? {
        bundle?.hilo.first { $0.time > when }
    }

    /// Rising or falling, taken from the next extreme rather than the local slope —
    /// near slack water the slope is noise, but the next event is not.
    func isRising(at when: Date = Date()) -> Bool? {
        nextEvent(after: when).map { $0.type == "H" }
    }

    /// A 24-hour window with a little of the past for context and the rest ahead.
    func window(now: Date = Date()) -> [Point] {
        let from = now.addingTimeInterval(-6 * 3600)
        let to = now.addingTimeInterval(18 * 3600)
        return bundle?.curve.filter { $0.time >= from && $0.time <= to } ?? []
    }

    // MARK: - pinning

    var pinnedStationId: String? { defaults.string(forKey: Self.pinnedKey) }

    func pin(_ station: Station) {
        defaults.set(station.id, forKey: Self.pinnedKey)
    }

    func unpin() { defaults.removeObject(forKey: Self.pinnedKey) }

    // MARK: - fetching

    func refreshIfNeeded(near coordinate: CLLocationCoordinate2D, force: Bool = false) async {
        guard !isBusy else { return }

        if !force, let b = bundle,
           Date().timeIntervalSince(b.fetchedAt) < Self.refreshInterval,
           coversNow(),
           pinnedStationId == nil || pinnedStationId == b.stationId {
            return
        }
        // Do not hammer a failing network on every fix.
        if !force, let last = lastAttempt, Date().timeIntervalSince(last) < 60 { return }

        lastAttempt = Date()
        isBusy = true
        errorText = nil
        defer { isBusy = false }

        do {
            try await loadStations()
            nearby = Self.nearest(stations, to: coordinate, count: 8)

            let chosen: Station
            if let pinned = pinnedStationId, let match = stations.first(where: { $0.id == pinned }) {
                chosen = Self.withDistance(match, to: coordinate)
            } else if let pinned = pinnedStationId {
                chosen = Station(id: pinned, name: "Station \(pinned)", lat: 0, lon: 0, distanceMeters: nil)
            } else if let first = nearby.first {
                chosen = first
            } else {
                throw Failure.noStation
            }

            bundle = try await fetchPredictions(for: chosen)
            Self.write(bundle, to: defaults, key: Self.bundleKey)
        } catch {
            errorText = (error as? Failure)?.text ?? error.localizedDescription
        }
    }

    private func loadStations() async throws {
        if let cached = Self.read(CachedStations.self, from: defaults, key: Self.stationsKey),
           Date().timeIntervalSince(cached.fetchedAt) < Self.stationsTTL {
            stations = cached.stations
            return
        }
        guard let url = URL(string:
            "\(Self.host)/mdapi/prod/webapi/stations.json?type=tidepredictions&units=english")
        else { throw Failure.badURL }

        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let decoded = try JSONDecoder().decode(StationsResponse.self, from: data)
            stations = decoded.stations.map {
                Station(id: $0.id, name: $0.name, lat: $0.lat, lon: $0.lng, distanceMeters: nil)
            }
            guard !stations.isEmpty else { throw Failure.noStation }
            Self.write(CachedStations(fetchedAt: Date(), stations: stations),
                       to: defaults, key: Self.stationsKey)
        } catch {
            // A stale list is still perfectly usable; stations do not move.
            guard !stations.isEmpty else { throw error }
        }
    }

    private func fetchPredictions(for station: Station) async throws -> Bundle {
        let df = DateFormatter()
        df.dateFormat = "yyyyMMdd"
        let begin = df.string(from: Date().addingTimeInterval(-86400))
        let end = df.string(from: Date().addingTimeInterval(2 * 86400))

        func url(interval: String) -> URL? {
            URL(string: "\(Self.host)/api/prod/datagetter"
                + "?product=predictions&application=BoatSpeedo&format=json"
                + "&datum=MLLW&units=english&time_zone=lst_ldt"
                + "&station=\(station.id)&begin_date=\(begin)&end_date=\(end)"
                + "&interval=\(interval)")
        }
        guard let hiloURL = url(interval: "hilo"), let hourlyURL = url(interval: "h")
        else { throw Failure.badURL }

        async let hiloData = URLSession.shared.data(from: hiloURL)
        async let hourlyData = URLSession.shared.data(from: hourlyURL)
        let hilo = try Self.parse(try await hiloData.0)
        let hourly = try Self.parse(try await hourlyData.0)
        guard !hilo.isEmpty || !hourly.isEmpty else { throw Failure.noPredictions }

        // Merge so the drawn line passes through high and low water rather than
        // cutting the corners between hourly samples.
        var byTime: [Date: Point] = [:]
        for p in hourly + hilo { byTime[p.time] = p }

        return Bundle(
            stationId: station.id,
            stationName: station.name,
            distanceMeters: station.distanceMeters,
            fetchedAt: Date(),
            hilo: hilo.sorted { $0.time < $1.time },
            curve: byTime.values.sorted { $0.time < $1.time }
        )
    }

    // MARK: - parsing

    /// NOAA returns station local time as "yyyy-MM-dd HH:mm" with no zone. The boat
    /// and the station share a timezone in any realistic case, so it is read as local.
    private static func parse(_ data: Data) throws -> [Point] {
        if let err = try? JSONDecoder().decode(ErrorResponse.self, from: data), let m = err.error?.message {
            throw Failure.service(m)
        }
        let decoded = try JSONDecoder().decode(PredictionsResponse.self, from: data)
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd HH:mm"
        df.timeZone = .current

        return decoded.predictions.compactMap { raw in
            guard let t = df.date(from: raw.t), let v = Double(raw.v) else { return nil }
            return Point(time: t, feet: v, type: raw.type)
        }.sorted { $0.time < $1.time }
    }

    private static func withDistance(_ s: Station, to c: CLLocationCoordinate2D) -> Station {
        var copy = s
        copy.distanceMeters = CLLocation(latitude: c.latitude, longitude: c.longitude)
            .distance(from: CLLocation(latitude: s.lat, longitude: s.lon))
        return copy
    }

    /// The nearest station is often not the right one — it can be across a bridge or
    /// up a different creek — so several are offered and the user can pin one.
    private static func nearest(_ all: [Station],
                                to c: CLLocationCoordinate2D,
                                count: Int) -> [Station] {
        all.map { withDistance($0, to: c) }
           .sorted { ($0.distanceMeters ?? .infinity) < ($1.distanceMeters ?? .infinity) }
           .prefix(count)
           .map { $0 }
    }

    // MARK: - plumbing

    private struct CachedStations: Codable { let fetchedAt: Date; let stations: [Station] }
    private struct StationsResponse: Codable {
        struct Raw: Codable { let id: String; let name: String; let lat: Double; let lng: Double }
        let stations: [Raw]
    }
    private struct PredictionsResponse: Codable {
        struct Raw: Codable { let t: String; let v: String; let type: String? }
        let predictions: [Raw]
    }
    private struct ErrorResponse: Codable {
        struct Message: Codable { let message: String? }
        let error: Message?
    }

    enum Failure: Error {
        case badURL, noStation, noPredictions
        case service(String)

        var text: String {
            switch self {
            case .badURL: return "Could not build the tide request."
            case .noStation: return "No tide station found near you."
            case .noPredictions: return "The tide service returned no predictions."
            case .service(let m): return "Tide service: \(m)"
            }
        }
    }

    private static func read<T: Decodable>(_ type: T.Type,
                                           from defaults: UserDefaults,
                                           key: String) -> T? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private static func write<T: Encodable>(_ value: T?, to defaults: UserDefaults, key: String) {
        guard let value, let data = try? JSONEncoder().encode(value) else { return }
        defaults.set(data, forKey: key)
    }
}
